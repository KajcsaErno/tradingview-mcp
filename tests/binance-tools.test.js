/**
 * Unit tests for src/core/binance.js — cross-cutting tools: trade mirroring,
 * sizing & expectancy planners, the user-data/market-stream builders, bounded
 * WS captures (watchPrice/watchOrderFlow), footprint/volatility/options
 * microstructure tools, and the testnet switch. Pure, no network.
 */
import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {
    buildMarketStream,
    calcExpectancy,
    calcPositionSize,
    closeUserStream,
    estimateLosingStreak,
    formatMarketEvent,
    getBalance,
    getFootprintBars,
    getOptionsSurface,
    getServerTime,
    getTicker,
    getVolatilityRegime,
    keepAliveUserStream,
    mirrorBracket,
    mirrorOrder,
    placeOrder,
    simulateEquity,
    startUserStream,
    watchOrderFlow,
    watchPrice,
} from '../src/core/binance.js';
import {deps, FILTERS, mockFetch} from './_binance_helpers.js';

// mirror-mode deps: distinct per-account keys (via getKeys) and per-key balances keyed on the
// API-key header so /fapi/v2/balance can return a different figure for each account.
function mirrorDeps({balances = {k1: 1000, k2: 500}, failOrderForKey, routes = {}} = {}) {
    const calls = [];
    const fetch = async (url, opts = {}) => {
        const apiKey = opts.headers?.['X-MBX-APIKEY'];
        calls.push({url, method: opts.method || 'GET', apiKey});
        if (url.includes('exchangeInfo')) return {ok: true, status: 200, json: async () => FILTERS};
        if (url.includes('positionSide/dual')) return {ok: true, status: 200, json: async () => ({dualSidePosition: false})};
        if (url.includes('/fapi/v2/balance')) {
            const usdt = balances[apiKey] ?? 0;
            return {ok: true, status: 200, json: async () => [{asset: 'USDT', balance: String(usdt), availableBalance: String(usdt)}]};
        }
        if (url.includes('/fapi/v1/order')) {
            if (failOrderForKey && apiKey === failOrderForKey) return {
                ok: false,
                status: 400,
                json: async () => ({code: -2010, msg: 'order would immediately trigger'})
            };
            return {ok: true, status: 200, json: async () => ({orderId: 1, status: 'NEW'})};
        }
        for (const [substr, data] of Object.entries(routes)) {
            if (url.includes(substr)) return {ok: true, status: 200, json: async () => data};
        }
        return {ok: true, status: 200, json: async () => ({orderId: 1, status: 'NEW'})};
    };
    fetch.calls = calls;
    return {fetch, getKeys: (acct) => ({key: `k${acct}`, secret: `s${acct}`}), now: () => 1700000000000};
}

const orderPosts = (fetch) => fetch.calls.filter((c) => c.method === 'POST' && c.url.includes('/fapi/v1/order'));

describe('mirrorOrder — balance-scaled fan-out', () => {
    it('dry-run previews both accounts with the scaled quantity and sends nothing', async () => {
        const _deps = mirrorDeps({balances: {k1: 1000, k2: 500}});
        const r = await mirrorOrder({
            market: 'futures',
            symbol: 'BTCUSDC',
            side: 'SELL',
            type: 'LIMIT',
            quantity: 1,
            price: 64800,
            accounts: ['1', '2'],
            _deps
        });
        assert.equal(r.dry_run, true);
        assert.equal(r.base, '1');
        assert.equal(r.accounts.length, 2);
        assert.equal(r.accounts[0].account, '1');
        assert.equal(r.accounts[0].factor, 1);
        assert.equal(r.accounts[0].quantity, 1);
        assert.equal(r.accounts[1].account, '2');
        assert.equal(r.accounts[1].factor, 0.5); // 500/1000
        assert.equal(r.accounts[1].quantity, 0.5);
        assert.equal(r.accounts[1].result.order_preview.quantity, '0.5');
        assert.equal(orderPosts(_deps.fetch).length, 0);
    });

    it('confirm places one order per account, each signed with its own key and scaled qty', async () => {
        const _deps = mirrorDeps({balances: {k1: 1000, k2: 500}});
        const r = await mirrorOrder({
            market: 'futures',
            symbol: 'BTCUSDC',
            side: 'SELL',
            type: 'LIMIT',
            quantity: 1,
            price: 64800,
            positionSide: 'SHORT',
            accounts: ['1', '2'],
            confirm: true,
            _deps
        });
        assert.equal(r.success, true);
        const ps = orderPosts(_deps.fetch);
        assert.equal(ps.length, 2);
        const byKey = Object.fromEntries(ps.map((c) => [c.apiKey, c]));
        assert.ok(byKey.k1, 'base account order signed with k1');
        assert.ok(byKey.k2, 'mirror account order signed with k2');
        assert.ok(byKey.k1.url.includes('quantity=1&'), 'base qty 1');
        assert.ok(byKey.k2.url.includes('quantity=0.5&'), 'mirror qty scaled to 0.5');
    });

    it('skips a mirror whose scaled quantity floors below minQty, base still placed', async () => {
        const _deps = mirrorDeps({balances: {k1: 1000, k2: 0.0001}}); // factor 1e-7 → qty floors to 0
        const r = await mirrorOrder({
            market: 'futures',
            symbol: 'BTCUSDC',
            side: 'SELL',
            type: 'LIMIT',
            quantity: 1,
            price: 64800,
            positionSide: 'SHORT',
            accounts: ['1', '2'],
            confirm: true,
            _deps
        });
        assert.match(r.accounts[1].skipped, /below minQty/);
        assert.equal(orderPosts(_deps.fetch).length, 1); // only the base
        assert.equal(r.success, true); // base placed, mirror intentionally skipped
    });

    it('on confirm, a failed base order skips the mirror entirely', async () => {
        const _deps = mirrorDeps({balances: {k1: 1000, k2: 500}, failOrderForKey: 'k1'});
        const r = await mirrorOrder({
            market: 'futures',
            symbol: 'BTCUSDC',
            side: 'SELL',
            type: 'LIMIT',
            quantity: 1,
            price: 64800,
            positionSide: 'SHORT',
            accounts: ['1', '2'],
            confirm: true,
            _deps
        });
        assert.equal(r.success, false);
        assert.equal(r.accounts[0].result.success, false); // base failed
        assert.match(r.accounts[1].skipped, /base order failed/);
        assert.equal(orderPosts(_deps.fetch).length, 1); // mirror never attempted
    });

    it('requires at least two accounts', async () => {
        await assert.rejects(
            mirrorOrder({market: 'futures', symbol: 'BTCUSDC', side: 'SELL', type: 'LIMIT', quantity: 1, price: 64800, accounts: ['1'], _deps: mirrorDeps()}),
            /at least two accounts/,
        );
    });
});

describe('mirrorBracket — balance-scaled fan-out', () => {
    it('scales the entry and per-TP quantities for the mirror account', async () => {
        const _deps = mirrorDeps({balances: {k1: 1000, k2: 500}});
        const r = await mirrorBracket({
            market: 'futures', symbol: 'BTCUSDC', side: 'SELL', quantity: 1,
            entryType: 'LIMIT', entryPrice: 64800, stopPrice: 67500,
            takeProfits: [{price: 61300, quantity: 0.6}, {price: 60000, quantity: 0.4}],
            allowTaker: true, accounts: ['1', '2'], _deps,
        });
        assert.equal(r.dry_run, true);
        assert.equal(r.accounts[0].result.legs.find((l) => l.leg === 'entry').quantity, '1');
        const mirror = r.accounts[1].result;
        assert.equal(mirror.legs.find((l) => l.leg === 'entry').quantity, '0.5'); // 1 × 0.5
        assert.equal(mirror.legs.find((l) => l.leg === 'tp1').quantity, '0.3');   // 0.6 × 0.5
        assert.equal(mirror.legs.find((l) => l.leg === 'tp2').quantity, '0.2');   // 0.4 × 0.5
    });
});

describe('user-data stream (listenKey)', () => {
    it('startUserStream POSTs the futures listenKey endpoint and returns a wsUrl', async () => {
        const _deps = deps({listenKey: {listenKey: 'abc123'}});
        const r = await startUserStream({market: 'futures', account: '1', _deps});
        assert.equal(r.listenKey, 'abc123');
        assert.match(r.wsUrl, /^wss:\/\/fstream\.binance\.com\/ws\/abc123$/);
        assert.equal(_deps.fetch.calls[0].method, 'POST');
        assert.match(_deps.fetch.calls[0].url, /\/fapi\/v1\/listenKey/);
    });
    it('keepAliveUserStream PUTs; spot requires a listenKey', async () => {
        const _deps = deps({userDataStream: {}});
        await keepAliveUserStream({market: 'spot', account: '1', listenKey: 'k', _deps});
        assert.equal(_deps.fetch.calls[0].method, 'PUT');
        assert.match(_deps.fetch.calls[0].url, /\/api\/v3\/userDataStream\?listenKey=k/);
        await assert.rejects(keepAliveUserStream({market: 'spot', account: '1', _deps: deps()}), /listenKey is required/);
    });
    it('closeUserStream DELETEs the futures endpoint', async () => {
        const _deps = deps({listenKey: {}});
        await closeUserStream({market: 'futures', account: '1', _deps});
        assert.equal(_deps.fetch.calls[0].method, 'DELETE');
        assert.match(_deps.fetch.calls[0].url, /\/fapi\/v1\/listenKey/);
    });
    it('routes the requested account for the listenKey', async () => {
        const seen = [];
        const _deps = {
            fetch: mockFetch({listenKey: {listenKey: 'k2'}}), getKeys: (a) => {
                seen.push(a);
                return {key: 'k', secret: 's'};
            }, now: () => 1700000000000
        };
        await startUserStream({market: 'futures', account: '2', _deps});
        assert.deepEqual(seen, ['2']);
    });
});

// ── risk sizing / expectancy planners ─────────────────────────────────────────
describe('calcPositionSize', () => {
    it('sizes from an explicit risk amount and computes notional + margin', async () => {
        // entry 60000, stop 58000 → risk/unit 2000; risk $1000 → qty 0.5 (snapped to 0.001 step)
        const r = await calcPositionSize({market: 'futures', symbol: 'BTCUSDC', entry: 60000, stop: 58000, leverage: 3, riskAmount: 1000, _deps: deps()});
        assert.equal(r.quantity, 0.5);
        assert.equal(r.notional, 30000);
        assert.equal(r.requiredMargin, 10000);
        assert.equal(r.side, 'LONG (BUY)');
    });
    it('derives risk from riskPct × balance and flags >3x implied leverage', async () => {
        // balance 50000, 5% → risk 2500; entry 60000 stop 59000 → unit 1000 → qty 2.5 → notional 150000 → 3x
        const r = await calcPositionSize({
            market: 'futures',
            symbol: 'BTCUSDC',
            entry: 60000,
            stop: 59000,
            leverage: 3,
            riskPct: 5,
            balance: 50000,
            _deps: deps()
        });
        assert.equal(r.quantity, 2.5);
        assert.equal(r.notional, 150000);
        assert.equal(r.impliedAccountLeverage, 3);
        // exactly 3x → no breach warning
        assert.ok(!(r.warnings || []).some((w) => /implied account leverage/.test(w)));
    });
    it('warns when leverage exceeds the 3x rule', async () => {
        const r = await calcPositionSize({market: 'futures', symbol: 'BTCUSDC', entry: 60000, stop: 59000, leverage: 5, riskAmount: 100, _deps: deps()});
        assert.ok((r.warnings || []).some((w) => /3x rule/.test(w)));
    });
    it('requires entry !== stop and a risk budget', async () => {
        await assert.rejects(calcPositionSize({
            market: 'futures',
            symbol: 'BTCUSDC',
            entry: 60000,
            stop: 60000,
            riskAmount: 100,
            _deps: deps()
        }), /must differ/);
        await assert.rejects(calcPositionSize({market: 'futures', symbol: 'BTCUSDC', entry: 60000, stop: 59000, _deps: deps()}), /riskAmount.*riskPct/);
    });
});

describe('calcExpectancy — the math of expectancy', () => {
    it('reproduces the 50% / 2:1 / $100 → $5000-over-100-trades example', () => {
        const r = calcExpectancy({winRate: 50, rrRatio: 2, riskAmount: 100, trades: 100});
        assert.equal(r.expectancyR, 0.5);              // 0.5·2 − 0.5·1
        assert.equal(r.expectancyPerTrade, 50);        // 0.5R × $100
        assert.equal(r.expectedPnlOverTrades, 5000);   // × 100 trades
        assert.equal(r.edge, 'positive');
    });
    it('computes break-even win rate 1/(1+rr) — 33.33% for 2:1', () => {
        const r = calcExpectancy({winRate: 40, rrRatio: 2});
        assert.equal(r.breakevenWinRatePct, 33.33);
        assert.equal(r.marginOverBreakevenPct, 6.67);  // 40 − 33.33
    });
    it('flags a negative edge below break-even', () => {
        const r = calcExpectancy({winRate: 30, rrRatio: 2});
        assert.equal(r.edge, 'negative');
        assert.ok(r.expectancyR < 0);
    });
    it('derives $ risk from riskPct × balance and a %-per-trade expectancy', () => {
        const r = calcExpectancy({winRate: 50, rrRatio: 2, riskPct: 1, balance: 10000});
        assert.equal(r.riskPerTrade, 100);
        assert.equal(r.expectancyPctPerTrade, 0.5);    // 0.5R × 1%
    });
    it('rejects bad inputs', () => {
        assert.throws(() => calcExpectancy({winRate: 50, rrRatio: 0}), /rrRatio/);
        assert.throws(() => calcExpectancy({winRate: 120, rrRatio: 2}), /winRate/);
    });
});

describe('estimateLosingStreak — Nick Radge probabilistic estimate', () => {
    it("matches the video's numbers: 90%/1000→3, 90%/1M→6, 60%/1000→8", () => {
        assert.equal(estimateLosingStreak({winRate: 90, sampleSize: 1000}).maxLosingStreak, 3);
        assert.equal(estimateLosingStreak({winRate: 90, sampleSize: 1000000}).maxLosingStreak, 6);
        assert.equal(estimateLosingStreak({winRate: 60, sampleSize: 1000}).maxLosingStreak, 8);
    });
    it('returns a table across sample sizes', () => {
        const r = estimateLosingStreak({winRate: 60, sampleSize: 1000});
        assert.equal(r.table.length, 5);
        assert.equal(r.table.find((t) => t.sampleSize === 1000000).maxLosingStreak, 16);
    });
    it('adds the implied drawdown when riskPct is given', () => {
        const r = estimateLosingStreak({winRate: 60, sampleSize: 1000, riskPct: 2});
        assert.equal(r.streakDrawdownPctFixed, 16);    // 8 losses × 2%
        assert.ok(r.streakDrawdownPctCompounded < 16); // geometric is gentler
        assert.ok(r.streakDrawdownPctCompounded > 14);
    });
    it('rejects win rates at or beyond the bounds', () => {
        assert.throws(() => estimateLosingStreak({winRate: 100}), /strictly between/);
        assert.throws(() => estimateLosingStreak({winRate: 0}), /strictly between/);
    });
});

describe('simulateEquity — Monte Carlo (deterministic via injected rng)', () => {
    // rng that always wins (returns 0 < p) → every trade is a win, no drawdown, no ruin
    const alwaysWin = () => 0;
    // rng that always loses (returns ~1 ≥ p) → every trade loses
    const alwaysLose = () => 0.999999;
    it('all-wins run: positive return, zero drawdown, zero ruin', () => {
        const r = simulateEquity({winRate: 50, rrRatio: 2, riskPct: 1, trades: 100, runs: 5, _deps: {rng: alwaysWin}});
        assert.equal(r.ruinRunsPct, 0);
        assert.equal(r.maxDrawdownPct.worst, 0);
        assert.equal(r.profitableRunsPct, 100);
        assert.ok(r.finalReturnPct.median > 0);
    });
    it('all-losses run: every run ruined, longest streak = trade count', () => {
        const r = simulateEquity({winRate: 50, rrRatio: 2, riskPct: 2, trades: 50, runs: 5, ruinDrawdownPct: 50, _deps: {rng: alwaysLose}});
        assert.equal(r.ruinRunsPct, 100);
        assert.equal(r.profitableRunsPct, 0);
        assert.equal(r.longestLosingStreak.worst, 50);
    });
    it('caps trades and runs, echoes inputs', () => {
        const r = simulateEquity({winRate: 55, rrRatio: 1, trades: 999999, runs: 99999, _deps: {rng: alwaysWin}});
        assert.equal(r.inputs.trades, 100000);
        assert.equal(r.inputs.runs, 10000);
    });
    it('rejects bad inputs', () => {
        assert.throws(() => simulateEquity({winRate: 50, rrRatio: 0}), /rrRatio/);
        assert.throws(() => simulateEquity({winRate: 50, rrRatio: 2, riskPct: 0}), /riskPct/);
    });
});

// ── watchPrice — bounded WebSocket capture ──────────────────────────────────
// Fake WebSocket: delivers `messages` then optionally a close, all on a microtask.
function makeWS({messages = [], closeAfter = true} = {}) {
    const seen = {url: null};
    const cls = class {
        constructor(url) {
            seen.url = url;
            this._l = {};
            queueMicrotask(() => {
                for (const data of messages) (this._l.message || []).forEach((cb) => cb({data: JSON.stringify(data)}));
                if (closeAfter) (this._l.close || []).forEach((cb) => cb());
            });
        }

        addEventListener(ev, cb) {
            (this._l[ev] ||= []).push(cb);
        }

        close() {
        }
    };
    return {cls, seen};
}

// Timer deps that never auto-fire — the fake socket's close drives resolution.
const inertTimers = {
    setTimeout: () => 0, clearTimeout: () => {
    }
};

describe('watchPrice', () => {
    it('subscribes to the lowercase <symbol>@aggTrade stream on the futures host', async () => {
        const {cls, seen} = makeWS({messages: [{p: '64800.0', q: '1', T: 1}]});
        await watchPrice({market: 'futures', symbol: 'BTCUSDC', _deps: {WebSocket: cls, ...inertTimers}});
        assert.equal(seen.url, 'wss://fstream.binance.com/ws/btcusdc@aggTrade');
    });

    it('summarizes OHLC, change, VWAP and volume from the captured ticks', async () => {
        const messages = [
            {p: '100', q: '2', T: 10},
            {p: '110', q: '1', T: 20},
            {p: '90', q: '1', T: 30},
            {p: '105', q: '2', T: 40},
        ];
        const {cls} = makeWS({messages});
        const r = await watchPrice({market: 'spot', symbol: 'btcusdt', durationSec: 5, _deps: {WebSocket: cls, ...inertTimers}});
        assert.equal(r.success, true);
        assert.equal(r.symbol, 'BTCUSDT');
        assert.equal(r.ticks, 4);
        assert.equal(r.open, 100);
        assert.equal(r.close, 105);
        assert.equal(r.high, 110);
        assert.equal(r.low, 90);
        assert.equal(r.change, 5);
        assert.equal(r.changePct, '5.0000%');
        assert.equal(r.volume, 6);
        // VWAP = (100*2 + 110*1 + 90*1 + 105*2) / 6 = 610/6 ≈ 101.66666667
        assert.equal(r.vwap, 101.66666667);
        assert.equal(r.firstTradeTime, 10);
        assert.equal(r.lastTradeTime, 40);
    });

    it('clamps durationSec to [1,60]', async () => {
        const {cls} = makeWS({messages: [{p: '1', q: '1', T: 1}]});
        const hi = await watchPrice({symbol: 'BTCUSDC', durationSec: 999, _deps: {WebSocket: cls, ...inertTimers}});
        assert.equal(hi.durationSec, 60);
        const lo = await watchPrice({symbol: 'BTCUSDC', durationSec: 0, _deps: {WebSocket: cls, ...inertTimers}});
        assert.equal(lo.durationSec, 10); // 0 -> falls back to default 10
    });

    it('returns a note (not an error) when no trades arrive before the window ends', async () => {
        const {cls} = makeWS({messages: [], closeAfter: false});
        // setTimeout fires immediately to end the empty window.
        const r = await watchPrice({
            symbol: 'BTCUSDC', _deps: {
                WebSocket: cls, setTimeout: (fn) => {
                    fn();
                    return 0;
                }, clearTimeout: () => {
                }
            }
        });
        assert.equal(r.success, true);
        assert.equal(r.ticks, 0);
        assert.match(r.note, /No trades observed/);
        assert.equal(r.open, undefined);
    });

    it('rejects an unknown market', async () => {
        const {cls} = makeWS();
        await assert.rejects(
            watchPrice({market: 'nope', symbol: 'BTCUSDC', _deps: {WebSocket: cls, ...inertTimers}}),
            /unknown market/,
        );
    });
});

describe('watchOrderFlow', () => {
    it('builds a combined stream URL (trade + depth + bookTicker)', async () => {
        const {cls, seen} = makeWS({messages: [{data: {e: 'trade', p: '1', q: '1', m: false, T: 1}}]});
        await watchOrderFlow({market: 'futures', symbol: 'BTCUSDC', levels: 20, _deps: {WebSocket: cls, ...inertTimers}});
        // @trade (not @aggTrade): the futures @aggTrade stream intermittently delivers nothing.
        assert.equal(seen.url, 'wss://fstream.binance.com/stream?streams=btcusdc@trade/btcusdc@depth20@100ms/btcusdc@bookTicker');
    });

    it('summarizes aggression delta, spread and depth imbalance', async () => {
        const {cls} = makeWS({
            messages: [
                {data: {e: 'trade', p: '100', q: '2', m: false, T: 10}},
                {data: {e: 'trade', p: '101', q: '1', m: true, T: 11}},
                {data: {e: 'depthUpdate', b: [['100', '5'], ['99', '2']], a: [['101', '4'], ['102', '3']], E: 12}},
                {data: {s: 'BTCUSDC', b: '100', B: '1', a: '101', A: '1', E: 13}},
            ],
        });
        const r = await watchOrderFlow({symbol: 'BTCUSDC', _deps: {WebSocket: cls, ...inertTimers}});
        assert.equal(r.success, true);
        assert.equal(r.tradeTicks, 2);
        assert.equal(r.aggressiveBuyQty, 2);
        assert.equal(r.aggressiveSellQty, 1);
        assert.equal(r.deltaQty, 1);
        assert.equal(r.topOfBook.spread, 1);
        assert.equal(r.topOfBook.spreadBps, 100);
        assert.equal(r.depthImbalance.bidNotional, 698);
        assert.equal(r.depthImbalance.askNotional, 710);
        assert.equal(r.depthImbalance.imbalance, -0.0085);
    });
});

describe('getFootprintBars', () => {
    it('computes per-bar aggressive buy/sell quote flow and totals from extended klines', async () => {
        const kl = [
            [1, '100', '110', '95', '105', '10', 2, '1000', 12, '7', '700'],
            [2, '105', '108', '100', '101', '8', 3, '800', 10, '2', '200'],
        ];
        const r = await getFootprintBars({market: 'futures', symbol: 'BTCUSDC', interval: '1m', _deps: deps({'fapi/v1/klines': kl})});
        assert.equal(r.success, true);
        assert.equal(r.count, 2);
        assert.equal(r.bars[0].aggressiveBuyQuote, 700);
        assert.equal(r.bars[0].aggressiveSellQuote, 300);
        assert.equal(r.bars[0].flowTag, 'buyers_in_control');
        assert.equal(r.bars[1].deltaQuote, -400);
        assert.equal(r.bars[1].flowTag, 'sellers_in_control');
        assert.equal(r.totals.deltaQuote, 0);
        assert.equal(r.totals.buyShare, 50);
    });
});

describe('getVolatilityRegime', () => {
    it('returns a multi-timeframe realized-vol surface with regime and skew tags', async () => {
        const kl = [];
        let c = 100;
        for (let i = 0; i < 80; i++) {
            const o = c;
            c = i % 2 === 0 ? c * 1.01 : c * 0.992;
            const h = Math.max(o, c) * 1.003;
            const l = Math.min(o, c) * 0.997;
            kl.push([i, String(o), String(h), String(l), String(c), '10', i + 1, '1000', 20, '6', '600']);
        }
        const r = await getVolatilityRegime({
            market: 'futures', symbol: 'BTCUSDC', intervals: ['1m', '5m'], limit: 80,
            _deps: deps({'fapi/v1/klines': kl}),
        });
        assert.equal(r.success, true);
        assert.equal(r.symbol, 'BTCUSDC');
        assert.deepEqual(r.intervals, ['1m', '5m']);
        assert.equal(r.surface.length, 2);
        assert.ok(r.surface[0].realizedVolPct > 0);
        assert.ok(['extreme', 'high', 'moderate', 'low', 'insufficient_data'].includes(r.regime));
        assert.ok(['left_tail_heavy', 'right_tail_heavy', 'balanced', 'unknown'].includes(r.skewTag));
    });
});

describe('getOptionsSurface', () => {
    const optionsDeps = (exchangeInfo, marks, idx) => ({
        fetch: async (url) => {
            if (String(url).includes('/eapi/v1/exchangeInfo')) return {ok: true, status: 200, json: async () => exchangeInfo};
            if (String(url).includes('/eapi/v1/mark')) return {ok: true, status: 200, json: async () => marks};
            if (String(url).includes('/eapi/v1/index')) return {ok: true, status: 200, json: async () => idx};
            return {ok: true, status: 200, json: async () => ({})};
        },
    });

    it('builds an options IV surface and computes ATM call-put skew per expiry', async () => {
        const exchangeInfo = {
            optionSymbols: [
                {symbol: 'BTC-260626-60000-C', underlying: 'BTCUSDT', expiryDate: Date.UTC(2026, 5, 26), strikePrice: '60000', side: 'CALL'},
                {symbol: 'BTC-260626-60000-P', underlying: 'BTCUSDT', expiryDate: Date.UTC(2026, 5, 26), strikePrice: '60000', side: 'PUT'},
                {symbol: 'BTC-260926-65000-C', underlying: 'BTCUSDT', expiryDate: Date.UTC(2026, 8, 26), strikePrice: '65000', side: 'CALL'},
            ],
        };
        const marks = [
            {
                symbol: 'BTC-260626-60000-C',
                markIV: '0.55',
                bidIV: '0.54',
                askIV: '0.56',
                delta: '0.52',
                gamma: '0.01',
                theta: '-0.02',
                vega: '0.12',
                markPrice: '2200'
            },
            {
                symbol: 'BTC-260626-60000-P',
                markIV: '0.60',
                bidIV: '0.59',
                askIV: '0.61',
                delta: '-0.48',
                gamma: '0.01',
                theta: '-0.02',
                vega: '0.11',
                markPrice: '2400'
            },
            {
                symbol: 'BTC-260926-65000-C',
                markIV: '0.50',
                bidIV: '0.49',
                askIV: '0.51',
                delta: '0.35',
                gamma: '0.008',
                theta: '-0.015',
                vega: '0.10',
                markPrice: '1800'
            },
        ];
        const idx = {indexPrice: '60123.4'};
        const r = await getOptionsSurface({
            underlying: 'BTCUSDT',
            _deps: optionsDeps(exchangeInfo, marks, idx),
        });
        assert.equal(r.success, true);
        assert.equal(r.underlying, 'BTCUSDT');
        assert.equal(r.contracts, 3);
        assert.equal(r.expiries.length, 2);
        assert.equal(r.expiries[0].expiry, '20260626');
        assert.equal(r.expiries[0].atm.strike, 60000);
        assert.equal(r.expiries[0].atm.callIv, 0.55);
        assert.equal(r.expiries[0].atm.putIv, 0.6);
        assert.equal(r.expiries[0].atm.callPutSkew, -0.05);
    });

    it('filters requested expirations (YYYYMMDD)', async () => {
        const exchangeInfo = {
            optionSymbols: [
                {symbol: 'BTC-260626-60000-C', underlying: 'BTCUSDT', expiryDate: Date.UTC(2026, 5, 26), strikePrice: '60000', side: 'CALL'},
                {symbol: 'BTC-260926-60000-C', underlying: 'BTCUSDT', expiryDate: Date.UTC(2026, 8, 26), strikePrice: '60000', side: 'CALL'},
            ],
        };
        const marks = [
            {symbol: 'BTC-260626-60000-C', markIV: '0.55'},
            {symbol: 'BTC-260926-60000-C', markIV: '0.50'},
        ];
        const r = await getOptionsSurface({
            underlying: 'BTCUSDT', expirations: ['20260626'],
            _deps: optionsDeps(exchangeInfo, marks, {indexPrice: '60000'}),
        });
        assert.equal(r.success, true);
        assert.equal(r.contracts, 1);
        assert.equal(r.expiries.length, 1);
        assert.equal(r.expiries[0].expiry, '20260626');
    });

    it('omits the per-contract chain by default and includes it only with full:true', async () => {
        const exchangeInfo = {
            optionSymbols: [
                {symbol: 'BTC-260626-60000-C', underlying: 'BTCUSDT', expiryDate: Date.UTC(2026, 5, 26), strikePrice: '60000', side: 'CALL'},
            ],
        };
        const marks = [{symbol: 'BTC-260626-60000-C', markIV: '0.55'}];
        const dps = optionsDeps(exchangeInfo, marks, {indexPrice: '60000'});

        const summary = await getOptionsSurface({underlying: 'BTCUSDT', _deps: dps});
        assert.equal(summary.surface, undefined);
        assert.match(summary.surfaceOmitted, /1 contracts/);
        assert.equal(summary.expiries.length, 1); // summary is still present

        const full = await getOptionsSurface({underlying: 'BTCUSDT', full: true, _deps: dps});
        assert.equal(full.surfaceOmitted, undefined);
        assert.ok(Array.isArray(full.surface));
        assert.equal(full.surface.length, 1);
    });
});

// ── buildMarketStream — combined public-stream URL builder ──────────────────
describe('buildMarketStream', () => {
    it('builds a multiplexed combined-stream URL (symbols × streams) on the futures host', () => {
        const r = buildMarketStream({market: 'futures', symbols: 'BTCUSDC,ETHUSDC', streams: 'trade,bookTicker'});
        assert.equal(r.success, true);
        assert.deepEqual(r.subscriptions, ['btcusdc@trade', 'btcusdc@bookTicker', 'ethusdc@trade', 'ethusdc@bookTicker']);
        assert.equal(r.wsUrl, 'wss://fstream.binance.com/stream?streams=btcusdc@trade/btcusdc@bookTicker/ethusdc@trade/ethusdc@bookTicker');
    });

    it('accepts arrays, uppercases symbols, and de-duplicates subscriptions', () => {
        const r = buildMarketStream({market: 'spot', symbols: ['btcusdt', 'BTCUSDT'], streams: ['trade', 'trade']});
        assert.deepEqual(r.symbols, ['BTCUSDT']);
        assert.deepEqual(r.subscriptions, ['btcusdt@trade']);
        assert.match(r.wsUrl, /^wss:\/\/stream\.binance\.com:9443\/stream\?streams=btcusdt@trade$/);
    });

    it('maps kline[:interval] (default 1m) and folds funding into the markPrice stream', () => {
        const r = buildMarketStream({market: 'futures', symbols: 'BTCUSDC', streams: 'kline:5m,kline,markPrice,funding'});
        assert.deepEqual(r.subscriptions, ['btcusdc@kline_5m', 'btcusdc@kline_1m', 'btcusdc@markPrice@1s']);
    });

    it('rejects markPrice/funding on spot (futures-only) and unknown stream kinds', () => {
        assert.throws(() => buildMarketStream({market: 'spot', symbols: 'BTCUSDT', streams: 'markPrice'}), /futures-only/);
        assert.throws(() => buildMarketStream({market: 'spot', symbols: 'BTCUSDT', streams: 'funding'}), /futures-only/);
        assert.throws(() => buildMarketStream({market: 'futures', symbols: 'BTCUSDC', streams: 'depth'}), /unknown stream/);
    });

    it('requires symbols and an unknown market throws', () => {
        assert.throws(() => buildMarketStream({market: 'futures', symbols: '', streams: 'trade'}), /symbols is required/);
        assert.throws(() => buildMarketStream({market: 'nope', symbols: 'BTCUSDC'}), /unknown market/);
    });
});

// ── formatMarketEvent — compact normalization of stream payloads ────────────
describe('formatMarketEvent', () => {
    it('unwraps the combined-stream envelope and normalizes a trade', () => {
        const e = formatMarketEvent({stream: 'btcusdc@trade', data: {e: 'trade', s: 'BTCUSDC', p: '64800.0', q: '0.5', T: 10, m: true}});
        assert.deepEqual(e, {event: 'trade', symbol: 'BTCUSDC', price: 64800, qty: 0.5, time: 10, buyerMaker: true});
    });

    it('normalizes a 24hrTicker into a compact ticker line', () => {
        const e = formatMarketEvent({data: {e: '24hrTicker', s: 'BTCUSDC', c: '65000', P: '1.5', h: '66000', l: '64000', v: '100', q: '6500000'}});
        assert.deepEqual(e, {event: 'ticker', symbol: 'BTCUSDC', last: 65000, changePct: 1.5, high: 66000, low: 64000, volume: 100, quoteVolume: 6500000});
    });

    it('normalizes a markPriceUpdate including the funding rate', () => {
        const e = formatMarketEvent({data: {e: 'markPriceUpdate', s: 'BTCUSDC', p: '64810', i: '64800', r: '0.0001', T: 200, E: 100}});
        assert.deepEqual(e, {event: 'markPrice', symbol: 'BTCUSDC', mark: 64810, index: 64800, fundingRate: 0.0001, nextFundingTime: 200, time: 100});
    });

    it('normalizes a kline event from its k sub-object', () => {
        const e = formatMarketEvent({data: {e: 'kline', s: 'BTCUSDC', k: {i: '1m', o: '1', h: '3', l: '0.5', c: '2', v: '10', x: true, t: 1, T: 2}}});
        assert.deepEqual(e, {
            event: 'kline',
            symbol: 'BTCUSDC',
            interval: '1m',
            open: 1,
            high: 3,
            low: 0.5,
            close: 2,
            volume: 10,
            closed: true,
            openTime: 1,
            closeTime: 2
        });
    });

    it('detects spot bookTicker (no e field) by its b/a/s shape', () => {
        const e = formatMarketEvent({data: {u: 1, s: 'BTCUSDT', b: '64999', B: '1', a: '65001', A: '2'}});
        assert.equal(e.event, 'bookTicker');
        assert.equal(e.bid, 64999);
        assert.equal(e.ask, 65001);
    });

    it('falls back to {event,stream,raw} for unrecognized events', () => {
        const e = formatMarketEvent({stream: 'btcusdc@forceOrder', data: {e: 'forceOrder', o: {}}});
        assert.equal(e.event, 'forceOrder');
        assert.equal(e.stream, 'btcusdc@forceOrder');
        assert.ok(e.raw);
    });
});

// ── testnet switch ───────────────────────────────────────────────────────────
// The global BINANCE_TESTNET flag routes every market to its testnet host (and uses
// TESTNET credentials). _deps.testnet overrides the env for deterministic unit tests.
describe('testnet switch', () => {
    it('routes a public read to the testnet host with _deps.testnet', async () => {
        const _deps = {...deps(), testnet: true};
        await getTicker({market: 'futures', symbol: 'BTCUSDC', _deps});
        assert.match(_deps.fetch.calls[0].url, /testnet\.binancefuture\.com/);
    });

    it('routes a signed read to the testnet host', async () => {
        const _deps = {...deps({balance: []}), testnet: true};
        await getBalance({market: 'futures', _deps});
        const call = _deps.fetch.calls.find((c) => c.url.includes('/fapi/v2/balance'));
        assert.match(call.url, /testnet\.binancefuture\.com/);
    });

    it('uses the mainnet host without the switch', async () => {
        const _deps = deps();
        await getTicker({market: 'futures', symbol: 'BTCUSDC', _deps});
        assert.match(_deps.fetch.calls[0].url, /fapi\.binance\.com/);
        assert.ok(!_deps.fetch.calls[0].url.includes('testnet'));
    });

    it('placeOrder dry-run reports live_funds:false under the switch', async () => {
        const _deps = {...deps(), testnet: true};
        const r = await placeOrder({market: 'futures', symbol: 'BTCUSDC', side: 'SELL', type: 'LIMIT', quantity: 1, price: 64800, _deps});
        assert.equal(r.order_preview.live_funds, false);
    });

    it('getServerTime reports the testnet flag and routes to the testnet host', async () => {
        const _deps = {...deps({time: {serverTime: 1700000000000}}), testnet: true};
        const r = await getServerTime({market: 'futures', _deps});
        assert.equal(r.testnet, true);
        assert.match(_deps.fetch.calls.find((c) => c.url.includes('/v1/time')).url, /testnet\.binancefuture\.com/);
    });

    it('an explicit *-testnet market routes to testnet even without the global switch', async () => {
        const _deps = deps();
        await getTicker({market: 'futures-testnet', symbol: 'BTCUSDC', _deps});
        assert.match(_deps.fetch.calls[0].url, /testnet\.binancefuture\.com/);
    });

    it('BINANCE_TESTNET env reads TESTNET credentials and routes to the testnet host', async () => {
        const saved = {
            flag: process.env.BINANCE_TESTNET, key: process.env.BINANCE_TESTNET_API_KEY, secret: process.env.BINANCE_TESTNET_API_SECRET,
        };
        process.env.BINANCE_TESTNET = '1';
        process.env.BINANCE_TESTNET_API_KEY = 'tk';
        process.env.BINANCE_TESTNET_API_SECRET = 'ts';
        try {
            const base = mockFetch({balance: []});
            const headers = [];
            const fetch = async (url, opts = {}) => {
                headers.push(opts.headers?.['X-MBX-APIKEY']);
                return base(url, opts);
            };
            fetch.calls = base.calls;
            await getBalance({market: 'futures', _deps: {fetch, now: () => 1700000000000}});
            assert.ok(headers.includes('tk')); // signed with the TESTNET key, not BINANCE_API_KEY
            assert.match(fetch.calls.find((c) => c.url.includes('balance')).url, /testnet\.binancefuture\.com/);
        } finally {
            for (const [k, v] of [['BINANCE_TESTNET', saved.flag], ['BINANCE_TESTNET_API_KEY', saved.key], ['BINANCE_TESTNET_API_SECRET', saved.secret]]) {
                if (v === undefined) delete process.env[k]; else process.env[k] = v;
            }
        }
    });
});
