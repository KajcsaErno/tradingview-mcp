/**
 * Offline unit tests for src/core/health.js.
 *
 * health.js does NOT take the `_deps` DI hook — it imports getClient/
 * getTargetInfo/evaluate from connection.js (and fs/child_process) directly,
 * so the core_di.test.js injection style doesn't apply. Per the
 * no-source-changes constraint, the dependencies are substituted with
 * module-customization hooks (node:module registerHooks — synchronous, no
 * flags required) before health.js is imported, so every test runs with zero
 * CDP, zero network, and zero spawned processes.
 *
 * Coverage:
 *  - healthCheck(): target + page-state shaping, ??/|| fallbacks, error path
 *  - discover():    available/total API counting + passthrough
 *  - uiState():     result spreading
 *  - launch():      binary-discovery failure paths only. The success path is
 *    NOT offline-testable: every found-binary branch spawns a real process
 *    and polls CDP with hard-coded 1000–1500ms setTimeout sleeps.
 *
 * Run: node --test tests/health.test.js
 */
import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';

// Controllable doubles, reachable from the mock module sources below via
// globalThis (the mock sources are compiled from strings and can't close
// over test-file locals).
const conn = {
    getClient: async () => ({}),
    getTargetInfo: async () => ({id: 't1', url: 'u', title: 'T'}),
    evaluate: async () => null,
};
globalThis.__healthTestConn = conn;
globalThis.__healthTestFs = null; // { existsSync } or null → real fs
globalThis.__healthTestCp = null; // { execSync, spawn } or null → real child_process

registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier === 'fs') return {url: 'mock:fs', format: 'module', shortCircuit: true};
        if (specifier === 'child_process') return {url: 'mock:child_process', format: 'module', shortCircuit: true};
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
          const m = globalThis.__healthTestConn;
          export const getClient = (...a) => m.getClient(...a);
          export const getTargetInfo = (...a) => m.getTargetInfo(...a);
          export const evaluate = (...a) => m.evaluate(...a);
          export const evaluateAsync = (...a) => m.evaluate(...a);
          export const safeString = (s) => JSON.stringify(String(s));
          export const requireFinite = (n) => n;
          export const KNOWN_PATHS = {};
        `,
            };
        }
        if (url === 'mock:fs') {
            // Delegate to the real fs unless a test installs an override, so any
            // unrelated late consumer of bare 'fs' keeps working.
            return {
                format: 'module',
                shortCircuit: true,
                source: `
          import * as real from 'node:fs';
          export const existsSync = (...a) =>
            globalThis.__healthTestFs ? globalThis.__healthTestFs.existsSync(...a) : real.existsSync(...a);
        `,
            };
        }
        if (url === 'mock:child_process') {
            return {
                format: 'module',
                shortCircuit: true,
                source: `
          import * as real from 'node:child_process';
          export const execSync = (...a) =>
            globalThis.__healthTestCp ? globalThis.__healthTestCp.execSync(...a) : real.execSync(...a);
          export const spawn = (...a) =>
            globalThis.__healthTestCp ? globalThis.__healthTestCp.spawn(...a) : real.spawn(...a);
        `,
            };
        }
        return nextLoad(url, context);
    },
});

const {healthCheck, discover, uiState, launch} = await import('../src/core/health.js');

// ── healthCheck ──────────────────────────────────────────────────────────────

describe('health.js — healthCheck()', () => {
    it('shapes CDP target info and page state into the report', async () => {
        let expr = '';
        conn.getClient = async () => ({});
        conn.getTargetInfo = async () => ({id: 'tgt-9', url: 'https://www.tradingview.com/chart/abc/', title: 'TV'});
        conn.evaluate = async (e) => {
            expr = e;
            return {url: 'u', title: 't', symbol: 'BTCUSD', resolution: '60', chartType: 1, apiAvailable: true};
        };
        const r = await healthCheck();
        assert.equal(r.success, true);
        assert.equal(r.cdp_connected, true);
        assert.equal(r.target_id, 'tgt-9');
        assert.equal(r.target_url, 'https://www.tradingview.com/chart/abc/');
        assert.equal(r.target_title, 'TV');
        assert.equal(r.chart_symbol, 'BTCUSD');
        assert.equal(r.chart_resolution, '60');
        assert.equal(r.chart_type, 1);
        assert.equal(r.api_available, true);
        assert.ok(expr.includes('_activeChartWidgetWV'), 'probes the known chart API path');
    });

    it('preserves a falsy chartType of 0 (?? not ||)', async () => {
        conn.evaluate = async () => ({symbol: 'ES1!', resolution: 'D', chartType: 0, apiAvailable: true});
        const r = await healthCheck();
        assert.equal(r.chart_type, 0);
    });

    it('falls back to unknown/null/false when the page returns nothing', async () => {
        conn.evaluate = async () => null;
        const r = await healthCheck();
        assert.equal(r.success, true);
        assert.equal(r.chart_symbol, 'unknown');
        assert.equal(r.chart_resolution, 'unknown');
        assert.equal(r.chart_type, null);
        assert.equal(r.api_available, false);
    });

    it('propagates a connection failure from getClient', async () => {
        conn.getClient = async () => {
            throw new Error('CDP connect failed');
        };
        await assert.rejects(() => healthCheck(), /CDP connect failed/);
        conn.getClient = async () => ({});
    });
});

// ── discover ─────────────────────────────────────────────────────────────────

describe('health.js — discover()', () => {
    it('counts available APIs and passes the probe results through', async () => {
        conn.evaluate = async () => ({
            chartApi: {available: true, methodCount: 120},
            chartWidgetCollection: {available: true},
            chartApiInstance: {available: false, error: 'undefined'},
            bottomWidgetBar: {available: false},
            replayApi: {available: true},
            alertService: {available: true},
        });
        const r = await discover();
        assert.equal(r.success, true);
        assert.equal(r.apis_available, 4);
        assert.equal(r.apis_total, 6);
        assert.equal(r.apis.chartApi.methodCount, 120);
        assert.equal(r.apis.chartApiInstance.available, false);
    });

    it('reports zero available when every probe failed', async () => {
        conn.evaluate = async () => ({
            chartApi: {available: false, error: 'x'},
            replayApi: {available: false, error: 'y'},
        });
        const r = await discover();
        assert.equal(r.apis_available, 0);
        assert.equal(r.apis_total, 2);
    });
});

// ── uiState ──────────────────────────────────────────────────────────────────

describe('health.js — uiState()', () => {
    it('spreads the page UI state under success:true', async () => {
        let expr = '';
        conn.evaluate = async (e) => {
            expr = e;
            return {
                bottom_panel: {open: true, height: 200},
                pine_editor: {open: false, width: 0, height: 0},
                chart: {symbol: 'ES1!', resolution: '5', study_count: 3},
                replay: {error: 'no replay api'},
            };
        };
        const r = await uiState();
        assert.equal(r.success, true);
        assert.deepEqual(r.bottom_panel, {open: true, height: 200});
        assert.equal(r.pine_editor.open, false);
        assert.equal(r.chart.symbol, 'ES1!');
        assert.equal(r.replay.error, 'no replay api');
        assert.ok(expr.includes('layout__area--bottom'), 'inspects the bottom panel DOM');
    });
});

// ── launch (binary-discovery failure paths only) ─────────────────────────────

describe('health.js — launch() binary discovery', () => {
    it('throws a helpful not-found error without spawning anything', async () => {
        const execCalls = [];
        let spawned = false;
        globalThis.__healthTestFs = {existsSync: () => false};
        globalThis.__healthTestCp = {
            execSync: (cmd) => {
                execCalls.push(cmd);
                throw new Error('lookup failed');
            },
            spawn: () => {
                spawned = true;
                return {
                    pid: 0, unref() {
                    }
                };
            },
        };
        try {
            await assert.rejects(() => launch({port: 9333}), (err) => {
                assert.match(err.message, /TradingView not found/);
                assert.match(err.message, /--remote-debugging-port=9333/, 'manual-launch hint uses the requested port');
                assert.match(err.message, /Searched:/);
                return true;
            });
            assert.equal(spawned, false, 'must not spawn when no binary was found');
            assert.ok(execCalls.length >= 1, 'falls back to the where/which lookup');
        } finally {
            globalThis.__healthTestFs = null;
            globalThis.__healthTestCp = null;
        }
    });

    it('rejects a where/which hit whose path does not exist on disk', async () => {
        globalThis.__healthTestFs = {existsSync: () => false};
        globalThis.__healthTestCp = {
            execSync: () => 'C:\\nope\\TradingView.exe\n',
            spawn: () => {
                throw new Error('must not spawn');
            },
        };
        try {
            await assert.rejects(() => launch({port: 9222, kill_existing: false}), /TradingView not found/);
        } finally {
            globalThis.__healthTestFs = null;
            globalThis.__healthTestCp = null;
        }
    });
});
