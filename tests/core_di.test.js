/**
 * Offline _deps-injected unit tests for previously-untested core modules:
 * chart (regression fixtures), indicators, watchlist, tab, pane, alerts, data.
 *
 * No TradingView connection: every function's evaluate/evaluateAsync/fetch is
 * mocked via the _deps DI hook. Asserts on validation, response shaping, and
 * that user input is passed through safeString() (injection safety).
 *
 * Run: node --test tests/core_di.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { safeString } from '../src/connection.js';

import { getVisibleRange, scrollToDate, symbolInfo } from '../src/core/chart.js';
import { setInputs, toggleVisibility } from '../src/core/indicators.js';
import { get as watchlistGet } from '../src/core/watchlist.js';
import { list as tabList, switchTab } from '../src/core/tab.js';
import { setLayout, list as paneList, focus as paneFocus } from '../src/core/pane.js';
import { activate, deleteAlerts, list as alertsList } from '../src/core/alerts.js';
import { getOhlcv, getIndicator, getQuote } from '../src/core/data.js';

// ── chart.js — regression: these three threw ReferenceError: evaluate is not
//    defined because they never destructured evaluate from _resolve(_deps). ──

describe('chart.js — getVisibleRange/scrollToDate/symbolInfo resolve _deps', () => {
  it('getVisibleRange returns shaped ranges (was ReferenceError)', async () => {
    const calls = [];
    const evaluate = async (e) => { calls.push(e); return { visible_range: { from: 1, to: 2 }, bars_range: { from: 0, to: 9 } }; };
    const r = await getVisibleRange({ _deps: { evaluate } });
    assert.equal(r.success, true);
    assert.deepEqual(r.visible_range, { from: 1, to: 2 });
    assert.equal(calls.length, 1);
  });

  it('symbolInfo spreads the evaluate result (was ReferenceError)', async () => {
    const evaluate = async () => ({ symbol: 'BTCUSD', exchange: 'BINANCE' });
    const r = await symbolInfo({ _deps: { evaluate } });
    assert.equal(r.success, true);
    assert.equal(r.symbol, 'BTCUSD');
    assert.equal(r.exchange, 'BINANCE');
  });

  it('scrollToDate reads resolution then zooms (was ReferenceError)', async () => {
    let i = 0;
    const calls = [];
    const evaluate = async (e) => { calls.push(e); i++; return i === 1 ? '60' : undefined; };
    const r = await scrollToDate({ date: '2024-01-15', _deps: { evaluate } });
    assert.equal(r.success, true);
    assert.equal(r.resolution, '60');
    assert.ok(calls.length >= 2, 'should resolve resolution then run the zoom expression');
  });
});

// ── indicators.js ──────────────────────────────────────────────────────────

describe('indicators.js — setInputs / toggleVisibility', () => {
  const noop = { evaluate: async () => ({}) };

  it('setInputs requires entity_id', async () => {
    await assert.rejects(() => setInputs({ inputs: { length: 5 }, _deps: noop }), /entity_id is required/);
  });

  it('setInputs requires a non-empty inputs object', async () => {
    await assert.rejects(() => setInputs({ entity_id: 'st1', inputs: {}, _deps: noop }), /non-empty object/);
  });

  it('setInputs parses a JSON inputs string and shapes the result', async () => {
    const evaluate = async () => ({ updated_inputs: { length: 50 } });
    const r = await setInputs({ entity_id: 'st1', inputs: '{"length":50}', _deps: { evaluate } });
    assert.equal(r.success, true);
    assert.deepEqual(r.updated_inputs, { length: 50 });
  });

  it('setInputs routes entity_id through safeString (injection safety)', async () => {
    let expr = '';
    const evaluate = async (e) => { expr = e; return { updated_inputs: {} }; };
    const evil = 'st"); doEvil(); ("';
    await setInputs({ entity_id: evil, inputs: { length: 1 }, _deps: { evaluate } });
    assert.ok(expr.includes(safeString(evil)), 'entity_id must be embedded via safeString');
    assert.ok(!expr.includes(evil), 'the raw unescaped payload must not appear in the expression');
  });

  it('toggleVisibility requires a boolean visible', async () => {
    await assert.rejects(() => toggleVisibility({ entity_id: 'st1', visible: 'yes', _deps: noop }), /must be a boolean/);
  });

  it('toggleVisibility returns the actual visibility', async () => {
    const evaluate = async () => ({ visible: false });
    const r = await toggleVisibility({ entity_id: 'st1', visible: false, _deps: { evaluate } });
    assert.equal(r.success, true);
    assert.equal(r.visible, false);
  });
});

// ── watchlist.js ───────────────────────────────────────────────────────────

describe('watchlist.js — get()', () => {
  it('shapes count/source/symbols from the evaluate result', async () => {
    const evaluate = async () => ({ symbols: [{ symbol: 'AAPL' }, { symbol: 'MSFT' }], source: 'data_attributes' });
    const r = await watchlistGet({ _deps: { evaluate } });
    assert.equal(r.success, true);
    assert.equal(r.count, 2);
    assert.equal(r.source, 'data_attributes');
  });

  it('defaults gracefully when evaluate returns null', async () => {
    const r = await watchlistGet({ _deps: { evaluate: async () => null } });
    assert.equal(r.count, 0);
    assert.equal(r.source, 'unknown');
    assert.deepEqual(r.symbols, []);
  });
});

// ── tab.js ─────────────────────────────────────────────────────────────────

describe('tab.js — list() / switchTab()', () => {
  const targets = [
    { type: 'page', url: 'https://www.tradingview.com/chart/abc123/?layout=x', title: 'Live stock, crypto charts on TradingView', id: 't1' },
    { type: 'page', url: 'https://example.com/other', title: 'Other', id: 't2' },
    { type: 'background_page', url: 'https://www.tradingview.com/chart/zzz', title: 'bg', id: 't3' },
  ];
  const mkFetch = (data) => async () => ({ json: async () => data, text: async () => '' });

  it('keeps only chart pages, indexes them, extracts chart_id and cleans the title', async () => {
    const r = await tabList({ _deps: { fetch: mkFetch(targets) } });
    assert.equal(r.tab_count, 1);
    assert.equal(r.tabs[0].index, 0);
    assert.equal(r.tabs[0].chart_id, 'abc123');
    assert.equal(r.tabs[0].title, 'TradingView');
  });

  it('switchTab throws when the index is out of range', async () => {
    await assert.rejects(() => switchTab({ index: 5, _deps: { fetch: mkFetch(targets) } }), /out of range/);
  });

  it('switchTab activates the target and returns its chart_id', async () => {
    const r = await switchTab({ index: 0, _deps: { fetch: mkFetch(targets) } });
    assert.equal(r.success, true);
    assert.equal(r.action, 'switched');
    assert.equal(r.chart_id, 'abc123');
  });
});

// ── pane.js ────────────────────────────────────────────────────────────────

describe('pane.js — setLayout / list / focus', () => {
  it('list maps the layout code to a friendly name', async () => {
    const evaluate = async () => ({ layout: '2h', chart_count: 2, active_index: 1, panes: [{ index: 0 }, { index: 1 }] });
    const r = await paneList({ _deps: { evaluate } });
    assert.equal(r.layout_name, '2 horizontal');
    assert.equal(r.chart_count, 2);
  });

  it('setLayout rejects an unknown layout', async () => {
    const deps = { evaluate: async () => ({}), evaluateAsync: async () => {} };
    await assert.rejects(() => setLayout({ layout: '9x9', _deps: deps }), /Unknown layout/);
  });

  it('setLayout resolves the "grid" alias to code 4 and sanitizes the call', async () => {
    let asyncExpr = '';
    const evaluateAsync = async (e) => { asyncExpr = e; };
    const evaluate = async () => ({ layout: '4', chart_count: 4, active_index: 0, panes: [] });
    const r = await setLayout({ layout: 'grid', _deps: { evaluate, evaluateAsync } });
    assert.equal(r.layout, '4');
    assert.equal(r.layout_name, '2x2 grid');
    assert.ok(asyncExpr.includes(`setLayout(${safeString('4')})`));
  });

  it('focus throws on an error result', async () => {
    await assert.rejects(() => paneFocus({ index: 9, _deps: { evaluate: async () => ({ error: 'Pane index 9 out of range' }) } }), /out of range/);
  });
});

// ── alerts.js ──────────────────────────────────────────────────────────────

describe('alerts.js — activate / deleteAlerts / list', () => {
  it('activate rejects a non-numeric alert_id', async () => {
    await assert.rejects(() => activate({ alert_id: 'abc', _deps: { evaluateAsync: async () => ({ ok: true }) } }), /alert_id/);
  });

  it('activate embeds the numeric id and maps an ok result', async () => {
    let expr = '';
    const evaluateAsync = async (e) => { expr = e; return { ok: true }; };
    const r = await activate({ alert_id: 42, _deps: { evaluateAsync } });
    assert.equal(r.success, true);
    assert.equal(r.alert_id, 42);
    assert.ok(expr.includes('restartAlert(42'));
  });

  it('activate maps a failure result', async () => {
    const r = await activate({ alert_id: 7, _deps: { evaluateAsync: async () => ({ ok: false, error: 'nope' }) } });
    assert.equal(r.success, false);
    assert.equal(r.error, 'nope');
  });

  it('deleteAlerts throws for the unsupported single-delete path', async () => {
    await assert.rejects(() => deleteAlerts({ delete_all: false, _deps: { evaluate: async () => ({}) } }), /not yet supported/);
  });

  it('list shapes alert_count from the API result', async () => {
    const evaluateAsync = async () => ({ alerts: [{ alert_id: 1 }, { alert_id: 2 }, { alert_id: 3 }] });
    const r = await alertsList({ _deps: { evaluateAsync } });
    assert.equal(r.alert_count, 3);
    assert.equal(r.source, 'internal_api');
  });
});

// ── data.js ────────────────────────────────────────────────────────────────

describe('data.js — getOhlcv / getIndicator / getQuote', () => {
  it('getOhlcv summary computes high/low/open/close/change/avg_volume', async () => {
    const bars = [
      { time: 1, open: 100, high: 110, low: 90, close: 105, volume: 10 },
      { time: 2, open: 105, high: 120, low: 95, close: 115, volume: 20 },
    ];
    const evaluate = async () => ({ bars, total_bars: 2, source: 'direct_bars' });
    const r = await getOhlcv({ summary: true, _deps: { evaluate } });
    assert.equal(r.bar_count, 2);
    assert.equal(r.high, 120);
    assert.equal(r.low, 90);
    assert.equal(r.open, 100);
    assert.equal(r.close, 115);
    assert.equal(r.change, 15);
    assert.equal(r.avg_volume, 15);
  });

  it('getOhlcv returns raw bars without summary', async () => {
    const bars = [{ time: 1, open: 1, high: 2, low: 0.5, close: 1.5, volume: 3 }];
    const r = await getOhlcv({ _deps: { evaluate: async () => ({ bars, total_bars: 1, source: 'direct_bars' }) } });
    assert.equal(r.bar_count, 1);
    assert.equal(r.bars.length, 1);
    assert.equal(r.source, 'direct_bars');
  });

  it('getOhlcv throws when no bars come back', async () => {
    await assert.rejects(() => getOhlcv({ _deps: { evaluate: async () => ({ bars: [] }) } }), /Could not extract OHLCV/);
  });

  it('getIndicator filters oversized text inputs', async () => {
    const inputs = [{ id: 'length', value: 14 }, { id: 'note', value: 'x'.repeat(600) }];
    const r = await getIndicator({ entity_id: 'st1', _deps: { evaluate: async () => ({ visible: true, inputs }) } });
    assert.equal(r.inputs.length, 1);
    assert.equal(r.inputs[0].id, 'length');
  });

  it('getIndicator throws on a study error', async () => {
    await assert.rejects(() => getIndicator({ entity_id: 'x', _deps: { evaluate: async () => ({ error: 'Study not found: x' }) } }), /Study not found/);
  });

  it('getQuote routes the symbol through safeString (injection safety)', async () => {
    let expr = '';
    const evaluate = async (e) => { expr = e; return { symbol: 'BTCUSD', last: 100, close: 100 }; };
    await getQuote({ symbol: 'BTC"USD', _deps: { evaluate } });
    assert.ok(expr.includes(safeString('BTC"USD')), 'symbol must be embedded via safeString');
  });
});
