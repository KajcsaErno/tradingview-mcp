/**
 * Unit tests for src/core/binance/sentiment.js — Fear & Greed index and the
 * static FOMC/CPI macro-event calendar, plus getSignal's events:true cautions.
 * Pure, no network.
 */
import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {getFearGreed, getMarketEvents, getSignal} from '../src/core/binance.js';
import {deps, genKlines} from './_binance_helpers.js';

const fngFetch = (rows) => async () => ({ok: true, status: 200, json: async () => ({data: rows})});
const fngRow = (value, classification, ts = 1750000000) => ({value: String(value), value_classification: classification, timestamp: String(ts)});

describe('getFearGreed', () => {
    it('parses the latest value and classifies the read', async () => {
        const r = await getFearGreed({_deps: {fetch: fngFetch([fngRow(20, 'Extreme Fear')])}});
        assert.equal(r.value, 20);
        assert.equal(r.classification, 'Extreme Fear');
        assert.match(r.read, /contrarian-bullish/);
        assert.equal(r.history, undefined); // single row → no history block
    });

    it('returns history when limit > 1 and reads greed at the top end', async () => {
        const r = await getFearGreed({limit: 3, _deps: {fetch: fngFetch([fngRow(80, 'Extreme Greed'), fngRow(75, 'Greed'), fngRow(60, 'Greed')])}});
        assert.match(r.read, /contrarian-bearish/);
        assert.equal(r.history.length, 3);
        assert.equal(r.history[2].value, 60);
    });

    it('throws on an empty payload', async () => {
        await assert.rejects(getFearGreed({_deps: {fetch: fngFetch([])}}), /Fear & Greed fetch failed/);
    });
});

describe('getMarketEvents', () => {
    // Fixed clock: 2026-06-12 (two trading days before the Jun 16-17 FOMC meeting).
    const NOW = Date.parse('2026-06-12T12:00:00Z');
    const _deps = {now: () => NOW};

    it('lists upcoming events in order with day counts', () => {
        const r = getMarketEvents({daysAhead: 40, _deps});
        assert.equal(r.next.type, 'FOMC');
        assert.equal(r.next.date, '2026-06-17');
        assert.equal(r.next.daysUntil, 5);
        assert.ok(r.next.dotPlot); // June meeting carries projections
        const dates = r.events.map((e) => e.date);
        assert.deepEqual(dates, ['2026-06-17', '2026-07-14']); // FOMC then July CPI within 40d... July 29 FOMC is day 47
    });

    it('warns when an event is within 2 days', () => {
        const close = {now: () => Date.parse('2026-06-16T12:00:00Z')};
        const r = getMarketEvents({_deps: close});
        assert.ok(r.warning.some((w) => /FOMC rate decision in 1 day \(2026-06-17/.test(w)));
        const onDay = {now: () => Date.parse('2026-12-10T10:00:00Z')};
        const r2 = getMarketEvents({_deps: onDay});
        assert.ok(r2.warning.some((w) => /US CPI release TODAY/.test(w)));
    });

    it('flags a stale calendar past the last known event', () => {
        const r = getMarketEvents({_deps: {now: () => Date.parse('2027-02-01T00:00:00Z')}});
        assert.equal(r.count, 0);
        assert.match(r.note, /extend MACRO_EVENTS/);
    });
});

describe('getSignal events:true', () => {
    it('adds a scheduled-event caution near a release without moving the score', async () => {
        const base = deps({klines: genKlines(300, (i) => 50000 + i * 40 + i * i * 0.5)});
        const quiet = await getSignal({market: 'futures', symbol: 'BTCUSDC', _deps: {...base, now: () => Date.parse('2026-06-01T00:00:00Z')}, events: true});
        assert.ok(!(quiet.cautions || []).some((c) => /scheduled event/.test(c)));

        const base2 = deps({klines: genKlines(300, (i) => 50000 + i * 40 + i * i * 0.5)});
        const preFomc = await getSignal({market: 'futures', symbol: 'BTCUSDC', _deps: {...base2, now: () => Date.parse('2026-06-16T00:00:00Z')}, events: true});
        assert.ok(preFomc.cautions.some((c) => /scheduled event: FOMC/.test(c)));
        assert.equal(preFomc.score, quiet.score); // cautions never move the score
    });
});
