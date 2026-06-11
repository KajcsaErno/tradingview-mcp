/**
 * Unit tests for src/core/binance.js — orders: placeOrder, placeBracket,
 * placeLadder, modifyOrder, ensureProtectiveStop, cancels, hedge-mode,
 * post-only, precision, paper-trading, algo routing, COIN-M. Pure, no network.
 */
import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {
    adjustIsolatedMargin,
    cancelAlgoOrder,
    cancelAllOrders,
    ensureProtectiveStop,
    getBalance,
    getCommissionRate,
    getOpenOrders,
    getPositionMode,
    getPositions,
    getServerTime,
    getTicker,
    mirrorOrder,
    modifyOrder,
    placeBracket,
    placeLadder,
    placeOrder,
    planGrid,
    roundToFilters,
    transfer,
} from '../src/core/binance.js';
import {deps, FILTERS, mockFetch, posts} from './_binance_helpers.js';

// ── post-only enforcement ──────────────────────────────────────────────────
describe('placeOrder — post-only enforcement', () => {
    it('defaults a futures LIMIT to GTX (post-only)', async () => {
        const _deps = deps();
        const r = await placeOrder({market: 'futures', symbol: 'BTCUSDC', side: 'SELL', type: 'LIMIT', quantity: 1, price: 64800, _deps});
        assert.equal(r.dry_run, true);
        assert.equal(r.order_preview.timeInForce, 'GTX');
        assert.equal(r.order_preview.type, 'LIMIT');
    });

    it('uses LIMIT_MAKER (no timeInForce) for spot post-only', async () => {
        const _deps = deps();
        const r = await placeOrder({market: 'spot', symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', quantity: 1, price: 60000, _deps});
        assert.equal(r.order_preview.type, 'LIMIT_MAKER');
        assert.equal(r.order_preview.timeInForce, undefined);
    });

    it('postOnly:false restores GTC', async () => {
        const _deps = deps();
        const r = await placeOrder({market: 'futures', symbol: 'BTCUSDC', side: 'SELL', type: 'LIMIT', quantity: 1, price: 64800, postOnly: false, _deps});
        assert.equal(r.order_preview.timeInForce, 'GTC');
    });
});

// ── taker gate ──────────────────────────────────────────────────────────────
describe('placeOrder — taker gate', () => {
    it('blocks MARKET without allowTaker', async () => {
        await assert.rejects(
            placeOrder({market: 'futures', symbol: 'BTCUSDC', side: 'BUY', type: 'MARKET', quantity: 1, _deps: deps()}),
            /taker-only/,
        );
    });
    it('allows MARKET with allowTaker', async () => {
        const r = await placeOrder({market: 'futures', symbol: 'BTCUSDC', side: 'BUY', type: 'MARKET', quantity: 1, allowTaker: true, _deps: deps()});
        assert.equal(r.order_preview.type, 'MARKET');
    });
    it('blocks STOP_MARKET without allowTaker', async () => {
        await assert.rejects(
            placeOrder({market: 'futures', symbol: 'BTCUSDC', side: 'BUY', type: 'STOP_MARKET', stopPrice: 67500, closePosition: true, _deps: deps()}),
            /taker-only/,
        );
    });
});

// ── precision rounding ──────────────────────────────────────────────────────
describe('placeOrder — precision rounding', () => {
    it('snaps price to tick (round) and quantity to step (floor)', async () => {
        const _deps = deps();
        const r = await placeOrder({market: 'futures', symbol: 'BTCUSDC', side: 'SELL', type: 'LIMIT', quantity: 1.23456, price: 64801.07, _deps});
        assert.equal(r.order_preview.price, '64801.1'); // 0.10 tick, nearest
        assert.equal(r.order_preview.quantity, '1.234'); // 0.001 step, floored
    });
    it('round:false leaves values untouched and makes no network call', async () => {
        const _deps = deps();
        const r = await placeOrder({
            market: 'futures',
            symbol: 'BTCUSDC',
            side: 'SELL',
            type: 'LIMIT',
            quantity: 1.23456,
            price: 64801.07,
            round: false,
            _deps
        });
        assert.equal(r.order_preview.price, '64801.07');
        assert.equal(_deps.fetch.calls.length, 0);
    });
});

// ── dry-run vs confirm ──────────────────────────────────────────────────────
describe('placeOrder — dry-run never sends', () => {
    it('dry-run makes no POST', async () => {
        const _deps = deps();
        await placeOrder({market: 'futures', symbol: 'BTCUSDC', side: 'SELL', type: 'LIMIT', quantity: 1, price: 64800, _deps});
        assert.equal(posts(_deps.fetch).length, 0);
    });
    it('confirm POSTs to the order endpoint', async () => {
        const _deps = deps();
        const r = await placeOrder({
            market: 'futures',
            symbol: 'BTCUSDC',
            side: 'SELL',
            type: 'LIMIT',
            quantity: 1,
            price: 64800,
            positionSide: 'SHORT',
            confirm: true,
            _deps
        });
        assert.equal(r.success, true);
        const p = posts(_deps.fetch);
        assert.equal(p.length, 1);
        assert.match(p[0].url, /\/fapi\/v1\/order/);
    });
});

// ── paper-trading kill-switch ────────────────────────────────────────────────
// _deps.paperTrading:true forces every money-mover into dry-run, even with confirm:true.
const paperDeps = (routes) => ({...deps(routes), paperTrading: true});

describe('paper-trading kill-switch', () => {
    it('placeOrder with confirm:true sends nothing and flags paper_trading', async () => {
        const _deps = paperDeps();
        const r = await placeOrder({
            market: 'futures',
            symbol: 'BTCUSDC',
            side: 'SELL',
            type: 'LIMIT',
            quantity: 1,
            price: 64800,
            positionSide: 'SHORT',
            confirm: true,
            _deps
        });
        assert.equal(r.success, false);
        assert.equal(r.dry_run, true);
        assert.equal(r.paper_trading, true);
        assert.match(r.message, /PAPER TRADING/);
        assert.equal(posts(_deps.fetch).length, 0);
    });

    it('does NOT block a normal confirmed order when paper trading is off', async () => {
        const _deps = deps();
        const r = await placeOrder({
            market: 'futures',
            symbol: 'BTCUSDC',
            side: 'SELL',
            type: 'LIMIT',
            quantity: 1,
            price: 64800,
            positionSide: 'SHORT',
            confirm: true,
            _deps
        });
        assert.equal(r.success, true);
        assert.equal(r.paper_trading, undefined);
        assert.equal(posts(_deps.fetch).length, 1);
    });

    it('placeBracket confirm:true is suppressed and flagged', async () => {
        const _deps = paperDeps();
        const r = await placeBracket({
            market: 'futures',
            symbol: 'BTCUSDC',
            side: 'BUY',
            quantity: 1,
            entryType: 'MARKET',
            allowTaker: true,
            stopPrice: 59000,
            takeProfits: [{price: 65000}],
            hedge: false,
            confirm: true,
            _deps
        });
        assert.equal(r.dry_run, true);
        assert.equal(r.paper_trading, true);
        assert.equal(posts(_deps.fetch).length, 0);
    });

    it('placeLadder confirm:true places no rungs (no batchOrders POST)', async () => {
        const _deps = paperDeps();
        const r = await placeLadder({
            market: 'futures',
            symbol: 'BTCUSDC',
            side: 'BUY',
            lo: 60000,
            hi: 62000,
            count: 5,
            totalQuantity: 0.05,
            positionSide: 'LONG',
            confirm: true,
            _deps
        });
        assert.equal(r.dry_run, true);
        assert.equal(r.paper_trading, true);
        assert.equal(posts(_deps.fetch).length, 0);
    });

    it('cancelAllOrders confirm:true is suppressed (no DELETE)', async () => {
        const _deps = paperDeps();
        const r = await cancelAllOrders({market: 'futures', symbol: 'BTCUSDC', confirm: true, _deps});
        assert.equal(r.dry_run, true);
        assert.equal(r.paper_trading, true);
        assert.equal(_deps.fetch.calls.filter((c) => c.method === 'DELETE').length, 0);
    });

    it('transfer confirm:true moves nothing and flags paper_trading', async () => {
        const _deps = paperDeps();
        const r = await transfer({asset: 'USDC', amount: 10, from: 'spot', to: 'futures', confirm: true, _deps});
        assert.equal(r.dry_run, true);
        assert.equal(r.paper_trading, true);
        assert.equal(posts(_deps.fetch).length, 0);
    });

    it('mirrorOrder confirm:true places nothing across accounts', async () => {
        const _deps = paperDeps({'/fapi/v2/balance': [{asset: 'USDT', balance: '1000', availableBalance: '1000'}]});
        const r = await mirrorOrder({
            accounts: ['1', '2'],
            market: 'futures',
            symbol: 'BTCUSDC',
            side: 'BUY',
            type: 'LIMIT',
            quantity: 1,
            price: 60000,
            positionSide: 'LONG',
            confirm: true,
            _deps
        });
        assert.equal(r.dry_run, true);
        assert.equal(r.paper_trading, true);
        assert.equal(posts(_deps.fetch).length, 0);
    });
});

// ── hedge mode ──────────────────────────────────────────────────────────────
describe('placeOrder — hedge mode', () => {
    it('throws on confirm in hedge mode when positionSide is omitted', async () => {
        const _deps = deps({'positionSide/dual': {dualSidePosition: true}});
        await assert.rejects(
            placeOrder({market: 'futures', symbol: 'BTCUSDC', side: 'BUY', type: 'LIMIT', quantity: 1, price: 60000, confirm: true, _deps}),
            /Hedge Mode/,
        );
    });
    it('sets positionSide and strips reduceOnly when positionSide given', async () => {
        const _deps = deps();
        const r = await placeOrder({
            market: 'futures',
            symbol: 'BTCUSDC',
            side: 'BUY',
            type: 'LIMIT',
            quantity: 1,
            price: 60000,
            positionSide: 'LONG',
            reduceOnly: true,
            _deps
        });
        assert.equal(r.order_preview.positionSide, 'LONG');
        assert.equal(r.order_preview.reduceOnly, undefined);
    });
});

// ── bracket ─────────────────────────────────────────────────────────────────
describe('placeBracket', () => {
    it('builds entry(GTX) + stop(closePosition) + 2 reduceOnly TPs (one-way)', async () => {
        const _deps = deps();
        const r = await placeBracket({
            market: 'futures', symbol: 'BTCUSDC', side: 'SELL', quantity: 1,
            entryType: 'LIMIT', entryPrice: 64800, stopPrice: 67500,
            takeProfits: [{price: 61300, quantity: 0.5}, {price: 60000, quantity: 0.5}],
            allowTaker: true, _deps,
        });
        const byLeg = Object.fromEntries(r.legs.map((l) => [l.leg, l]));
        assert.equal(byLeg.entry.timeInForce, 'GTX');
        assert.equal(byLeg.entry.side, 'SELL');
        assert.equal(byLeg.stop.type, 'STOP_MARKET');
        assert.equal(byLeg.stop.side, 'BUY');
        assert.equal(byLeg.stop.closePosition, 'true');
        assert.equal(byLeg.tp1.reduceOnly, 'true');
        assert.equal(byLeg.tp1.side, 'BUY');
    });

    it('hedge:true puts positionSide on every leg and drops reduceOnly', async () => {
        const _deps = deps();
        const r = await placeBracket({
            market: 'futures', symbol: 'BTCUSDC', side: 'SELL', quantity: 1,
            entryType: 'LIMIT', entryPrice: 64800, stopPrice: 67500,
            takeProfits: [{price: 61300, quantity: 0.5}, {price: 60000, quantity: 0.5}],
            allowTaker: true, hedge: true, _deps,
        });
        assert.equal(r.hedgeMode, true);
        for (const leg of r.legs) assert.equal(leg.positionSide, 'SHORT');
        assert.equal(r.legs.find((l) => l.leg === 'tp1').reduceOnly, undefined);
    });

    it('rejects multiple take-profits without per-leg quantity', async () => {
        await assert.rejects(
            placeBracket({
                market: 'futures',
                symbol: 'BTCUSDC',
                side: 'SELL',
                quantity: 1,
                includeEntry: false,
                takeProfits: [{price: 61300}, {price: 60000}],
                allowTaker: true,
                _deps: deps()
            }),
            /each must have its own quantity/,
        );
    });

    it('blocks taker legs (stop) without allowTaker', async () => {
        await assert.rejects(
            placeBracket({market: 'futures', symbol: 'BTCUSDC', side: 'SELL', quantity: 1, includeEntry: false, stopPrice: 67500, _deps: deps()}),
            /taker-only legs/,
        );
    });
});

// ── reads + cancel-all guard ────────────────────────────────────────────────
describe('reads and guards', () => {
    it('getPositionMode parses dualSidePosition', async () => {
        const r = await getPositionMode({market: 'futures', _deps: deps({'positionSide/dual': {dualSidePosition: true}})});
        assert.equal(r.hedgeMode, true);
    });
    it('getCommissionRate parses maker/taker', async () => {
        const _deps = deps({commissionRate: {makerCommissionRate: '0.000000', takerCommissionRate: '0.000400'}});
        const r = await getCommissionRate({market: 'futures', symbol: 'BTCUSDC', _deps});
        assert.equal(r.makerCommissionRate, '0.000000');
    });
    it('roundToFilters snaps both fields', async () => {
        const r = await roundToFilters({market: 'futures', symbol: 'BTCUSDC', price: 64801.07, quantity: 1.23456, _deps: deps()});
        assert.equal(r.price, 64801.1);
        assert.equal(r.quantity, 1.234);
    });
    it('getServerTime computes a round-trip-adjusted offset', async () => {
        let t = 1000;
        const fetch = mockFetch({'/fapi/v1/time': {serverTime: 6000}});
        const r = await getServerTime({market: 'futures', _deps: {fetch, keys: {key: 'k', secret: 's'}, now: () => (t += 100)}});
        // local midpoint between the two now() reads (1100,1200) = 1150 → offset 6000-1150
        assert.equal(r.offsetMs, 4850);
    });

    it('resyncs clock and retries once on a -1021 timestamp error', async () => {
        let firstOrder = true;
        const calls = [];
        const fetch = async (url, opts = {}) => {
            calls.push({url, method: opts.method || 'GET'});
            if (url.includes('/fapi/v1/time')) return {ok: true, status: 200, json: async () => ({serverTime: 1700000005000})};
            if (url.includes('exchangeInfo')) return {ok: true, status: 200, json: async () => FILTERS};
            if (url.includes('positionSide/dual')) return {ok: true, status: 200, json: async () => ({dualSidePosition: false})};
            if (url.includes('/fapi/v1/order')) {
                if (firstOrder) {
                    firstOrder = false;
                    return {ok: false, status: 400, json: async () => ({code: -1021, msg: 'timestamp'})};
                }
                return {ok: true, status: 200, json: async () => ({orderId: 9, status: 'NEW'})};
            }
            return {ok: true, status: 200, json: async () => ({})};
        };
        const r = await placeOrder({
            market: 'futures',
            symbol: 'BTCUSDC',
            side: 'SELL',
            type: 'LIMIT',
            quantity: 1,
            price: 64800,
            positionSide: 'SHORT',
            confirm: true,
            _deps: {fetch, keys: {key: 'k', secret: 's'}, now: () => 1700000000000}
        });
        assert.equal(r.success, true);
        assert.ok(calls.some((c) => c.url.includes('/fapi/v1/time')), 'should have hit the time endpoint to resync');
        assert.equal(calls.filter((c) => c.url.includes('/fapi/v1/order')).length, 2, 'should retry the order once');
    });

    it('cancelAllOrders is dry-run without confirm and sends a DELETE with confirm', async () => {
        const dry = await cancelAllOrders({market: 'futures', symbol: 'BTCUSDC', _deps: deps()});
        assert.equal(dry.dry_run, true);
        const _deps = deps();
        const real = await cancelAllOrders({market: 'futures', symbol: 'BTCUSDC', confirm: true, _deps});
        assert.equal(real.success, true);
        assert.ok(_deps.fetch.calls.some((c) => c.method === 'DELETE'));
    });
});

// ── COIN-M (reads only) ─────────────────────────────────────────────────────
describe('COIN-M futures', () => {
    const coinmDeps = (routes) => ({fetch: mockFetch(routes), keys: {key: 'k', secret: 's'}, now: () => 1});

    it('getBalance routes to /dapi/v1/balance on dapi host', async () => {
        const _deps = coinmDeps({'/dapi/v1/balance': [{asset: 'BTC', balance: '1.5', availableBalance: '1.2'}]});
        const r = await getBalance({market: 'coinm', _deps});
        assert.equal(r.balances[0].asset, 'BTC');
        assert.ok(_deps.fetch.calls.some((c) => c.url.includes('dapi.binance.com/dapi/v1/balance')));
    });

    it('getPositions routes to /dapi/v1/positionRisk', async () => {
        const _deps = coinmDeps({
            '/dapi/v1/positionRisk': [{
                symbol: 'BTCUSD_PERP',
                positionAmt: '-2',
                entryPrice: '64000',
                markPrice: '63000',
                unRealizedProfit: '3',
                leverage: '5'
            }]
        });
        const r = await getPositions({market: 'coinm', _deps});
        assert.equal(r.positions[0].side, 'SHORT');
        assert.ok(_deps.fetch.calls.some((c) => c.url.includes('/dapi/v1/positionRisk')));
    });

    it('getTicker handles the COIN-M array response', async () => {
        const _deps = coinmDeps({'/dapi/v1/ticker/price': [{symbol: 'BTCUSD_PERP', ps: 'BTCUSD', price: '64000.0'}]});
        const r = await getTicker({market: 'coinm', symbol: 'BTCUSD_PERP', _deps});
        assert.equal(r.price, '64000.0');
        assert.equal(r.symbol, 'BTCUSD_PERP');
    });

    it('places a COIN-M order: post-only GTX, contracts note, routed to /dapi/v1/order', async () => {
        const _deps = deps();
        const r = await placeOrder({
            market: 'coinm',
            symbol: 'BTCUSD_PERP',
            side: 'SELL',
            type: 'LIMIT',
            quantity: 2,
            price: 64000.07,
            positionSide: 'SHORT',
            confirm: true,
            _deps
        });
        assert.equal(r.success, true);
        assert.ok(_deps.fetch.calls.some((c) => c.method === 'POST' && c.url.includes('dapi.binance.com/dapi/v1/order')));
    });

    it('COIN-M order preview is GTX with a CONTRACTS note', async () => {
        const r = await placeOrder({
            market: 'coinm',
            symbol: 'BTCUSD_PERP',
            side: 'SELL',
            type: 'LIMIT',
            quantity: 2,
            price: 64000,
            positionSide: 'SHORT',
            _deps: deps()
        });
        assert.equal(r.order_preview.timeInForce, 'GTX');
        assert.equal(r.order_preview.positionSide, 'SHORT');
        assert.match(r.coinm_note, /CONTRACTS/);
    });

    it('COIN-M bracket places every leg to /dapi/v1/order', async () => {
        const _deps = deps();
        const r = await placeBracket({
            market: 'coinm',
            symbol: 'BTCUSD_PERP',
            side: 'SELL',
            quantity: 2,
            stopPrice: 67000,
            takeProfits: [{price: 61000, quantity: 2}],
            allowTaker: true,
            hedge: true,
            confirm: true,
            _deps
        });
        assert.equal(r.success, true);
        assert.ok(_deps.fetch.calls.filter((c) => c.method === 'POST').every((c) => c.url.includes('/dapi/v1/order')));
        assert.ok(r.legs.every((l) => l.params.positionSide === 'SHORT'));
    });
});

// ── Conditional orders → Algo endpoint (Binance 2025-12-09 migration) ────────
describe('conditional orders use the Algo endpoint', () => {
    it('USD-M STOP_MARKET previews to /fapi/v1/algoOrder with triggerPrice (not stopPrice)', async () => {
        const r = await placeOrder({
            market: 'futures',
            symbol: 'BTCUSDC',
            side: 'SELL',
            type: 'STOP_MARKET',
            stopPrice: 58900,
            closePosition: true,
            positionSide: 'LONG',
            allowTaker: true,
            _deps: deps()
        });
        assert.match(r.order_preview.endpoint, /\/fapi\/v1\/algoOrder/);
        assert.equal(r.order_preview.algoType, 'CONDITIONAL');
        assert.equal(r.order_preview.triggerPrice, '58900');
        assert.equal(r.order_preview.stopPrice, undefined);
    });

    it('confirm POSTs a STOP_MARKET to the algo endpoint and flags algo:true', async () => {
        const _deps = deps({'/fapi/v1/algoOrder': {algoId: 222, algoStatus: 'NEW'}});
        const r = await placeOrder({
            market: 'futures',
            symbol: 'BTCUSDC',
            side: 'SELL',
            type: 'STOP_MARKET',
            stopPrice: 58900,
            closePosition: true,
            positionSide: 'LONG',
            allowTaker: true,
            confirm: true,
            _deps
        });
        assert.equal(r.success, true);
        assert.equal(r.algo, true);
        assert.ok(posts(_deps.fetch).some((c) => c.url.includes('/fapi/v1/algoOrder')));
    });

    it('getOpenOrders merges regular + algo orders', async () => {
        const _deps = deps({'/fapi/v1/openOrders': [{orderId: 1, type: 'LIMIT'}], '/fapi/v1/openAlgoOrders': [{algoId: 9, orderType: 'STOP_MARKET'}]});
        const r = await getOpenOrders({market: 'futures', symbol: 'BTCUSDC', _deps});
        assert.equal(r.count, 2);
        assert.equal(r.algoOrders.length, 1);
        assert.equal(r.algoOrders[0].algoId, 9);
    });

    it('cancelAlgoOrder DELETEs the algo endpoint by algoId', async () => {
        const _deps = deps({'/fapi/v1/algoOrder': {algoId: 9, algoStatus: 'CANCELED'}});
        const r = await cancelAlgoOrder({market: 'futures', algoId: 9, _deps});
        assert.equal(r.success, true);
        assert.ok(_deps.fetch.calls.some((c) => c.method === 'DELETE' && c.url.includes('/fapi/v1/algoOrder')));
    });
});

// ── tools borrowed from muvon/mcp-binance-futures ────────────────────────────
describe('modifyOrder', () => {
    it('dry-run previews a PUT and sends nothing', async () => {
        const _deps = deps();
        const r = await modifyOrder({market: 'futures', symbol: 'BTCUSDC', orderId: 5, side: 'BUY', quantity: 0.033, price: 60123.07, _deps});
        assert.equal(r.dry_run, true);
        assert.equal(r.modify_preview.price, '60123.1'); // snapped to 0.10 tick
        assert.equal(r.modify_preview.quantity, '0.033');
        assert.equal(_deps.fetch.calls.filter((c) => c.method === 'PUT').length, 0);
    });
    it('confirm sends a PUT to the order endpoint', async () => {
        const _deps = deps();
        const r = await modifyOrder({market: 'futures', symbol: 'BTCUSDC', orderId: 5, side: 'BUY', quantity: 0.033, price: 60100, confirm: true, _deps});
        assert.equal(r.success, true);
        const put = _deps.fetch.calls.find((c) => c.method === 'PUT');
        assert.ok(put);
        assert.match(put.url, /\/fapi\/v1\/order/);
    });
    it('requires a valid side', async () => {
        await assert.rejects(modifyOrder({market: 'futures', symbol: 'BTCUSDC', orderId: 5, quantity: 1, price: 1, _deps: deps()}), /side must be/);
    });
});

// ── ladder / ensure-stop ──────────────────────────────────────────────────────
describe('placeLadder', () => {
    it('dry-run builds the plan and sends nothing', async () => {
        const _deps = deps();
        const r = await placeLadder({market: 'futures', symbol: 'BTCUSDC', side: 'BUY', lo: 60000, hi: 61000, count: 4, totalNotional: 4000, _deps});
        assert.equal(r.dry_run, true);
        assert.equal(r.ladder_preview.rungs, 4);
        assert.equal(r.ladder_preview.timeInForce, 'GTX (post-only)');
        assert.ok(r.ladder_preview.avgPrice > 60000 && r.ladder_preview.avgPrice < 61000);
        assert.equal(posts(_deps.fetch).length, 0);
    });
    it('requires exactly one of totalNotional / totalQuantity', async () => {
        await assert.rejects(placeLadder({market: 'futures', symbol: 'BTCUSDC', side: 'BUY', lo: 60000, hi: 61000, count: 4, _deps: deps()}), /exactly one/);
        await assert.rejects(placeLadder({
            market: 'futures',
            symbol: 'BTCUSDC',
            side: 'BUY',
            lo: 60000,
            hi: 61000,
            count: 4,
            totalNotional: 1000,
            totalQuantity: 1,
            _deps: deps()
        }), /exactly one/);
    });
    it('confirm places rungs via the batchOrders endpoint', async () => {
        const _deps = deps({batchOrders: [{orderId: 1}, {orderId: 2}, {orderId: 3}, {orderId: 4}]});
        const r = await placeLadder({
            market: 'futures',
            symbol: 'BTCUSDC',
            side: 'BUY',
            lo: 60000,
            hi: 61000,
            count: 4,
            totalNotional: 4000,
            confirm: true,
            _deps
        });
        assert.equal(r.success, true);
        assert.equal(r.placed, 4);
        const batch = posts(_deps.fetch).filter((c) => /batchOrders/.test(c.url));
        assert.equal(batch.length, 1); // 4 rungs → one chunk of 5
    });
    it('warns (3x rule) when total notional exceeds account equity × 3', async () => {
        // equity 10000 → 3x cap = 30000; ladder notional ≈ 60500 → ~6x
        const _deps = deps({'fapi/v2/account': {totalMarginBalance: '10000', totalMaintMargin: '0'}});
        const r = await placeLadder({market: 'futures', symbol: 'BTCUSDC', side: 'BUY', lo: 60000, hi: 61000, count: 4, totalNotional: 60500, _deps});
        assert.ok(r.ladder_preview.impliedAccountLeverage > 3);
        assert.ok((r.ladder_preview.warnings || []).some((w) => /3x rule/.test(w)));
    });
    it('seed "min" resolves to the exchange minimum (minQty / minNotional)', async () => {
        // BTCUSDC mock: minQty 0.001, minNotional 50, stepSize 0.001. At ~60k, minQty alone clears notional.
        const _deps = deps({bookTicker: {symbol: 'BTCUSDC', bidPrice: '60000', askPrice: '60001'}});
        const r = await placeLadder({
            market: 'futures',
            symbol: 'BTCUSDC',
            side: 'SELL',
            lo: 61500,
            hi: 66400,
            count: 50,
            totalNotional: 50000,
            positionSide: 'SHORT',
            seedQuantity: 'min',
            stop: 67750,
            _deps
        });
        assert.equal(r.ladder_preview.seed.quantity, 0.001);
    });
    it('seed "min" bumps above minQty when minNotional requires it', async () => {
        // minNotional 50 at a $5 price ⇒ need 10 units; minQty 0.001 is far too small.
        const cheap = {
            symbols: [{
                symbol: 'CHEAPUSDC', status: 'TRADING', pricePrecision: 2, quantityPrecision: 1,
                filters: [{filterType: 'PRICE_FILTER', tickSize: '0.01'}, {filterType: 'LOT_SIZE', stepSize: '0.1', minQty: '0.1'}, {
                    filterType: 'MIN_NOTIONAL',
                    notional: '50'
                }]
            }]
        };
        const _deps = deps({exchangeInfo: cheap, bookTicker: {symbol: 'CHEAPUSDC', bidPrice: '5', askPrice: '5.01'}});
        const r = await placeLadder({
            market: 'futures',
            symbol: 'CHEAPUSDC',
            side: 'SELL',
            lo: 6,
            hi: 8,
            count: 4,
            totalNotional: 400,
            positionSide: 'SHORT',
            seedQuantity: 'min',
            _deps
        });
        assert.equal(r.ladder_preview.seed.quantity, 10); // 50 / 5 = 10, snapped up to 0.1 step
    });
});

describe('planGrid', () => {
    it('is a pure planner — sends no orders, classifies levels around current price', async () => {
        const _deps = deps({bookTicker: {symbol: 'BTCUSDC', bidPrice: '60500', askPrice: '60501'}});
        const r = await planGrid({market: 'futures', symbol: 'BTCUSDC', lower: 60000, upper: 61000, count: 11, totalNotional: 11000, _deps});
        assert.equal(r.success, true);
        assert.equal(r.planner_only, true);
        assert.equal(r.levels, 11); // step 100, all clear minQty
        assert.equal(r.buyLevels, 5);  // 60000..60400 below mid 60500.5
        assert.equal(r.sellLevels, 5); // 60600..61000 above
        assert.ok(r.grid.some((l) => l.side === 'SKIP')); // 60500 sits within half a step of mid
        assert.equal(posts(_deps.fetch).length, 0);
    });
    it('requires exactly one of totalNotional / totalQuantity', async () => {
        await assert.rejects(planGrid({symbol: 'BTCUSDC', lower: 60000, upper: 61000, _deps: deps()}), /exactly one/);
        await assert.rejects(planGrid({symbol: 'BTCUSDC', lower: 60000, upper: 61000, totalNotional: 1000, totalQuantity: 1, _deps: deps()}), /exactly one/);
    });
    it('rejects count < 2 and inverted ranges', async () => {
        await assert.rejects(planGrid({symbol: 'BTCUSDC', lower: 60000, upper: 61000, count: 1, totalNotional: 1000, _deps: deps()}), /count must be >= 2/);
        await assert.rejects(planGrid({symbol: 'BTCUSDC', lower: 61000, upper: 60000, totalNotional: 1000, _deps: deps()}), /lower must be < upper/);
    });
    it('mode "neutral" is futures-only', async () => {
        await assert.rejects(planGrid({
            market: 'spot',
            symbol: 'BTCUSDC',
            lower: 60000,
            upper: 61000,
            totalNotional: 1000,
            mode: 'neutral',
            _deps: deps()
        }), /futures-only/);
    });
    it('warns when spacing does not cover the round-trip fee', async () => {
        // step 100 at ~60.5k ⇒ spacing ≈ 0.165%; 2 × 0.1% fee = 0.2% ⇒ losing grid
        const _deps = deps({bookTicker: {symbol: 'BTCUSDC', bidPrice: '60500', askPrice: '60501'}});
        const r = await planGrid({symbol: 'BTCUSDC', lower: 60000, upper: 61000, count: 11, totalNotional: 11000, feePct: 0.1, _deps});
        assert.ok(r.economics.profitPerGridPct < 0);
        assert.ok((r.warnings || []).some((w) => /LOSE money/.test(w)));
    });
    it('warns when current price is outside the grid range', async () => {
        const _deps = deps({bookTicker: {symbol: 'BTCUSDC', bidPrice: '59000', askPrice: '59001'}});
        const r = await planGrid({symbol: 'BTCUSDC', lower: 60000, upper: 61000, count: 5, totalNotional: 5000, _deps});
        assert.ok((r.warnings || []).some((w) => /OUTSIDE/.test(w)));
    });
    it('warns (3x rule) when total notional exceeds account equity × 3', async () => {
        const _deps = deps({
            'fapi/v2/account': {totalMarginBalance: '10000', totalMaintMargin: '0'},
            bookTicker: {symbol: 'BTCUSDC', bidPrice: '60500', askPrice: '60501'},
        });
        const r = await planGrid({symbol: 'BTCUSDC', lower: 60000, upper: 61000, count: 11, totalNotional: 60500, _deps});
        assert.ok(r.impliedAccountLeverage > 3);
        assert.ok((r.warnings || []).some((w) => /3x rule/.test(w)));
    });
});

describe('ensureProtectiveStop', () => {
    it('does nothing when a closePosition stop already rests', async () => {
        const _deps = deps({
            openAlgoOrders: [{algoId: 7, orderType: 'STOP_MARKET', closePosition: true, triggerPrice: '58900', positionSide: 'LONG'}],
            openOrders: []
        });
        const r = await ensureProtectiveStop({market: 'futures', symbol: 'BTCUSDC', stop: 58900, _deps});
        assert.equal(r.action, 'none');
        assert.equal(r.exists, true);
        assert.equal(posts(_deps.fetch).length, 0);
    });
    it('dry-run when a position has no stop', async () => {
        const _deps = deps({
            openOrders: [],
            openAlgoOrders: [],
            positionRisk: [{symbol: 'BTCUSDC', positionAmt: '1.6', entryPrice: '60000', markPrice: '59000', unRealizedProfit: '-1600', leverage: '3'}]
        });
        const r = await ensureProtectiveStop({market: 'futures', symbol: 'BTCUSDC', stop: 58900, _deps});
        assert.equal(r.dry_run, true);
        assert.equal(r.action, 'would_place');
        assert.equal(r.stop_preview.side, 'SELL');
        assert.equal(r.stop_preview.positionSide, 'LONG');
    });
    it('confirm places a closePosition STOP_MARKET via the algo endpoint', async () => {
        const _deps = deps({
            openOrders: [],
            openAlgoOrders: [],
            positionRisk: [{symbol: 'BTCUSDC', positionAmt: '1.6', entryPrice: '60000', markPrice: '59000', unRealizedProfit: '-1600', leverage: '3'}],
            algoOrder: {algoId: 555}
        });
        const r = await ensureProtectiveStop({market: 'futures', symbol: 'BTCUSDC', stop: 58900, confirm: true, _deps});
        assert.equal(r.action, 'placed');
        assert.equal(r.stop.algoId, 555);
        assert.ok(posts(_deps.fetch).some((c) => /algoOrder/.test(c.url)));
    });
    it('warns when there is no position and no stop', async () => {
        const _deps = deps({openOrders: [], openAlgoOrders: [], positionRisk: []});
        const r = await ensureProtectiveStop({market: 'futures', symbol: 'BTCUSDC', stop: 58900, _deps});
        assert.equal(r.success, false);
        assert.match(r.warning, /no open position/);
    });
});

// ── isolated-margin adjustment (borrowed from muvon/mcp-binance-futures) ──────
describe('adjustIsolatedMargin', () => {
    it('dry-run previews type=1 (add) and sends nothing', async () => {
        const _deps = deps();
        const r = await adjustIsolatedMargin({market: 'futures', symbol: 'BTCUSDC', amount: 25, direction: 'add', _deps});
        assert.equal(r.dry_run, true);
        assert.equal(r.margin_preview.type, '1');
        assert.equal(r.margin_preview.amount, '25');
        assert.match(r.margin_preview.endpoint, /\/fapi\/v1\/positionMargin/);
        assert.equal(posts(_deps.fetch).length, 0);
    });
    it('confirm POSTs type=2 (remove) to positionMargin', async () => {
        const _deps = deps({positionMargin: {code: 200, msg: 'success', amount: 25, type: 2}});
        const r = await adjustIsolatedMargin({
            market: 'futures',
            symbol: 'BTCUSDC',
            amount: 25,
            direction: 'remove',
            positionSide: 'LONG',
            confirm: true,
            _deps
        });
        assert.equal(r.success, true);
        assert.equal(r.action, 'remove');
        assert.equal(r.positionSide, 'LONG');
        const p = posts(_deps.fetch);
        assert.equal(p.length, 1);
        assert.match(p[0].url, /\/fapi\/v1\/positionMargin/);
        assert.match(p[0].url, /type=2/);
        assert.match(p[0].url, /positionSide=LONG/);
    });
    it('COIN-M routes to /dapi', async () => {
        const _deps = deps({positionMargin: {code: 200}});
        await adjustIsolatedMargin({market: 'coinm', symbol: 'BTCUSD_PERP', amount: 1, positionSide: 'SHORT', confirm: true, _deps});
        assert.match(posts(_deps.fetch)[0].url, /\/dapi\/v1\/positionMargin/);
    });
    it('throws on confirm in Hedge Mode when positionSide is omitted', async () => {
        const _deps = deps({'positionSide/dual': {dualSidePosition: true}});
        await assert.rejects(
            adjustIsolatedMargin({market: 'futures', symbol: 'BTCUSDC', amount: 25, confirm: true, _deps}),
            /Hedge Mode/,
        );
    });
    it('rejects a non-positive amount and a bad direction', async () => {
        await assert.rejects(adjustIsolatedMargin({symbol: 'BTCUSDC', amount: 0, _deps: deps()}), /amount must be > 0/);
        await assert.rejects(adjustIsolatedMargin({symbol: 'BTCUSDC', amount: 5, direction: 'sideways', _deps: deps()}), /direction must be/);
    });
    it('is futures-only', async () => {
        await assert.rejects(adjustIsolatedMargin({market: 'spot', symbol: 'BTCUSDC', amount: 5, _deps: deps()}), /futures-only/);
    });
});
