/**
 * Unit tests for src/core/binance/equity.js — equity-curve sampling, JSONL append,
 * and the pure log analyzer (drawdown/streaks, actual-vs-expected verdict).
 * Pure, no network, no real filesystem.
 */
import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {analyzeEquityLog, appendEquityLog, buildEquityLogEntry} from '../src/core/binance.js';
import {deps} from './_binance_helpers.js';

const summaryDeps = (balances) => {
    // getAccountSummary hits /fapi/v2/account; route every call to a rotating balance per key set.
    let i = 0;
    const d = deps({});
    d.fetch = async (url, opts = {}) => {
        d.fetch.calls.push({url, method: opts.method || 'GET'});
        const b = balances[Math.min(i++, balances.length - 1)];
        return {ok: true, status: 200, json: async () => ({totalMarginBalance: String(b), totalWalletBalance: String(b - 10), totalUnrealizedProfit: '10'})};
    };
    d.fetch.calls = [];
    return d;
};

const entry = (time, totalEquity, accounts = [{account: '1', equity: totalEquity}]) =>
    ({time, iso: new Date(time).toISOString(), totalEquity, accounts});

describe('buildEquityLogEntry / appendEquityLog', () => {
    it('samples each account and totals equity', async () => {
        const _deps = summaryDeps([1000, 500]);
        const r = await buildEquityLogEntry({market: 'futures', accounts: '1,2', _deps});
        assert.equal(r.accounts.length, 2);
        assert.equal(r.totalEquity, 1500);
        assert.equal(r.accounts[0].equity, 1000);
        assert.equal(r.accounts[1].wallet, 490);
        assert.equal(r.time, 1700000000000); // _deps.now from helpers
    });

    it('appends one JSON line (without the success flag) and creates the directory', async () => {
        const writes = [];
        const dirs = [];
        const _deps = {
            ...summaryDeps([1000]),
            appendFile: async (file, text) => writes.push({file, text}),
            mkdir: async (dir) => dirs.push(dir),
        };
        const r = await appendEquityLog({accounts: ['1'], file: 'strategies/equity-log.jsonl', _deps});
        assert.equal(writes.length, 1);
        assert.ok(dirs.length === 1 && writes[0].file.endsWith('equity-log.jsonl'));
        const line = JSON.parse(writes[0].text);
        assert.equal(line.success, undefined);
        assert.equal(line.totalEquity, 1000);
        assert.equal(r.entry.totalEquity, 1000);
    });

    it('throws only when EVERY account fails', async () => {
        const bad = {...deps({}), fetch: async () => ({ok: false, status: 401, json: async () => ({code: -2014, msg: 'bad key'})})};
        await assert.rejects(buildEquityLogEntry({accounts: ['1'], _deps: bad}), /equity sample failed for every account/);
    });
});

describe('analyzeEquityLog', () => {
    it('computes return, max/current drawdown and the longest declining streak', async () => {
        const entries = [
            entry(1, 1000), entry(2, 1100), entry(3, 1050), entry(4, 990), entry(5, 935), // 3-sample decline, -15% DD from 1100
            entry(6, 1200),
        ];
        const r = await analyzeEquityLog({entries});
        assert.equal(r.samples, 6);
        assert.equal(r.returnPct, 20);
        assert.equal(r.maxDrawdownPct, -15);
        assert.equal(r.currentDrawdownPct, 0); // new peak at the end
        assert.equal(r.longestDecliningStreak, 3);
        assert.equal(r.peakEquity, 1200);
    });

    it('verdicts actual vs expected drawdown', async () => {
        const entries = [entry(1, 1000), entry(2, 800), entry(3, 900)];
        const within = await analyzeEquityLog({entries, expectedMaxDrawdownPct: 25});
        assert.equal(within.verdict, 'WITHIN_EXPECTATION');
        const exceeds = await analyzeEquityLog({entries, expectedMaxDrawdownPct: 10});
        assert.equal(exceeds.verdict, 'EXCEEDS_EXPECTATION');
        assert.equal(exceeds.maxDrawdownPct, -20);
    });

    it('reads and parses the JSONL file via _deps, skipping corrupt lines', async () => {
        const text = `${JSON.stringify(entry(1, 1000))}\nnot-json\n${JSON.stringify(entry(2, 1100))}\n`;
        const r = await analyzeEquityLog({_deps: {readFile: async () => text}});
        assert.equal(r.samples, 2);
        assert.equal(r.returnPct, 10);
        assert.match(r.file, /equity-log\.jsonl$/);
    });

    it('per-account breakdown tracks first vs last equity', async () => {
        const entries = [
            entry(1, 1500, [{account: '1', equity: 1000}, {account: '2', equity: 500}]),
            entry(2, 1700, [{account: '1', equity: 1100}, {account: '2', equity: 600}]),
        ];
        const r = await analyzeEquityLog({entries});
        assert.deepEqual(r.accounts.find((a) => a.account === '2'), {account: '2', startEquity: 500, currentEquity: 600, returnPct: 20});
    });

    it('demands at least 2 samples and a readable file', async () => {
        await assert.rejects(analyzeEquityLog({entries: [entry(1, 1000)]}), /at least 2 equity samples/);
        await assert.rejects(analyzeEquityLog({_deps: {readFile: async () => { throw new Error('ENOENT'); }}}), /no equity log at/);
    });
});
