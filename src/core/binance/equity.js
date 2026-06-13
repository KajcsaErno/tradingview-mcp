// Binance core — equity-curve persistence. Closes the expectancy feedback loop:
// simulateEquity/estimateLosingStreak say what drawdown to EXPECT, this records what
// actually HAPPENED so the two can be compared. One compact JSONL line per sample
// (appended by `tv binance equity-log`, typically on a schedule), plus a pure analyzer
// over the recorded series. The only binance submodule that touches the filesystem —
// `_deps.appendFile`/`_deps.readFile`/`_deps.mkdir` are injectable for tests.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {appendFile as fsAppendFile, mkdir as fsMkdir, readFile as fsReadFile} from 'node:fs/promises';
import {getAccountSummary} from './account.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../');
const DEFAULT_LOG = 'strategies/equity-log.jsonl';

const resolveLogPath = (file) => {
    const f = file || DEFAULT_LOG;
    return path.isAbsolute(f) ? f : path.join(PROJECT_ROOT, f);
};

const csvList = (v) => (Array.isArray(v) ? v : String(v ?? '1').split(',')).map((s) => String(s).trim()).filter(Boolean);

/** One equity sample across accounts: per-account margin balance (= equity incl. unrealized
 *  PnL), wallet balance and uPnL, plus the cross-account total. Per-account errors are inline
 *  so one bad key doesn't lose the sample for the rest. */
export async function buildEquityLogEntry({market = 'futures', accounts = ['1'], _deps = {}} = {}) {
    const now = _deps.now || Date.now;
    const ids = csvList(accounts);
    if (!ids.length) throw new Error('accounts is required (array or CSV, e.g. "1,2")');
    const rows = await Promise.all(ids.map(async (account) => {
        try {
            const s = await getAccountSummary({market, account, _deps});
            return {
                account,
                equity: Number(Number(s.totalMarginBalance).toFixed(2)),
                wallet: Number(Number(s.totalWalletBalance).toFixed(2)),
                uPnl: Number(Number(s.totalUnrealizedPnl).toFixed(2)),
            };
        } catch (err) {
            return {account, error: err.message};
        }
    }));
    const ok = rows.filter((r) => r.error === undefined);
    if (!ok.length) throw new Error(`equity sample failed for every account: ${rows.map((r) => r.error).join(' | ')}`);
    const time = now();
    return {
        success: true, market, time, iso: new Date(time).toISOString(),
        totalEquity: Number(ok.reduce((s, r) => s + r.equity, 0).toFixed(2)),
        accounts: rows,
    };
}

/** Build one equity sample and append it as a JSONL line (default strategies/equity-log.jsonl).
 *  Run on a schedule (daily or per-session) to accumulate the actual equity curve. */
export async function appendEquityLog({market = 'futures', accounts = ['1'], file, _deps = {}} = {}) {
    const append = _deps.appendFile || fsAppendFile;
    const mkdir = _deps.mkdir || fsMkdir;
    const entry = await buildEquityLogEntry({market, accounts, _deps});
    const {success: _drop, ...line} = entry;
    const target = resolveLogPath(file);
    await mkdir(path.dirname(target), {recursive: true});
    await append(target, `${JSON.stringify(line)}\n`, 'utf8');
    return {success: true, file: target, entry: line};
}

/** Max drawdown + longest losing streak over an equity series (pure). */
function drawdownStats(equities) {
    let peak = equities[0], maxDD = 0;
    let streak = 0, longestStreak = 0;
    for (let i = 1; i < equities.length; i++) {
        if (equities[i] > peak) peak = equities[i];
        const dd = peak > 0 ? equities[i] / peak - 1 : 0;
        if (dd < maxDD) maxDD = dd;
        if (equities[i] < equities[i - 1]) {
            streak++;
            if (streak > longestStreak) longestStreak = streak;
        } else if (equities[i] > equities[i - 1]) {
            streak = 0;
        }
    }
    const currentPeak = Math.max(...equities);
    const currentDD = currentPeak > 0 ? equities.at(-1) / currentPeak - 1 : 0;
    return {maxDD, currentDD, longestStreak};
}

/** Read and parse the JSONL log (corrupt lines skipped). */
async function readLogEntries(file, _deps) {
    const read = _deps.readFile || fsReadFile;
    const target = resolveLogPath(file);
    let text;
    try {
        text = await read(target, 'utf8');
    } catch {
        throw new Error(`no equity log at ${target} — run \`tv binance equity-log\` (on a schedule) to start recording samples`);
    }
    const rows = text.split(/\r?\n/).filter(Boolean).map((l) => {
        try {
            return JSON.parse(l);
        } catch {
            return null;
        }
    }).filter(Boolean);
    return {target, rows};
}

/** Per-account first-vs-last equity (accounts may appear later in the log's life). */
function perAccountReturns(series) {
    const perAccount = {};
    for (const r of series) {
        for (const a of r.accounts || []) {
            if (a.error !== undefined || !Number.isFinite(a.equity)) continue;
            if (!perAccount[a.account]) perAccount[a.account] = {first: a.equity, last: a.equity};
            perAccount[a.account].last = a.equity;
        }
    }
    return Object.entries(perAccount).map(([account, v]) => ({
        account, startEquity: v.first, currentEquity: v.last,
        returnPct: v.first ? Number(((v.last / v.first - 1) * 100).toFixed(2)) : null,
    }));
}

/**
 * Analyze the recorded equity log (pure math over the samples): total return, max & current
 * drawdown, longest run of declining samples, per-account first-vs-last return. Pass
 * `expectedMaxDrawdownPct` (e.g. the simulateEquity p90 max-drawdown, or the
 * estimateLosingStreak implied drawdown) to get an actual-vs-expected verdict. Reads the
 * JSONL file by default; pass `entries` directly to skip the filesystem.
 */
export async function analyzeEquityLog({file, entries, expectedMaxDrawdownPct, _deps = {}} = {}) {
    let rows = entries;
    let target;
    if (!rows) ({target, rows} = await readLogEntries(file, _deps));
    const series = (rows || []).filter((r) => Number.isFinite(r?.totalEquity)).sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
    if (series.length < 2) throw new Error(`need at least 2 equity samples to analyze (have ${series.length})`);

    const equities = series.map((r) => r.totalEquity);
    const first = series[0], last = series.at(-1);
    const {maxDD, currentDD, longestStreak} = drawdownStats(equities);
    const accounts = perAccountReturns(series);

    const maxDrawdownPct = Number((maxDD * 100).toFixed(2));
    const expected = expectedMaxDrawdownPct == null ? null : Math.abs(Number(expectedMaxDrawdownPct));
    return {
        success: true, ...(target ? {file: target} : {}), samples: series.length,
        from: first.iso ?? first.time, to: last.iso ?? last.time,
        startEquity: first.totalEquity, currentEquity: last.totalEquity,
        peakEquity: Math.max(...equities),
        returnPct: first.totalEquity ? Number(((last.totalEquity / first.totalEquity - 1) * 100).toFixed(2)) : null,
        maxDrawdownPct, currentDrawdownPct: Number((currentDD * 100).toFixed(2)),
        longestDecliningStreak: longestStreak,
        accounts,
        ...(expected == null ? {} : {
            expectedMaxDrawdownPct: -expected,
            verdict: Math.abs(maxDrawdownPct) <= expected ? 'WITHIN_EXPECTATION' : 'EXCEEDS_EXPECTATION',
        }),
        note: 'Equity samples include unrealized PnL, so intra-position swings count as drawdown. Compare maxDrawdownPct against binance_simulate_equity percentiles to see if the system is behaving as its win rate / R:R predicts.',
    };
}
