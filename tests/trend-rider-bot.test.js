// Offline tests for the Adaptive Trend Rider bot's pure signal math
// (scripts/trend_rider_bot.js). No network, no TradingView.
import test from 'node:test';
import assert from 'node:assert/strict';
import { emaSeries, atrSeries, adxSeries, computeDecision, sizeEntry, DEFAULT_CFG } from '../scripts/trend_rider_bot.js';

const H4 = 4 * 3600 * 1000;

/** Build candles from a list of closes: tight bars around each close. */
function candlesFrom(closes, { rangePct = 0.4 } = {}) {
    return closes.map((c, i) => {
        const prev = i > 0 ? closes[i - 1] : c;
        const open = prev;
        const high = Math.max(open, c) * (1 + rangePct / 100);
        const low = Math.min(open, c) * (1 - rangePct / 100);
        return { openTime: 1700000000000 + i * H4, open, high, low, close: c, closeTime: 1700000000000 + (i + 1) * H4 - 1 };
    });
}

const uptrend = (n, start = 100, pct = 1) => Array.from({ length: n }, (_, i) => start * Math.pow(1 + pct / 100, i));

test('emaSeries matches hand-computed values', () => {
    const e = emaSeries([1, 2, 3, 4, 5], 2);
    assert.equal(e[0], null);
    assert.equal(e[1], 1.5);
    assert.ok(Math.abs(e[2] - 2.5) < 1e-9);
    assert.ok(Math.abs(e[3] - 3.5) < 1e-9);
    assert.ok(Math.abs(e[4] - 4.5) < 1e-9);
});

test('atrSeries equals the constant bar range on a flat tape', () => {
    const candles = Array.from({ length: 40 }, () => ({ high: 102, low: 98, close: 100 }));
    const atr = atrSeries(candles.map((c) => c.high), candles.map((c) => c.low), candles.map((c) => c.close), 14);
    assert.ok(Math.abs(atr[39] - 4) < 1e-9);
});

test('adxSeries reads a steady uptrend as a strong trend', () => {
    const closes = uptrend(120);
    const c = candlesFrom(closes);
    const adx = adxSeries(c.map((x) => x.high), c.map((x) => x.low), c.map((x) => x.close), 14);
    assert.ok(adx[119] > 25, `expected strong ADX, got ${adx[119]}`);
});

test('computeDecision enters on a filtered breakout', () => {
    const candles = candlesFrom(uptrend(260));
    const d = computeDecision({ candles });
    assert.equal(d.action, 'enter');
    assert.equal(d.reason, 'breakout');
    assert.ok(d.stop < candles[candles.length - 1].close, 'stop must sit below the close');
    assert.ok(d.indicators.trendUp && d.indicators.strongTrend && d.indicators.breakout && d.indicators.armed);
});

test('re-arm gate blocks an immediate add after entry', () => {
    const candles = candlesFrom(uptrend(260));
    const last = candles[candles.length - 1];
    const d = computeDecision({
        candles,
        position: { qty: 1, adds: 1, stop: 90 },
        lastEntryTime: last.openTime, // just entered on this bar — no pullback since
    });
    assert.equal(d.action, 'none');
    assert.equal(d.reason, 'holding');
    assert.equal(d.indicators.armed, false);
});

test('pyramids after a pullback re-arms, and the stop only ratchets up', () => {
    // 220 bars up, a 4-bar dip below the fast EMA, then a fresh breakout leg
    const closes = uptrend(220);
    let p = closes[closes.length - 1];
    for (const drop of [-3, -3, -2, -1]) { p = p * (1 + drop / 100); closes.push(p); }
    for (let i = 0; i < 14; i++) { p = p * 1.015; closes.push(p); }
    const candles = candlesFrom(closes);
    const entryBeforeDip = candles[215].openTime;
    const d = computeDecision({ candles, position: { qty: 1, adds: 1, stop: 1 }, lastEntryTime: entryBeforeDip });
    assert.equal(d.action, 'add', `expected add, got ${d.action} (${d.reason})`);
    // ratchet: an already-higher stop is never lowered
    const high = candles[candles.length - 1].close + 100;
    const d2 = computeDecision({ candles, position: { qty: 1, adds: 1, stop: high }, lastEntryTime: entryBeforeDip });
    assert.equal(d2.action, 'add');
    assert.ok(Math.abs(d2.stop - high) < 0.01, 'ratcheted stop must keep the higher level');
});

test('max adds blocks further pyramiding, trend flip exits', () => {
    const closes = uptrend(220);
    let p = closes[closes.length - 1];
    for (const drop of [-3, -3, -2, -1]) { p = p * (1 + drop / 100); closes.push(p); }
    for (let i = 0; i < 14; i++) { p = p * 1.015; closes.push(p); }
    const maxed = computeDecision({
        candles: candlesFrom(closes),
        position: { qty: 1, adds: 3, stop: 1 },
        lastEntryTime: 0,
    });
    assert.equal(maxed.action, 'none');

    // decline until the fast EMA crosses under the slow — must produce exactly one 'exit'
    const declining = [...closes];
    for (let i = 0; i < 60; i++) { p = p * 0.985; declining.push(p); }
    const candles = candlesFrom(declining);
    let sawExit = false;
    for (let k = closes.length; k <= candles.length; k++) {
        const d = computeDecision({ candles: candles.slice(0, k), position: { qty: 1, adds: 3, stop: null }, lastEntryTime: 0 });
        if (d.action === 'exit') {
            assert.equal(d.reason, 'trend_flip');
            sawExit = true;
            break;
        }
    }
    assert.ok(sawExit, 'expected a trend_flip exit somewhere in the decline');
});

test('sizeEntry risks the configured % and respects the leverage cap', () => {
    // equity 10k, price 100, ATR 1 → stop dist 2.5, risk 2.25% = $225 → 90 units
    const qty = sizeEntry({ equity: 10000, price: 100, atr: 1, cfg: DEFAULT_CFG });
    assert.ok(Math.abs(qty - 90) < 1e-9);
    // cap: 3x leverage = 300 units max; with 250 already held only 50 fit
    const capped = sizeEntry({ equity: 10000, price: 100, atr: 1, existingQty: 250, cfg: DEFAULT_CFG });
    assert.ok(Math.abs(capped - 50) < 1e-9);
    // huge ATR → risk-based qty smaller than cap
    const small = sizeEntry({ equity: 10000, price: 100, atr: 10, cfg: DEFAULT_CFG });
    assert.ok(Math.abs(small - 9) < 1e-9);
});
