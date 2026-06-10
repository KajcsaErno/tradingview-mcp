/**
 * Offline unit tests for src/core/stream.js.
 *
 * stream.js does NOT take the `_deps` DI hook — it imports evaluate from
 * connection.js directly, and every export is an unbounded poll-and-diff loop
 * (pollLoop) that writes JSONL to stdout until SIGINT/SIGTERM. To test it
 * offline without touching the source:
 *  - connection.js is substituted with module-customization hooks
 *    (node:module registerHooks — synchronous, no flags) so evaluate() is a
 *    controllable fake (no CDP, no network);
 *  - process.stdout/stderr writes are captured by patching .write for the
 *    duration of each run (restored in finally), so the TAP stream stays
 *    clean and the emitted JSONL can be asserted on;
 *  - loops are stopped deterministically by process.emit('SIGINT') —
 *    pollLoop's documented stop signal (the runner child has no other SIGINT
 *    listeners, so nothing else reacts); every run is bounded by a deadline.
 *
 * Covered: pollLoop mechanics (JSONL shape, dedupe, null-skip, error
 * recovery, listener cleanup, header/footer) via streamQuote, plus each
 * exported stream's fetcher expression + label (streamBars, streamValues,
 * streamLines, streamLabels, streamTables, streamAllPanes) and the
 * JSON.stringify embedding of the user-supplied study filter (injection
 * safety). NOT covered: the CDP/ECONNREFUSED retry branch — it hard-codes a
 * 2000ms sleep, which would break the no-long-sleeps rule.
 *
 * Run: node --test tests/stream.test.js
 */
import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';

// Controllable double, reachable from the mock module source via globalThis.
const conn = {evaluate: async () => null};
globalThis.__streamTestConn = conn;

registerHooks({
    resolve(specifier, context, nextResolve) {
        const r = nextResolve(specifier, context);
        if (r.url && r.url.endsWith('/src/connection.js')) {
            return {url: 'mock:connection', format: 'module', shortCircuit: true};
        }
        return r;
    },
    load(url, context, nextLoad) {
        if (url === 'mock:connection') {
            return {
                format: 'module',
                shortCircuit: true,
                source: `
          const m = globalThis.__streamTestConn;
          export const evaluate = (...a) => m.evaluate(...a);
          export const evaluateAsync = (...a) => m.evaluate(...a);
          export const getClient = async () => ({});
          export const getTargetInfo = async () => ({});
          export const safeString = (s) => JSON.stringify(String(s));
          export const requireFinite = (n) => n;
          export const KNOWN_PATHS = {};
        `,
            };
        }
        return nextLoad(url, context);
    },
});

const {
    streamQuote, streamBars, streamValues, streamLines, streamLabels, streamTables, streamAllPanes,
} = await import('../src/core/stream.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OPTS = {timeout: 8000}; // hang guard; runs normally finish in <100ms

/**
 * Runs one stream until `untilLines` JSONL lines (and `untilCalls` fetches)
 * are observed or the deadline passes, then stops it via SIGINT.
 * `evaluate(expr, nthCall)` is the fake fetch result.
 */
async function runStream(start, {evaluate, untilLines = 1, untilCalls = 0, maxWaitMs = 2000} = {}) {
    const out = [];
    const errOut = [];
    let calls = 0;
    conn.evaluate = async (expr) => {
        calls += 1;
        return evaluate(expr, calls);
    };
    const realStdout = process.stdout.write;
    const realStderr = process.stderr.write;
    // pollLoop writes plain strings; the node --test child reports results over
    // stdout as Buffers — capture only the former, pass everything else through
    // so the runner protocol survives.
    process.stdout.write = (chunk, ...rest) => {
        if (typeof chunk === 'string') {
            out.push(chunk);
            return true;
        }
        return realStdout.call(process.stdout, chunk, ...rest);
    };
    process.stderr.write = (chunk, ...rest) => {
        if (typeof chunk === 'string') {
            errOut.push(chunk);
            return true;
        }
        return realStderr.call(process.stderr, chunk, ...rest);
    };
    try {
        const done = start();
        const deadline = Date.now() + maxWaitMs;
        while (Date.now() < deadline && (out.length < untilLines || calls < untilCalls)) await sleep(10);
        process.emit('SIGINT');
        await done;
    } finally {
        process.stdout.write = realStdout;
        process.stderr.write = realStderr;
    }
    return {
        lines: out.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l)),
        stderr: errOut.join(''),
        calls,
    };
}

// ── pollLoop mechanics (via streamQuote) ─────────────────────────────────────

describe('stream.js — pollLoop mechanics (via streamQuote)', () => {
    it('emits JSONL with _ts/_stream, prints header/footer, stops on SIGINT', OPTS, async () => {
        const {lines, stderr} = await runStream(() => streamQuote({interval: 5}), {
            evaluate: () => ({symbol: 'BTCUSD', close: 100}),
        });
        assert.ok(lines.length >= 1, 'at least one line emitted');
        assert.equal(lines[0].symbol, 'BTCUSD');
        assert.equal(lines[0].close, 100);
        assert.equal(lines[0]._stream, 'quote');
        assert.equal(typeof lines[0]._ts, 'number');
        assert.match(stderr, /Unofficial tool/, 'compliance notice goes to stderr');
        assert.match(stderr, /\[stream:quote\] started, interval=5ms/);
        assert.match(stderr, /\[stream:quote\] stopped after/);
        assert.equal(process.listenerCount('SIGINT'), 0, 'SIGINT handler removed after stop');
        assert.equal(process.listenerCount('SIGTERM'), 0, 'SIGTERM handler removed after stop');
    });

    it('dedupes identical payloads and emits again only on change', OPTS, async () => {
        const {lines, calls} = await runStream(() => streamQuote({interval: 5}), {
            evaluate: (_expr, n) => (n <= 3 ? {symbol: 'X', close: 1} : {symbol: 'X', close: 2}),
            untilLines: 2,
            untilCalls: 5,
        });
        assert.equal(lines.length, 2, 'three identical polls collapse into one line');
        assert.equal(lines[0].close, 1);
        assert.equal(lines[1].close, 2);
        assert.ok(calls >= 5, 'kept polling while deduping');
    });

    it('skips null fetch results without emitting', OPTS, async () => {
        const {lines, calls} = await runStream(() => streamQuote({interval: 5}), {
            evaluate: (_expr, n) => (n <= 2 ? null : {symbol: 'X', close: 7}),
            untilCalls: 3,
        });
        assert.equal(lines.length, 1, 'null polls emit nothing');
        assert.equal(lines[0].close, 7);
        assert.ok(calls >= 3, 'loop continued through null results');
    });

    it('reports non-connection fetch errors to stderr and keeps polling', OPTS, async () => {
        const {lines, stderr} = await runStream(() => streamQuote({interval: 5}), {
            evaluate: (_expr, n) => {
                if (n === 1) throw new Error('boom'); // must not match /CDP|ECONNREFUSED/
                return {symbol: 'X', close: 9};
            },
        });
        assert.match(stderr, /\[stream:quote\] error: boom/);
        assert.ok(lines.length >= 1, 'recovered and emitted after the error');
        assert.equal(lines[0].close, 9);
    });
});

// ── per-stream fetchers and labels ───────────────────────────────────────────

describe('stream.js — per-stream fetchers and labels', () => {
    it('streamBars reads the last bar and labels the stream "bars"', OPTS, async () => {
        let captured = '';
        const {lines, stderr} = await runStream(() => streamBars({interval: 5}), {
            evaluate: (expr) => {
                captured = expr;
                return {symbol: 'ES1!', bar_index: 42};
            },
        });
        assert.equal(lines[0]._stream, 'bars');
        assert.equal(lines[0].bar_index, 42);
        assert.ok(captured.includes('bar_index'));
        assert.ok(captured.includes('lastIndex()'));
        assert.match(stderr, /\[stream:bars\] started/);
    });

    it('streamValues scans visible studies and labels the stream "values"', OPTS, async () => {
        let captured = '';
        const {lines} = await runStream(() => streamValues({interval: 5}), {
            evaluate: (expr) => {
                captured = expr;
                return {symbol: 'X', study_count: 1, studies: [{name: 'RSI', values: {plot_0: 55}}]};
            },
        });
        assert.equal(lines[0]._stream, 'values');
        assert.equal(lines[0].studies[0].values.plot_0, 55);
        assert.ok(captured.includes('getAllStudies'));
        assert.ok(captured.includes('_lastBarValues'));
    });

    it('streamLines without a filter embeds null and reads dwglines', OPTS, async () => {
        let captured = '';
        const {lines} = await runStream(() => streamLines({interval: 5}), {
            evaluate: (expr) => {
                captured = expr;
                return {symbol: 'X', study_count: 1, studies: [{study: 'Profiler', levels: [101, 99]}]};
            },
        });
        assert.equal(lines[0]._stream, 'lines');
        assert.deepEqual(lines[0].studies[0].levels, [101, 99]);
        assert.ok(captured.includes('var filter = null'));
        assert.ok(captured.includes('dwglines'));
    });

    it('streamLines embeds the study filter via JSON.stringify (injection safety)', OPTS, async () => {
        let captured = '';
        const evil = 'Pro"filer"); doEvil(); ("';
        await runStream(() => streamLines({interval: 5, filter: evil}), {
            evaluate: (expr) => {
                captured = expr;
                return {symbol: 'X', study_count: 0, studies: []};
            },
        });
        assert.ok(captured.includes(JSON.stringify(evil)), 'filter must be embedded JSON-escaped');
        assert.ok(!captured.includes(evil), 'the raw unescaped payload must not appear in the expression');
    });

    it('streamLabels embeds the filter and reads dwglabels with label "labels"', OPTS, async () => {
        let captured = '';
        const {lines} = await runStream(() => streamLabels({interval: 5, filter: 'Profiler'}), {
            evaluate: (expr) => {
                captured = expr;
                return {symbol: 'X', study_count: 1, studies: [{study: 'Profiler', labels: [{text: 'PDH', price: 24550}]}]};
            },
        });
        assert.equal(lines[0]._stream, 'labels');
        assert.equal(lines[0].studies[0].labels[0].text, 'PDH');
        assert.ok(captured.includes('var filter = "Profiler"'));
        assert.ok(captured.includes('dwglabels'));
    });

    it('streamTables reads ownFirstValue with label "tables"', OPTS, async () => {
        let captured = '';
        const {lines} = await runStream(() => streamTables({interval: 5}), {
            evaluate: (expr) => {
                captured = expr;
                return {symbol: 'X', study_count: 1, studies: [{study: 'Stats', tables: [{rows: [['a', 'b']]}]}]};
            },
        });
        assert.equal(lines[0]._stream, 'tables');
        assert.deepEqual(lines[0].studies[0].tables[0].rows, [['a', 'b']]);
        assert.ok(captured.includes('ownFirstValue'));
    });

    it('streamAllPanes reads the chart widget collection with label "all-panes"', OPTS, async () => {
        let captured = '';
        const {lines} = await runStream(() => streamAllPanes({interval: 5}), {
            evaluate: (expr) => {
                captured = expr;
                return {layout: '2h', pane_count: 2, panes: [{index: 0, symbol: 'ES1!'}, {index: 1, symbol: 'NQ1!'}]};
            },
        });
        assert.equal(lines[0]._stream, 'all-panes');
        assert.equal(lines[0].pane_count, 2);
        assert.equal(lines[0].panes[1].symbol, 'NQ1!');
        assert.ok(captured.includes('_chartWidgetCollection'));
    });
});
