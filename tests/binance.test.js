/**
 * Unit tests for src/core/binance.js — pure, no network.
 * Injects _deps.fetch / _deps.keys / _deps.now to assert on the exact requests
 * built and the dry-run/guard behavior (matches the repo's _deps DI convention).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  placeOrder, placeBracket, cancelAllOrders, getPositionMode,
  getCommissionRate, roundToFilters, getServerTime, getBalance, getTicker, getPositions,
  transfer, getTransferHistory, getOpenOrders, cancelAlgoOrder,
  mirrorOrder, mirrorBracket,
  setLeverage, setMarginType, getOrder, getAccountTrades, cancelOrder, getHistoricalTrades,
  getKlines, get24hrTicker, getBookTicker, getAvgPrice, getRollingWindowTicker,
  setPositionMode, modifyOrder, getOrderHistory, getLeverageBrackets, getAccountSummary,
  placeLadder, ensureProtectiveStop, adjustIsolatedMargin, getFundingRate, getIncome, getAccountSnapshot,
  calcPositionSize, getRiskReport,
  calcExpectancy, estimateLosingStreak, simulateEquity,
  getUiKlines, getTradingDayTicker, startUserStream, keepAliveUserStream, closeUserStream,
  watchPrice, watchOrderFlow, getFootprintBars, getVolatilityRegime, getOptionsSurface,
  compareSymbols, buildMarketStream, formatMarketEvent,
  getLiquidationHistory, getDepositHistory, getWithdrawHistory, getDepositAddress,
  getTechnicals, correlateSymbols,
  backtestStrategy, compareStrategies, walkForwardBacktest,
  getMultiTimeframe, scanSignals, detectCandlestickPatterns,
  STRATEGY_KEYS, SCAN_SIGNAL_KEYS, getSignal,
} from '../src/core/binance.js';

// ── Mocks ────────────────────────────────────────────────────────────────
const FILTERS = {
  symbols: [
    ...['BTCUSDC', 'BTCUSDT'].map((symbol) => ({
      symbol, status: 'TRADING', pricePrecision: 2, quantityPrecision: 3,
      filters: [
        { filterType: 'PRICE_FILTER', tickSize: '0.10' },
        { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001' },
        { filterType: 'MIN_NOTIONAL', notional: '50' },
      ],
    })),
    // COIN-M contract: quantity in whole contracts (stepSize 1), $100 notional each.
    {
      symbol: 'BTCUSD_PERP', status: 'TRADING', pricePrecision: 1, quantityPrecision: 0, contractSize: 100,
      filters: [
        { filterType: 'PRICE_FILTER', tickSize: '0.1' },
        { filterType: 'LOT_SIZE', stepSize: '1', minQty: '1' },
      ],
    },
  ],
};

function mockFetch(routes = {}) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET' });
    const merged = { exchangeInfo: FILTERS, 'positionSide/dual': { dualSidePosition: false }, ...routes };
    for (const [substr, data] of Object.entries(merged)) {
      if (url.includes(substr)) return { ok: true, status: 200, json: async () => data };
    }
    return { ok: true, status: 200, json: async () => ({ orderId: 1, status: 'NEW' }) };
  };
  fn.calls = calls;
  return fn;
}

function deps(routes) {
  const fetch = mockFetch(routes);
  return { fetch, keys: { key: 'k', secret: 's' }, now: () => 1700000000000 };
}

const posts = (fetch) => fetch.calls.filter((c) => c.method === 'POST');

// ── post-only enforcement ──────────────────────────────────────────────────
describe('placeOrder — post-only enforcement', () => {
  it('defaults a futures LIMIT to GTX (post-only)', async () => {
    const _deps = deps();
    const r = await placeOrder({ market: 'futures', symbol: 'BTCUSDC', side: 'SELL', type: 'LIMIT', quantity: 1, price: 64800, _deps });
    assert.equal(r.dry_run, true);
    assert.equal(r.order_preview.timeInForce, 'GTX');
    assert.equal(r.order_preview.type, 'LIMIT');
  });

  it('uses LIMIT_MAKER (no timeInForce) for spot post-only', async () => {
    const _deps = deps();
    const r = await placeOrder({ market: 'spot', symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', quantity: 1, price: 60000, _deps });
    assert.equal(r.order_preview.type, 'LIMIT_MAKER');
    assert.equal(r.order_preview.timeInForce, undefined);
  });

  it('postOnly:false restores GTC', async () => {
    const _deps = deps();
    const r = await placeOrder({ market: 'futures', symbol: 'BTCUSDC', side: 'SELL', type: 'LIMIT', quantity: 1, price: 64800, postOnly: false, _deps });
    assert.equal(r.order_preview.timeInForce, 'GTC');
  });
});

// ── taker gate ──────────────────────────────────────────────────────────────
describe('placeOrder — taker gate', () => {
  it('blocks MARKET without allowTaker', async () => {
    await assert.rejects(
      placeOrder({ market: 'futures', symbol: 'BTCUSDC', side: 'BUY', type: 'MARKET', quantity: 1, _deps: deps() }),
      /taker-only/,
    );
  });
  it('allows MARKET with allowTaker', async () => {
    const r = await placeOrder({ market: 'futures', symbol: 'BTCUSDC', side: 'BUY', type: 'MARKET', quantity: 1, allowTaker: true, _deps: deps() });
    assert.equal(r.order_preview.type, 'MARKET');
  });
  it('blocks STOP_MARKET without allowTaker', async () => {
    await assert.rejects(
      placeOrder({ market: 'futures', symbol: 'BTCUSDC', side: 'BUY', type: 'STOP_MARKET', stopPrice: 67500, closePosition: true, _deps: deps() }),
      /taker-only/,
    );
  });
});

// ── precision rounding ──────────────────────────────────────────────────────
describe('placeOrder — precision rounding', () => {
  it('snaps price to tick (round) and quantity to step (floor)', async () => {
    const _deps = deps();
    const r = await placeOrder({ market: 'futures', symbol: 'BTCUSDC', side: 'SELL', type: 'LIMIT', quantity: 1.23456, price: 64801.07, _deps });
    assert.equal(r.order_preview.price, '64801.1'); // 0.10 tick, nearest
    assert.equal(r.order_preview.quantity, '1.234'); // 0.001 step, floored
  });
  it('round:false leaves values untouched and makes no network call', async () => {
    const _deps = deps();
    const r = await placeOrder({ market: 'futures', symbol: 'BTCUSDC', side: 'SELL', type: 'LIMIT', quantity: 1.23456, price: 64801.07, round: false, _deps });
    assert.equal(r.order_preview.price, '64801.07');
    assert.equal(_deps.fetch.calls.length, 0);
  });
});

// ── dry-run vs confirm ──────────────────────────────────────────────────────
describe('placeOrder — dry-run never sends', () => {
  it('dry-run makes no POST', async () => {
    const _deps = deps();
    await placeOrder({ market: 'futures', symbol: 'BTCUSDC', side: 'SELL', type: 'LIMIT', quantity: 1, price: 64800, _deps });
    assert.equal(posts(_deps.fetch).length, 0);
  });
  it('confirm POSTs to the order endpoint', async () => {
    const _deps = deps();
    const r = await placeOrder({ market: 'futures', symbol: 'BTCUSDC', side: 'SELL', type: 'LIMIT', quantity: 1, price: 64800, positionSide: 'SHORT', confirm: true, _deps });
    assert.equal(r.success, true);
    const p = posts(_deps.fetch);
    assert.equal(p.length, 1);
    assert.match(p[0].url, /\/fapi\/v1\/order/);
  });
});

// ── paper-trading kill-switch ────────────────────────────────────────────────
// _deps.paperTrading:true forces every money-mover into dry-run, even with confirm:true.
const paperDeps = (routes) => ({ ...deps(routes), paperTrading: true });

describe('paper-trading kill-switch', () => {
  it('placeOrder with confirm:true sends nothing and flags paper_trading', async () => {
    const _deps = paperDeps();
    const r = await placeOrder({ market: 'futures', symbol: 'BTCUSDC', side: 'SELL', type: 'LIMIT', quantity: 1, price: 64800, positionSide: 'SHORT', confirm: true, _deps });
    assert.equal(r.success, false);
    assert.equal(r.dry_run, true);
    assert.equal(r.paper_trading, true);
    assert.match(r.message, /PAPER TRADING/);
    assert.equal(posts(_deps.fetch).length, 0);
  });

  it('does NOT block a normal confirmed order when paper trading is off', async () => {
    const _deps = deps();
    const r = await placeOrder({ market: 'futures', symbol: 'BTCUSDC', side: 'SELL', type: 'LIMIT', quantity: 1, price: 64800, positionSide: 'SHORT', confirm: true, _deps });
    assert.equal(r.success, true);
    assert.equal(r.paper_trading, undefined);
    assert.equal(posts(_deps.fetch).length, 1);
  });

  it('placeBracket confirm:true is suppressed and flagged', async () => {
    const _deps = paperDeps();
    const r = await placeBracket({ market: 'futures', symbol: 'BTCUSDC', side: 'BUY', quantity: 1, entryType: 'MARKET', allowTaker: true, stopPrice: 59000, takeProfits: [{ price: 65000 }], hedge: false, confirm: true, _deps });
    assert.equal(r.dry_run, true);
    assert.equal(r.paper_trading, true);
    assert.equal(posts(_deps.fetch).length, 0);
  });

  it('placeLadder confirm:true places no rungs (no batchOrders POST)', async () => {
    const _deps = paperDeps();
    const r = await placeLadder({ market: 'futures', symbol: 'BTCUSDC', side: 'BUY', lo: 60000, hi: 62000, count: 5, totalQuantity: 0.05, positionSide: 'LONG', confirm: true, _deps });
    assert.equal(r.dry_run, true);
    assert.equal(r.paper_trading, true);
    assert.equal(posts(_deps.fetch).length, 0);
  });

  it('cancelAllOrders confirm:true is suppressed (no DELETE)', async () => {
    const _deps = paperDeps();
    const r = await cancelAllOrders({ market: 'futures', symbol: 'BTCUSDC', confirm: true, _deps });
    assert.equal(r.dry_run, true);
    assert.equal(r.paper_trading, true);
    assert.equal(_deps.fetch.calls.filter((c) => c.method === 'DELETE').length, 0);
  });

  it('transfer confirm:true moves nothing and flags paper_trading', async () => {
    const _deps = paperDeps();
    const r = await transfer({ asset: 'USDC', amount: 10, from: 'spot', to: 'futures', confirm: true, _deps });
    assert.equal(r.dry_run, true);
    assert.equal(r.paper_trading, true);
    assert.equal(posts(_deps.fetch).length, 0);
  });

  it('mirrorOrder confirm:true places nothing across accounts', async () => {
    const _deps = paperDeps({ '/fapi/v2/balance': [{ asset: 'USDT', balance: '1000', availableBalance: '1000' }] });
    const r = await mirrorOrder({ accounts: ['1', '2'], market: 'futures', symbol: 'BTCUSDC', side: 'BUY', type: 'LIMIT', quantity: 1, price: 60000, positionSide: 'LONG', confirm: true, _deps });
    assert.equal(r.dry_run, true);
    assert.equal(r.paper_trading, true);
    assert.equal(posts(_deps.fetch).length, 0);
  });
});

// ── hedge mode ──────────────────────────────────────────────────────────────
describe('placeOrder — hedge mode', () => {
  it('throws on confirm in hedge mode when positionSide is omitted', async () => {
    const _deps = deps({ 'positionSide/dual': { dualSidePosition: true } });
    await assert.rejects(
      placeOrder({ market: 'futures', symbol: 'BTCUSDC', side: 'BUY', type: 'LIMIT', quantity: 1, price: 60000, confirm: true, _deps }),
      /Hedge Mode/,
    );
  });
  it('sets positionSide and strips reduceOnly when positionSide given', async () => {
    const _deps = deps();
    const r = await placeOrder({ market: 'futures', symbol: 'BTCUSDC', side: 'BUY', type: 'LIMIT', quantity: 1, price: 60000, positionSide: 'LONG', reduceOnly: true, _deps });
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
      takeProfits: [{ price: 61300, quantity: 0.5 }, { price: 60000, quantity: 0.5 }],
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
      takeProfits: [{ price: 61300, quantity: 0.5 }, { price: 60000, quantity: 0.5 }],
      allowTaker: true, hedge: true, _deps,
    });
    assert.equal(r.hedgeMode, true);
    for (const leg of r.legs) assert.equal(leg.positionSide, 'SHORT');
    assert.equal(r.legs.find((l) => l.leg === 'tp1').reduceOnly, undefined);
  });

  it('rejects multiple take-profits without per-leg quantity', async () => {
    await assert.rejects(
      placeBracket({ market: 'futures', symbol: 'BTCUSDC', side: 'SELL', quantity: 1, includeEntry: false, takeProfits: [{ price: 61300 }, { price: 60000 }], allowTaker: true, _deps: deps() }),
      /each must have its own quantity/,
    );
  });

  it('blocks taker legs (stop) without allowTaker', async () => {
    await assert.rejects(
      placeBracket({ market: 'futures', symbol: 'BTCUSDC', side: 'SELL', quantity: 1, includeEntry: false, stopPrice: 67500, _deps: deps() }),
      /taker-only legs/,
    );
  });
});

// ── reads + cancel-all guard ────────────────────────────────────────────────
describe('reads and guards', () => {
  it('getPositionMode parses dualSidePosition', async () => {
    const r = await getPositionMode({ market: 'futures', _deps: deps({ 'positionSide/dual': { dualSidePosition: true } }) });
    assert.equal(r.hedgeMode, true);
  });
  it('getCommissionRate parses maker/taker', async () => {
    const _deps = deps({ commissionRate: { makerCommissionRate: '0.000000', takerCommissionRate: '0.000400' } });
    const r = await getCommissionRate({ market: 'futures', symbol: 'BTCUSDC', _deps });
    assert.equal(r.makerCommissionRate, '0.000000');
  });
  it('roundToFilters snaps both fields', async () => {
    const r = await roundToFilters({ market: 'futures', symbol: 'BTCUSDC', price: 64801.07, quantity: 1.23456, _deps: deps() });
    assert.equal(r.price, 64801.1);
    assert.equal(r.quantity, 1.234);
  });
  it('getServerTime computes a round-trip-adjusted offset', async () => {
    let t = 1000;
    const fetch = mockFetch({ '/fapi/v1/time': { serverTime: 6000 } });
    const r = await getServerTime({ market: 'futures', _deps: { fetch, keys: { key: 'k', secret: 's' }, now: () => (t += 100) } });
    // local midpoint between the two now() reads (1100,1200) = 1150 → offset 6000-1150
    assert.equal(r.offsetMs, 4850);
  });

  it('resyncs clock and retries once on a -1021 timestamp error', async () => {
    let firstOrder = true;
    const calls = [];
    const fetch = async (url, opts = {}) => {
      calls.push({ url, method: opts.method || 'GET' });
      if (url.includes('/fapi/v1/time')) return { ok: true, status: 200, json: async () => ({ serverTime: 1700000005000 }) };
      if (url.includes('exchangeInfo')) return { ok: true, status: 200, json: async () => FILTERS };
      if (url.includes('positionSide/dual')) return { ok: true, status: 200, json: async () => ({ dualSidePosition: false }) };
      if (url.includes('/fapi/v1/order')) {
        if (firstOrder) { firstOrder = false; return { ok: false, status: 400, json: async () => ({ code: -1021, msg: 'timestamp' }) }; }
        return { ok: true, status: 200, json: async () => ({ orderId: 9, status: 'NEW' }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };
    const r = await placeOrder({ market: 'futures', symbol: 'BTCUSDC', side: 'SELL', type: 'LIMIT', quantity: 1, price: 64800, positionSide: 'SHORT', confirm: true, _deps: { fetch, keys: { key: 'k', secret: 's' }, now: () => 1700000000000 } });
    assert.equal(r.success, true);
    assert.ok(calls.some((c) => c.url.includes('/fapi/v1/time')), 'should have hit the time endpoint to resync');
    assert.equal(calls.filter((c) => c.url.includes('/fapi/v1/order')).length, 2, 'should retry the order once');
  });

  it('cancelAllOrders is dry-run without confirm and sends a DELETE with confirm', async () => {
    const dry = await cancelAllOrders({ market: 'futures', symbol: 'BTCUSDC', _deps: deps() });
    assert.equal(dry.dry_run, true);
    const _deps = deps();
    const real = await cancelAllOrders({ market: 'futures', symbol: 'BTCUSDC', confirm: true, _deps });
    assert.equal(real.success, true);
    assert.ok(_deps.fetch.calls.some((c) => c.method === 'DELETE'));
  });
});

// ── COIN-M (reads only) ─────────────────────────────────────────────────────
describe('COIN-M futures', () => {
  const coinmDeps = (routes) => ({ fetch: mockFetch(routes), keys: { key: 'k', secret: 's' }, now: () => 1 });

  it('getBalance routes to /dapi/v1/balance on dapi host', async () => {
    const _deps = coinmDeps({ '/dapi/v1/balance': [{ asset: 'BTC', balance: '1.5', availableBalance: '1.2' }] });
    const r = await getBalance({ market: 'coinm', _deps });
    assert.equal(r.balances[0].asset, 'BTC');
    assert.ok(_deps.fetch.calls.some((c) => c.url.includes('dapi.binance.com/dapi/v1/balance')));
  });

  it('getPositions routes to /dapi/v1/positionRisk', async () => {
    const _deps = coinmDeps({ '/dapi/v1/positionRisk': [{ symbol: 'BTCUSD_PERP', positionAmt: '-2', entryPrice: '64000', markPrice: '63000', unRealizedProfit: '3', leverage: '5' }] });
    const r = await getPositions({ market: 'coinm', _deps });
    assert.equal(r.positions[0].side, 'SHORT');
    assert.ok(_deps.fetch.calls.some((c) => c.url.includes('/dapi/v1/positionRisk')));
  });

  it('getTicker handles the COIN-M array response', async () => {
    const _deps = coinmDeps({ '/dapi/v1/ticker/price': [{ symbol: 'BTCUSD_PERP', ps: 'BTCUSD', price: '64000.0' }] });
    const r = await getTicker({ market: 'coinm', symbol: 'BTCUSD_PERP', _deps });
    assert.equal(r.price, '64000.0');
    assert.equal(r.symbol, 'BTCUSD_PERP');
  });

  it('places a COIN-M order: post-only GTX, contracts note, routed to /dapi/v1/order', async () => {
    const _deps = deps();
    const r = await placeOrder({ market: 'coinm', symbol: 'BTCUSD_PERP', side: 'SELL', type: 'LIMIT', quantity: 2, price: 64000.07, positionSide: 'SHORT', confirm: true, _deps });
    assert.equal(r.success, true);
    assert.ok(_deps.fetch.calls.some((c) => c.method === 'POST' && c.url.includes('dapi.binance.com/dapi/v1/order')));
  });

  it('COIN-M order preview is GTX with a CONTRACTS note', async () => {
    const r = await placeOrder({ market: 'coinm', symbol: 'BTCUSD_PERP', side: 'SELL', type: 'LIMIT', quantity: 2, price: 64000, positionSide: 'SHORT', _deps: deps() });
    assert.equal(r.order_preview.timeInForce, 'GTX');
    assert.equal(r.order_preview.positionSide, 'SHORT');
    assert.match(r.coinm_note, /CONTRACTS/);
  });

  it('COIN-M bracket places every leg to /dapi/v1/order', async () => {
    const _deps = deps();
    const r = await placeBracket({ market: 'coinm', symbol: 'BTCUSD_PERP', side: 'SELL', quantity: 2, stopPrice: 67000, takeProfits: [{ price: 61000, quantity: 2 }], allowTaker: true, hedge: true, confirm: true, _deps });
    assert.equal(r.success, true);
    assert.ok(_deps.fetch.calls.filter((c) => c.method === 'POST').every((c) => c.url.includes('/dapi/v1/order')));
    assert.ok(r.legs.every((l) => l.params.positionSide === 'SHORT'));
  });
});

// ── Conditional orders → Algo endpoint (Binance 2025-12-09 migration) ────────
describe('conditional orders use the Algo endpoint', () => {
  it('USD-M STOP_MARKET previews to /fapi/v1/algoOrder with triggerPrice (not stopPrice)', async () => {
    const r = await placeOrder({ market: 'futures', symbol: 'BTCUSDC', side: 'SELL', type: 'STOP_MARKET', stopPrice: 58900, closePosition: true, positionSide: 'LONG', allowTaker: true, _deps: deps() });
    assert.match(r.order_preview.endpoint, /\/fapi\/v1\/algoOrder/);
    assert.equal(r.order_preview.algoType, 'CONDITIONAL');
    assert.equal(r.order_preview.triggerPrice, '58900');
    assert.equal(r.order_preview.stopPrice, undefined);
  });

  it('confirm POSTs a STOP_MARKET to the algo endpoint and flags algo:true', async () => {
    const _deps = deps({ '/fapi/v1/algoOrder': { algoId: 222, algoStatus: 'NEW' } });
    const r = await placeOrder({ market: 'futures', symbol: 'BTCUSDC', side: 'SELL', type: 'STOP_MARKET', stopPrice: 58900, closePosition: true, positionSide: 'LONG', allowTaker: true, confirm: true, _deps });
    assert.equal(r.success, true);
    assert.equal(r.algo, true);
    assert.ok(posts(_deps.fetch).some((c) => c.url.includes('/fapi/v1/algoOrder')));
  });

  it('getOpenOrders merges regular + algo orders', async () => {
    const _deps = deps({ '/fapi/v1/openOrders': [{ orderId: 1, type: 'LIMIT' }], '/fapi/v1/openAlgoOrders': [{ algoId: 9, orderType: 'STOP_MARKET' }] });
    const r = await getOpenOrders({ market: 'futures', symbol: 'BTCUSDC', _deps });
    assert.equal(r.count, 2);
    assert.equal(r.algoOrders.length, 1);
    assert.equal(r.algoOrders[0].algoId, 9);
  });

  it('cancelAlgoOrder DELETEs the algo endpoint by algoId', async () => {
    const _deps = deps({ '/fapi/v1/algoOrder': { algoId: 9, algoStatus: 'CANCELED' } });
    const r = await cancelAlgoOrder({ market: 'futures', algoId: 9, _deps });
    assert.equal(r.success, true);
    assert.ok(_deps.fetch.calls.some((c) => c.method === 'DELETE' && c.url.includes('/fapi/v1/algoOrder')));
  });
});

// ── Universal Transfer ──────────────────────────────────────────────────────
describe('transfer (wallet-to-wallet)', () => {
  it('dry-run previews UMFUTURE_MAIN and sends nothing', async () => {
    const _deps = deps();
    const r = await transfer({ asset: 'USDC', amount: 100, from: 'futures', to: 'spot', _deps });
    assert.equal(r.dry_run, true);
    assert.equal(r.transfer_preview.type, 'UMFUTURE_MAIN');
    assert.equal(r.transfer_preview.asset, 'USDC');
    assert.equal(r.transfer_preview.amount, '100');
    assert.equal(posts(_deps.fetch).length, 0);
  });

  it('confirm POSTs to /sapi/v1/asset/transfer on the spot host', async () => {
    const _deps = deps({ '/sapi/v1/asset/transfer': { tranId: 123456 } });
    const r = await transfer({ asset: 'USDC', amount: 100, from: 'futures', to: 'spot', confirm: true, _deps });
    assert.equal(r.success, true);
    assert.equal(r.tranId, 123456);
    const p = posts(_deps.fetch);
    assert.equal(p.length, 1);
    assert.match(p[0].url, /api\.binance\.com\/sapi\/v1\/asset\/transfer/);
  });

  it('derives correct types and validates wallets', async () => {
    const spotToCoinm = await transfer({ asset: 'BTC', amount: 1, from: 'spot', to: 'coinm', _deps: deps() });
    assert.equal(spotToCoinm.transfer_preview.type, 'MAIN_CMFUTURE');
    await assert.rejects(transfer({ asset: 'USDC', amount: 1, from: 'spot', to: 'spot', _deps: deps() }), /must differ/);
    await assert.rejects(transfer({ asset: 'USDC', amount: 1, from: 'usdm', to: 'coinm', _deps: deps() }), /one side must be spot/);
  });

  it('getTransferHistory queries with the derived type', async () => {
    const _deps = deps({ '/sapi/v1/asset/transfer': { total: 1, rows: [{ asset: 'USDC', amount: '100', type: 'UMFUTURE_MAIN', status: 'CONFIRMED', tranId: 1 }] } });
    const r = await getTransferHistory({ from: 'futures', to: 'spot', _deps });
    assert.equal(r.type, 'UMFUTURE_MAIN');
    assert.equal(r.total, 1);
  });
});

// ── Multi-account: key resolution + trade mirroring ─────────────────────────
describe('multi-account key resolution', () => {
  it('placeOrder account:"2" signs with the BINANCE_API_KEY_2 key set (via getKeys override)', async () => {
    const calls = [];
    const fetch = async (url, opts = {}) => {
      calls.push({ url, method: opts.method || 'GET', apiKey: opts.headers?.['X-MBX-APIKEY'] });
      if (url.includes('exchangeInfo')) return { ok: true, status: 200, json: async () => FILTERS };
      return { ok: true, status: 200, json: async () => ({ orderId: 1, status: 'NEW' }) };
    };
    const _deps = { fetch, getKeys: (acct) => ({ key: `k${acct}`, secret: `s${acct}` }), now: () => 1700000000000 };
    const r = await placeOrder({ market: 'futures', symbol: 'BTCUSDC', side: 'SELL', type: 'LIMIT', quantity: 1, price: 64800, positionSide: 'SHORT', account: '2', confirm: true, _deps });
    assert.equal(r.success, true);
    assert.equal(r.account, '2');
    const post = calls.find((c) => c.method === 'POST' && c.url.includes('/fapi/v1/order'));
    assert.equal(post.apiKey, 'k2'); // resolved the second account's key
  });
});

// mirror-mode deps: distinct per-account keys (via getKeys) and per-key balances keyed on the
// API-key header so /fapi/v2/balance can return a different figure for each account.
function mirrorDeps({ balances = { k1: 1000, k2: 500 }, failOrderForKey, routes = {} } = {}) {
  const calls = [];
  const fetch = async (url, opts = {}) => {
    const apiKey = opts.headers?.['X-MBX-APIKEY'];
    calls.push({ url, method: opts.method || 'GET', apiKey });
    if (url.includes('exchangeInfo')) return { ok: true, status: 200, json: async () => FILTERS };
    if (url.includes('positionSide/dual')) return { ok: true, status: 200, json: async () => ({ dualSidePosition: false }) };
    if (url.includes('/fapi/v2/balance')) {
      const usdt = balances[apiKey] ?? 0;
      return { ok: true, status: 200, json: async () => [{ asset: 'USDT', balance: String(usdt), availableBalance: String(usdt) }] };
    }
    if (url.includes('/fapi/v1/order')) {
      if (failOrderForKey && apiKey === failOrderForKey) return { ok: false, status: 400, json: async () => ({ code: -2010, msg: 'order would immediately trigger' }) };
      return { ok: true, status: 200, json: async () => ({ orderId: 1, status: 'NEW' }) };
    }
    for (const [substr, data] of Object.entries(routes)) {
      if (url.includes(substr)) return { ok: true, status: 200, json: async () => data };
    }
    return { ok: true, status: 200, json: async () => ({ orderId: 1, status: 'NEW' }) };
  };
  fetch.calls = calls;
  return { fetch, getKeys: (acct) => ({ key: `k${acct}`, secret: `s${acct}` }), now: () => 1700000000000 };
}

const orderPosts = (fetch) => fetch.calls.filter((c) => c.method === 'POST' && c.url.includes('/fapi/v1/order'));

describe('mirrorOrder — balance-scaled fan-out', () => {
  it('dry-run previews both accounts with the scaled quantity and sends nothing', async () => {
    const _deps = mirrorDeps({ balances: { k1: 1000, k2: 500 } });
    const r = await mirrorOrder({ market: 'futures', symbol: 'BTCUSDC', side: 'SELL', type: 'LIMIT', quantity: 1, price: 64800, accounts: ['1', '2'], _deps });
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
    const _deps = mirrorDeps({ balances: { k1: 1000, k2: 500 } });
    const r = await mirrorOrder({ market: 'futures', symbol: 'BTCUSDC', side: 'SELL', type: 'LIMIT', quantity: 1, price: 64800, positionSide: 'SHORT', accounts: ['1', '2'], confirm: true, _deps });
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
    const _deps = mirrorDeps({ balances: { k1: 1000, k2: 0.0001 } }); // factor 1e-7 → qty floors to 0
    const r = await mirrorOrder({ market: 'futures', symbol: 'BTCUSDC', side: 'SELL', type: 'LIMIT', quantity: 1, price: 64800, positionSide: 'SHORT', accounts: ['1', '2'], confirm: true, _deps });
    assert.match(r.accounts[1].skipped, /below minQty/);
    assert.equal(orderPosts(_deps.fetch).length, 1); // only the base
    assert.equal(r.success, true); // base placed, mirror intentionally skipped
  });

  it('on confirm, a failed base order skips the mirror entirely', async () => {
    const _deps = mirrorDeps({ balances: { k1: 1000, k2: 500 }, failOrderForKey: 'k1' });
    const r = await mirrorOrder({ market: 'futures', symbol: 'BTCUSDC', side: 'SELL', type: 'LIMIT', quantity: 1, price: 64800, positionSide: 'SHORT', accounts: ['1', '2'], confirm: true, _deps });
    assert.equal(r.success, false);
    assert.equal(r.accounts[0].result.success, false); // base failed
    assert.match(r.accounts[1].skipped, /base order failed/);
    assert.equal(orderPosts(_deps.fetch).length, 1); // mirror never attempted
  });

  it('requires at least two accounts', async () => {
    await assert.rejects(
      mirrorOrder({ market: 'futures', symbol: 'BTCUSDC', side: 'SELL', type: 'LIMIT', quantity: 1, price: 64800, accounts: ['1'], _deps: mirrorDeps() }),
      /at least two accounts/,
    );
  });
});

describe('mirrorBracket — balance-scaled fan-out', () => {
  it('scales the entry and per-TP quantities for the mirror account', async () => {
    const _deps = mirrorDeps({ balances: { k1: 1000, k2: 500 } });
    const r = await mirrorBracket({
      market: 'futures', symbol: 'BTCUSDC', side: 'SELL', quantity: 1,
      entryType: 'LIMIT', entryPrice: 64800, stopPrice: 67500,
      takeProfits: [{ price: 61300, quantity: 0.6 }, { price: 60000, quantity: 0.4 }],
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

// ── account routing ─────────────────────────────────────────────────────────
// Regression: signed/account-specific functions must resolve keys for the
// requested `account`, not silently fall back to the primary (account "1").
// We inject _deps.getKeys (NOT _deps.keys, which would short-circuit resolveDeps)
// and assert both that getKeys saw the right account and that the request was
// signed with that account's key (X-MBX-APIKEY header).
function routingDeps(routes = {}) {
  const seen = [];
  const base = mockFetch(routes);
  const headers = [];
  const fetch = async (url, opts = {}) => {
    headers.push(opts.headers?.['X-MBX-APIKEY']);
    return base(url, opts);
  };
  fetch.calls = base.calls;
  const getKeys = (account) => { seen.push(account); return { key: `K_${account}`, secret: `S_${account}` }; };
  return { _deps: { fetch, getKeys, now: () => 1700000000000 }, seen, headers };
}

describe('account routing — signed calls use the requested account, not "1"', () => {
  it('getPositionMode', async () => {
    const { _deps, seen, headers } = routingDeps({ 'positionSide/dual': { dualSidePosition: true } });
    const r = await getPositionMode({ account: '2', _deps });
    assert.equal(r.account, '2');
    assert.deepEqual(seen, ['2']);
    assert.ok(headers.includes('K_2'));
    assert.ok(!seen.includes('1'));
  });

  it('setLeverage', async () => {
    const { _deps, seen, headers } = routingDeps({ leverage: { leverage: 3, symbol: 'BTCUSDC', maxNotionalValue: '1' } });
    await setLeverage({ symbol: 'BTCUSDC', leverage: 3, account: '3', _deps });
    assert.deepEqual(seen, ['3']);
    assert.ok(headers.includes('K_3'));
  });

  it('setMarginType', async () => {
    const { _deps, seen } = routingDeps({ marginType: { code: 200, msg: 'success' } });
    await setMarginType({ symbol: 'BTCUSDC', marginType: 'CROSSED', account: '2', _deps });
    assert.deepEqual(seen, ['2']);
  });

  it('getCommissionRate', async () => {
    const { _deps, seen } = routingDeps({ commissionRate: { makerCommissionRate: '0', takerCommissionRate: '0.0004' } });
    await getCommissionRate({ symbol: 'BTCUSDC', account: '2', _deps });
    assert.deepEqual(seen, ['2']);
  });

  it('getOrder', async () => {
    const { _deps, seen } = routingDeps();
    await getOrder({ symbol: 'BTCUSDC', orderId: 5, account: '2', _deps });
    assert.deepEqual(seen, ['2']);
  });

  it('cancelOrder', async () => {
    const { _deps, seen, headers } = routingDeps();
    await cancelOrder({ symbol: 'BTCUSDC', orderId: 5, account: '2', _deps });
    assert.deepEqual(seen, ['2']);
    assert.ok(headers.includes('K_2'));
  });

  it('cancelAlgoOrder', async () => {
    const { _deps, seen } = routingDeps();
    await cancelAlgoOrder({ algoId: 99, account: '2', _deps });
    assert.deepEqual(seen, ['2']);
  });

  it('getAccountTrades', async () => {
    const { _deps, seen } = routingDeps({ userTrades: [] });
    await getAccountTrades({ symbol: 'BTCUSDC', account: '2', _deps });
    assert.deepEqual(seen, ['2']);
  });

  it('getHistoricalTrades (API-key header, spot)', async () => {
    const { _deps, seen, headers } = routingDeps({ historicalTrades: [] });
    await getHistoricalTrades({ market: 'spot', symbol: 'BTCUSDC', account: '2', _deps });
    assert.deepEqual(seen, ['2']);
    assert.ok(headers.includes('K_2'));
  });

  it('transfer (confirmed)', async () => {
    const { _deps, seen, headers } = routingDeps({ 'asset/transfer': { tranId: 1 } });
    await transfer({ asset: 'USDC', amount: 10, from: 'futures', to: 'spot', account: '2', confirm: true, _deps });
    assert.deepEqual(seen, ['2']);
    assert.ok(headers.includes('K_2'));
  });

  it('getTransferHistory', async () => {
    const { _deps, seen } = routingDeps({ 'asset/transfer': { total: 0, rows: [] } });
    await getTransferHistory({ from: 'futures', to: 'spot', account: '2', _deps });
    assert.deepEqual(seen, ['2']);
  });

  it('getLiquidationHistory', async () => {
    const { _deps, seen, headers } = routingDeps({ forceOrders: [] });
    await getLiquidationHistory({ market: 'futures', symbol: 'BTCUSDC', account: '2', _deps });
    assert.deepEqual(seen, ['2']);
    assert.ok(headers.includes('K_2'));
  });

  it('getDepositHistory', async () => {
    const { _deps, seen } = routingDeps({ 'capital/deposit/hisrec': [] });
    await getDepositHistory({ coin: 'USDC', account: '2', _deps });
    assert.deepEqual(seen, ['2']);
  });

  it('getWithdrawHistory', async () => {
    const { _deps, seen } = routingDeps({ 'capital/withdraw/history': [] });
    await getWithdrawHistory({ coin: 'USDC', account: '2', _deps });
    assert.deepEqual(seen, ['2']);
  });

  it('getDepositAddress', async () => {
    const { _deps, seen } = routingDeps({ 'capital/deposit/address': { coin: 'USDC', address: '0xabc', tag: '', url: '' } });
    await getDepositAddress({ coin: 'USDC', account: '2', _deps });
    assert.deepEqual(seen, ['2']);
  });

  it('placeOrder still routes account on confirm (regression guard)', async () => {
    const { _deps, seen } = routingDeps({ 'positionSide/dual': { dualSidePosition: false } });
    await placeOrder({ market: 'futures', symbol: 'BTCUSDC', side: 'BUY', type: 'LIMIT', quantity: 0.01, price: 60000, account: '2', confirm: true, _deps });
    assert.ok(seen.every((a) => a === '2'));
    assert.ok(!seen.includes('1'));
  });
});

// ── market-data reads (public) ───────────────────────────────────────────────
describe('market data — klines / tickers (public)', () => {
  it('getKlines parses positional arrays into OHLCV objects and hits the futures endpoint', async () => {
    const _deps = deps({ klines: [
      [1700000000000, '60000', '60500', '59800', '60200', '12.5', 1700003599999, '750000', 100, '6', '360000', '0'],
    ] });
    const r = await getKlines({ market: 'futures', symbol: 'BTCUSDC', interval: '1h', _deps });
    assert.equal(r.count, 1);
    assert.deepEqual(r.candles[0], {
      openTime: 1700000000000, open: '60000', high: '60500', low: '59800', close: '60200', volume: '12.5', closeTime: 1700003599999,
    });
    assert.match(_deps.fetch.calls[0].url, /\/fapi\/v1\/klines/);
  });

  it('getKlines extended:true surfaces order-flow columns (and omits them by default)', async () => {
    const row = [1700000000000, '60000', '60500', '59800', '60200', '12.5', 1700003599999, '750000', 100, '6', '360000', '0'];
    const _plain = deps({ klines: [row] });
    const plain = await getKlines({ market: 'futures', symbol: 'BTCUSDC', _deps: _plain });
    assert.equal(plain.candles[0].quoteVolume, undefined);
    const _ext = deps({ klines: [row] });
    const ext = await getKlines({ market: 'futures', symbol: 'BTCUSDC', extended: true, _deps: _ext });
    assert.deepEqual(ext.candles[0], {
      openTime: 1700000000000, open: '60000', high: '60500', low: '59800', close: '60200', volume: '12.5', closeTime: 1700003599999,
      quoteVolume: '750000', trades: 100, takerBuyVolume: '6', takerBuyQuoteVolume: '360000',
    });
  });

  it('getKlines rejects an invalid interval', async () => {
    await assert.rejects(getKlines({ symbol: 'BTCUSDC', interval: '7m', _deps: deps() }), /interval must be one of/);
  });

  it('getKlines caps limit (futures 1500) and uses spot endpoint for spot', async () => {
    const _deps = deps({ klines: [] });
    await getKlines({ market: 'futures', symbol: 'BTCUSDC', limit: 9999, _deps });
    assert.match(_deps.fetch.calls[0].url, /limit=1500/);
    const _spot = deps({ klines: [] });
    await getKlines({ market: 'spot', symbol: 'BTCUSDC', limit: 9999, _deps: _spot });
    assert.match(_spot.fetch.calls[0].url, /\/api\/v3\/klines/);
    assert.match(_spot.fetch.calls[0].url, /limit=1000/);
  });

  it('get24hrTicker maps the change fields', async () => {
    const _deps = deps({ 'ticker/24hr': { symbol: 'BTCUSDC', lastPrice: '60200', priceChangePercent: '-3.5', highPrice: '63000', lowPrice: '59700', volume: '1234' } });
    const r = await get24hrTicker({ market: 'futures', symbol: 'BTCUSDC', _deps });
    assert.equal(r.lastPrice, '60200');
    assert.equal(r.priceChangePercent, '-3.5');
    assert.equal(r.highPrice, '63000');
  });

  it('getBookTicker computes the spread', async () => {
    const _deps = deps({ bookTicker: { symbol: 'BTCUSDC', bidPrice: '60200.0', bidQty: '1', askPrice: '60200.5', askQty: '2' } });
    const r = await getBookTicker({ market: 'futures', symbol: 'BTCUSDC', _deps });
    assert.equal(r.bidPrice, '60200.0');
    assert.equal(r.askPrice, '60200.5');
    assert.equal(r.spread, '0.5');
    assert.match(r.spreadPct, /%$/);
  });

  it('getAvgPrice is spot-only and returns the average', async () => {
    await assert.rejects(getAvgPrice({ market: 'futures', symbol: 'BTCUSDC', _deps: deps() }), /spot-only/);
    const _deps = deps({ avgPrice: { mins: 5, price: '60150.42' } });
    const r = await getAvgPrice({ market: 'spot', symbol: 'BTCUSDC', _deps });
    assert.equal(r.price, '60150.42');
    assert.equal(r.mins, 5);
  });

  it('getRollingWindowTicker is spot-only and passes windowSize', async () => {
    await assert.rejects(getRollingWindowTicker({ market: 'futures', symbol: 'BTCUSDC', _deps: deps() }), /spot-only/);
    const _deps = deps({ windowSize: { symbol: 'BTCUSDC', lastPrice: '60200', priceChangePercent: '-2.1' } });
    const r = await getRollingWindowTicker({ market: 'spot', symbol: 'BTCUSDC', windowSize: '4h', _deps });
    assert.equal(r.windowSize, '4h');
    assert.equal(r.priceChangePercent, '-2.1');
    assert.match(_deps.fetch.calls[0].url, /windowSize=4h/);
  });
});

// ── tools borrowed from muvon/mcp-binance-futures ────────────────────────────
describe('setPositionMode', () => {
  it('POSTs dualSidePosition=true for hedge', async () => {
    const _deps = deps({ 'positionSide/dual': { code: 200, msg: 'success' } });
    const r = await setPositionMode({ market: 'futures', hedgeMode: true, _deps });
    assert.equal(r.success, true);
    assert.equal(r.hedgeMode, true);
    assert.equal(r.changed, true);
    const p = posts(_deps.fetch);
    assert.equal(p.length, 1);
    assert.match(p[0].url, /dualSidePosition=true/);
  });
  it('treats -4059 "no need to change" as idempotent success', async () => {
    // fetch returns the -4059 error → signedRequest throws → setPositionMode swallows it
    const _deps = deps({ 'positionSide/dual': { code: -4059, msg: 'No need to change position side.' } });
    const r = await setPositionMode({ market: 'futures', hedgeMode: false, _deps });
    assert.equal(r.success, true);
    assert.equal(r.changed, false);
  });
  it('requires a boolean hedgeMode', async () => {
    await assert.rejects(setPositionMode({ market: 'futures', _deps: deps() }), /hedgeMode must be/);
  });
});

describe('modifyOrder', () => {
  it('dry-run previews a PUT and sends nothing', async () => {
    const _deps = deps();
    const r = await modifyOrder({ market: 'futures', symbol: 'BTCUSDC', orderId: 5, side: 'BUY', quantity: 0.033, price: 60123.07, _deps });
    assert.equal(r.dry_run, true);
    assert.equal(r.modify_preview.price, '60123.1'); // snapped to 0.10 tick
    assert.equal(r.modify_preview.quantity, '0.033');
    assert.equal(_deps.fetch.calls.filter((c) => c.method === 'PUT').length, 0);
  });
  it('confirm sends a PUT to the order endpoint', async () => {
    const _deps = deps();
    const r = await modifyOrder({ market: 'futures', symbol: 'BTCUSDC', orderId: 5, side: 'BUY', quantity: 0.033, price: 60100, confirm: true, _deps });
    assert.equal(r.success, true);
    const put = _deps.fetch.calls.find((c) => c.method === 'PUT');
    assert.ok(put);
    assert.match(put.url, /\/fapi\/v1\/order/);
  });
  it('requires a valid side', async () => {
    await assert.rejects(modifyOrder({ market: 'futures', symbol: 'BTCUSDC', orderId: 5, quantity: 1, price: 1, _deps: deps() }), /side must be/);
  });
});

describe('getOrderHistory', () => {
  it('hits allOrders with symbol+limit', async () => {
    const _deps = deps({ allOrders: [{ orderId: 1, status: 'FILLED' }, { orderId: 2, status: 'CANCELED' }] });
    const r = await getOrderHistory({ market: 'futures', symbol: 'BTCUSDC', _deps });
    assert.equal(r.count, 2);
    assert.match(_deps.fetch.calls[0].url, /\/fapi\/v1\/allOrders/);
  });
});

describe('getLeverageBrackets', () => {
  it('normalizes brackets per symbol', async () => {
    const _deps = deps({ leverageBracket: [{ symbol: 'BTCUSDC', brackets: [{ bracket: 1, initialLeverage: 125, notionalCap: 50000, notionalFloor: 0, maintMarginRatio: 0.004 }] }] });
    const r = await getLeverageBrackets({ market: 'futures', symbol: 'BTCUSDC', _deps });
    assert.equal(r.symbols[0].symbol, 'BTCUSDC');
    assert.equal(r.symbols[0].brackets[0].initialLeverage, 125);
  });
});

describe('getAccountSummary', () => {
  it('computes margin ratio from totals', async () => {
    const _deps = deps({ 'fapi/v2/account': { totalWalletBalance: '50000', totalUnrealizedProfit: '-1200', totalMarginBalance: '48800', availableBalance: '15000', totalInitialMargin: '33000', totalMaintMargin: '2440' } });
    const r = await getAccountSummary({ market: 'futures', _deps });
    assert.equal(r.totalWalletBalance, '50000');
    assert.equal(r.totalUnrealizedPnl, '-1200');
    assert.equal(r.marginRatio, '5.00%'); // 2440 / 48800
  });
  it('is futures-only', async () => {
    await assert.rejects(getAccountSummary({ market: 'spot', _deps: deps() }), /futures-only/);
  });
});

// ── ladder / funding / income / snapshot / ensure-stop ───────────────────────
describe('placeLadder', () => {
  it('dry-run builds the plan and sends nothing', async () => {
    const _deps = deps();
    const r = await placeLadder({ market: 'futures', symbol: 'BTCUSDC', side: 'BUY', lo: 60000, hi: 61000, count: 4, totalNotional: 4000, _deps });
    assert.equal(r.dry_run, true);
    assert.equal(r.ladder_preview.rungs, 4);
    assert.equal(r.ladder_preview.timeInForce, 'GTX (post-only)');
    assert.ok(r.ladder_preview.avgPrice > 60000 && r.ladder_preview.avgPrice < 61000);
    assert.equal(posts(_deps.fetch).length, 0);
  });
  it('requires exactly one of totalNotional / totalQuantity', async () => {
    await assert.rejects(placeLadder({ market: 'futures', symbol: 'BTCUSDC', side: 'BUY', lo: 60000, hi: 61000, count: 4, _deps: deps() }), /exactly one/);
    await assert.rejects(placeLadder({ market: 'futures', symbol: 'BTCUSDC', side: 'BUY', lo: 60000, hi: 61000, count: 4, totalNotional: 1000, totalQuantity: 1, _deps: deps() }), /exactly one/);
  });
  it('confirm places rungs via the batchOrders endpoint', async () => {
    const _deps = deps({ batchOrders: [{ orderId: 1 }, { orderId: 2 }, { orderId: 3 }, { orderId: 4 }] });
    const r = await placeLadder({ market: 'futures', symbol: 'BTCUSDC', side: 'BUY', lo: 60000, hi: 61000, count: 4, totalNotional: 4000, confirm: true, _deps });
    assert.equal(r.success, true);
    assert.equal(r.placed, 4);
    const batch = posts(_deps.fetch).filter((c) => /batchOrders/.test(c.url));
    assert.equal(batch.length, 1); // 4 rungs → one chunk of 5
  });
  it('warns (3x rule) when total notional exceeds account equity × 3', async () => {
    // equity 10000 → 3x cap = 30000; ladder notional ≈ 60500 → ~6x
    const _deps = deps({ 'fapi/v2/account': { totalMarginBalance: '10000', totalMaintMargin: '0' } });
    const r = await placeLadder({ market: 'futures', symbol: 'BTCUSDC', side: 'BUY', lo: 60000, hi: 61000, count: 4, totalNotional: 60500, _deps });
    assert.ok(r.ladder_preview.impliedAccountLeverage > 3);
    assert.ok((r.ladder_preview.warnings || []).some((w) => /3x rule/.test(w)));
  });
  it('seed "min" resolves to the exchange minimum (minQty / minNotional)', async () => {
    // BTCUSDC mock: minQty 0.001, minNotional 50, stepSize 0.001. At ~60k, minQty alone clears notional.
    const _deps = deps({ bookTicker: { symbol: 'BTCUSDC', bidPrice: '60000', askPrice: '60001' } });
    const r = await placeLadder({ market: 'futures', symbol: 'BTCUSDC', side: 'SELL', lo: 61500, hi: 66400, count: 50, totalNotional: 50000, positionSide: 'SHORT', seedQuantity: 'min', stop: 67750, _deps });
    assert.equal(r.ladder_preview.seed.quantity, 0.001);
  });
  it('seed "min" bumps above minQty when minNotional requires it', async () => {
    // minNotional 50 at a $5 price ⇒ need 10 units; minQty 0.001 is far too small.
    const cheap = { symbols: [{ symbol: 'CHEAPUSDC', status: 'TRADING', pricePrecision: 2, quantityPrecision: 1,
      filters: [{ filterType: 'PRICE_FILTER', tickSize: '0.01' }, { filterType: 'LOT_SIZE', stepSize: '0.1', minQty: '0.1' }, { filterType: 'MIN_NOTIONAL', notional: '50' }] }] };
    const _deps = deps({ exchangeInfo: cheap, bookTicker: { symbol: 'CHEAPUSDC', bidPrice: '5', askPrice: '5.01' } });
    const r = await placeLadder({ market: 'futures', symbol: 'CHEAPUSDC', side: 'SELL', lo: 6, hi: 8, count: 4, totalNotional: 400, positionSide: 'SHORT', seedQuantity: 'min', _deps });
    assert.equal(r.ladder_preview.seed.quantity, 10); // 50 / 5 = 10, snapped up to 0.1 step
  });
});

describe('getFundingRate', () => {
  it('current snapshot formats the rate as a percent', async () => {
    const _deps = deps({ premiumIndex: { symbol: 'BTCUSDC', markPrice: '60000', indexPrice: '60010', lastFundingRate: '0.0001', nextFundingTime: 123 } });
    const r = await getFundingRate({ market: 'futures', symbol: 'BTCUSDC', _deps });
    assert.equal(r.lastFundingRate, '0.0001');
    assert.equal(r.lastFundingRatePct, '0.0100%');
  });
  it('history returns recent payments', async () => {
    const _deps = deps({ fundingRate: [{ symbol: 'BTCUSDC', fundingRate: '0.0001', fundingTime: 1 }] });
    const r = await getFundingRate({ market: 'futures', symbol: 'BTCUSDC', history: true, _deps });
    assert.equal(r.count, 1);
    assert.equal(r.fundingHistory[0].fundingRatePct, '0.0100%');
  });
});

describe('market-data scan variants', () => {
  it('get24hrTicker all:true returns every symbol; quote narrows to a quote asset', async () => {
    const _deps = deps({ 'ticker/24hr': [
      { symbol: 'BTCUSDC', lastPrice: '60000', priceChangePercent: '1.2' },
      { symbol: 'ETHUSDC', lastPrice: '3000', priceChangePercent: '-0.5' },
      { symbol: 'BTCUSDT', lastPrice: '60010', priceChangePercent: '1.1' },
    ] });
    const r = await get24hrTicker({ market: 'futures', all: true, quote: 'USDC', _deps });
    assert.equal(r.all, true);
    assert.equal(r.count, 2);
    assert.ok(r.tickers.every((t) => t.symbol.endsWith('USDC')));
  });
  it('getBookTicker all:true maps the spread per row', async () => {
    const _deps = deps({ 'ticker/bookTicker': [{ symbol: 'BTCUSDC', bidPrice: '60000', askPrice: '60010', bidQty: '1', askQty: '2' }] });
    const r = await getBookTicker({ market: 'futures', all: true, _deps });
    assert.equal(r.count, 1);
    assert.equal(r.tickers[0].spread, '10');
  });
  it('getRollingWindowTicker scans a symbols list (spot) and sends a symbols param', async () => {
    const _deps = deps({ '/api/v3/ticker?': [
      { symbol: 'BTCUSDC', lastPrice: '60000' }, { symbol: 'ETHUSDC', lastPrice: '3000' },
    ] });
    const r = await getRollingWindowTicker({ market: 'spot', symbols: ['BTCUSDC', 'ETHUSDC'], windowSize: '4h', _deps });
    assert.equal(r.count, 2);
    assert.equal(r.windowSize, '4h');
    assert.match(_deps.fetch.calls[0].url, /symbols=/);
  });
});

describe('getUiKlines', () => {
  it('maps spot uiKlines candles and hits /api/v3/uiKlines', async () => {
    const _deps = deps({ uiKlines: [[1, '1', '2', '0.5', '1.5', '100', 2]] });
    const r = await getUiKlines({ market: 'spot', symbol: 'BTCUSDC', interval: '1h', _deps });
    assert.equal(r.count, 1);
    assert.equal(r.candles[0].high, '2');
    assert.match(_deps.fetch.calls[0].url, /\/api\/v3\/uiKlines/);
  });
  it('rejects futures', async () => {
    await assert.rejects(getUiKlines({ market: 'futures', symbol: 'BTCUSDC', _deps: deps() }), /spot-only/);
  });
});

describe('getTradingDayTicker', () => {
  it('single symbol returns one row', async () => {
    const _deps = deps({ 'ticker/tradingDay': { symbol: 'BTCUSDC', lastPrice: '60000', priceChangePercent: '1.0' } });
    const r = await getTradingDayTicker({ market: 'spot', symbol: 'BTCUSDC', _deps });
    assert.equal(r.symbol, 'BTCUSDC');
    assert.equal(r.lastPrice, '60000');
  });
  it('symbols list returns an array and sends a symbols param', async () => {
    const _deps = deps({ 'ticker/tradingDay': [{ symbol: 'BTCUSDC', lastPrice: '60000' }, { symbol: 'ETHUSDC', lastPrice: '3000' }] });
    const r = await getTradingDayTicker({ market: 'spot', symbols: 'BTCUSDC,ETHUSDC', _deps });
    assert.equal(r.count, 2);
    assert.match(_deps.fetch.calls[0].url, /symbols=/);
  });
  it('rejects futures', async () => {
    await assert.rejects(getTradingDayTicker({ market: 'futures', symbol: 'BTCUSDC', _deps: deps() }), /spot-only/);
  });
});

describe('user-data stream (listenKey)', () => {
  it('startUserStream POSTs the futures listenKey endpoint and returns a wsUrl', async () => {
    const _deps = deps({ listenKey: { listenKey: 'abc123' } });
    const r = await startUserStream({ market: 'futures', account: '1', _deps });
    assert.equal(r.listenKey, 'abc123');
    assert.match(r.wsUrl, /^wss:\/\/fstream\.binance\.com\/ws\/abc123$/);
    assert.equal(_deps.fetch.calls[0].method, 'POST');
    assert.match(_deps.fetch.calls[0].url, /\/fapi\/v1\/listenKey/);
  });
  it('keepAliveUserStream PUTs; spot requires a listenKey', async () => {
    const _deps = deps({ userDataStream: {} });
    await keepAliveUserStream({ market: 'spot', account: '1', listenKey: 'k', _deps });
    assert.equal(_deps.fetch.calls[0].method, 'PUT');
    assert.match(_deps.fetch.calls[0].url, /\/api\/v3\/userDataStream\?listenKey=k/);
    await assert.rejects(keepAliveUserStream({ market: 'spot', account: '1', _deps: deps() }), /listenKey is required/);
  });
  it('closeUserStream DELETEs the futures endpoint', async () => {
    const _deps = deps({ listenKey: {} });
    await closeUserStream({ market: 'futures', account: '1', _deps });
    assert.equal(_deps.fetch.calls[0].method, 'DELETE');
    assert.match(_deps.fetch.calls[0].url, /\/fapi\/v1\/listenKey/);
  });
  it('routes the requested account for the listenKey', async () => {
    const seen = [];
    const _deps = { fetch: mockFetch({ listenKey: { listenKey: 'k2' } }), getKeys: (a) => { seen.push(a); return { key: 'k', secret: 's' }; }, now: () => 1700000000000 };
    await startUserStream({ market: 'futures', account: '2', _deps });
    assert.deepEqual(seen, ['2']);
  });
});

describe('getIncome', () => {
  it('summarizes income by type', async () => {
    const _deps = deps({ income: [
      { incomeType: 'REALIZED_PNL', income: '10', asset: 'USDC' },
      { incomeType: 'REALIZED_PNL', income: '5', asset: 'USDC' },
      { incomeType: 'FUNDING_FEE', income: '-2', asset: 'USDC' },
    ] });
    const r = await getIncome({ market: 'futures', symbol: 'BTCUSDC', _deps });
    assert.equal(r.count, 3);
    assert.equal(r.summary.REALIZED_PNL, 15);
    assert.equal(r.summary.FUNDING_FEE, -2);
    assert.match(_deps.fetch.calls[0].url, /\/fapi\/v1\/income/);
  });
});

describe('getLiquidationHistory', () => {
  it('hits forceOrders with symbol + capped limit', async () => {
    const _deps = deps({ forceOrders: [{ symbol: 'BTCUSDC', side: 'SELL', type: 'LIMIT', origQty: '0.5', avgPrice: '60000' }] });
    const r = await getLiquidationHistory({ market: 'futures', symbol: 'BTCUSDC', limit: 999, _deps });
    assert.equal(r.count, 1);
    assert.match(_deps.fetch.calls[0].url, /\/fapi\/v1\/forceOrders/);
    assert.match(_deps.fetch.calls[0].url, /symbol=BTCUSDC/);
    assert.match(_deps.fetch.calls[0].url, /limit=100/); // clamped to the 100 max
  });
  it('passes autoCloseType and routes COIN-M to /dapi', async () => {
    const _deps = deps({ forceOrders: [] });
    await getLiquidationHistory({ market: 'coinm', autoCloseType: 'liquidation', _deps });
    assert.match(_deps.fetch.calls[0].url, /\/dapi\/v1\/forceOrders/);
    assert.match(_deps.fetch.calls[0].url, /autoCloseType=LIQUIDATION/);
  });
  it('rejects a bad autoCloseType and is futures-only', async () => {
    await assert.rejects(getLiquidationHistory({ market: 'futures', autoCloseType: 'nope', _deps: deps() }), /autoCloseType must be/);
    await assert.rejects(getLiquidationHistory({ market: 'spot', _deps: deps() }), /futures-only/);
  });
});

describe('wallet history / address (SAPI, spot host)', () => {
  it('getDepositHistory hits capital/deposit/hisrec on the spot host', async () => {
    const _deps = deps({ 'capital/deposit/hisrec': [{ coin: 'USDC', amount: '100', status: 1 }] });
    const r = await getDepositHistory({ coin: 'usdc', _deps });
    assert.equal(r.count, 1);
    assert.match(_deps.fetch.calls[0].url, /api\.binance\.com\/sapi\/v1\/capital\/deposit\/hisrec/);
    assert.match(_deps.fetch.calls[0].url, /coin=USDC/);
  });
  it('getWithdrawHistory hits capital/withdraw/history', async () => {
    const _deps = deps({ 'capital/withdraw/history': [] });
    const r = await getWithdrawHistory({ _deps });
    assert.equal(r.count, 0);
    assert.match(_deps.fetch.calls[0].url, /\/sapi\/v1\/capital\/withdraw\/history/);
  });
  it('getDepositAddress returns address fields and requires coin', async () => {
    const _deps = deps({ 'capital/deposit/address': { coin: 'USDC', address: '0xabc', tag: '', url: 'https://x', network: 'ETH' } });
    const r = await getDepositAddress({ coin: 'USDC', network: 'eth', _deps });
    assert.equal(r.address, '0xabc');
    assert.equal(r.network, 'ETH');
    assert.match(_deps.fetch.calls[0].url, /\/sapi\/v1\/capital\/deposit\/address/);
    await assert.rejects(getDepositAddress({ _deps: deps() }), /coin is required/);
  });
});

describe('getAccountSnapshot', () => {
  it('aggregates summary + positions + open-order counts', async () => {
    const _deps = deps({
      'fapi/v2/account': { totalWalletBalance: '50000', totalUnrealizedProfit: '-1600', totalMarginBalance: '48400', availableBalance: '15000', totalMaintMargin: '2420' },
      positionRisk: [{ symbol: 'BTCUSDC', positionAmt: '1.6', entryPrice: '60000', markPrice: '59000', unRealizedProfit: '-1600.123', leverage: '3' }],
      openOrders: [{ orderId: 1 }, { orderId: 2 }],
      openAlgoOrders: [{ algoId: 9 }],
    });
    const r = await getAccountSnapshot({ market: 'futures', symbol: 'BTCUSDC', _deps });
    assert.equal(r.openOrders, 2);
    assert.equal(r.openAlgoOrders, 1);
    assert.equal(r.positions[0].side, 'LONG');
    assert.equal(r.positions[0].uPnl, -1600.12);
    assert.equal(r.marginRatio, '5.00%');
  });
});

describe('ensureProtectiveStop', () => {
  it('does nothing when a closePosition stop already rests', async () => {
    const _deps = deps({ openAlgoOrders: [{ algoId: 7, orderType: 'STOP_MARKET', closePosition: true, triggerPrice: '58900', positionSide: 'LONG' }], openOrders: [] });
    const r = await ensureProtectiveStop({ market: 'futures', symbol: 'BTCUSDC', stop: 58900, _deps });
    assert.equal(r.action, 'none');
    assert.equal(r.exists, true);
    assert.equal(posts(_deps.fetch).length, 0);
  });
  it('dry-run when a position has no stop', async () => {
    const _deps = deps({ openOrders: [], openAlgoOrders: [], positionRisk: [{ symbol: 'BTCUSDC', positionAmt: '1.6', entryPrice: '60000', markPrice: '59000', unRealizedProfit: '-1600', leverage: '3' }] });
    const r = await ensureProtectiveStop({ market: 'futures', symbol: 'BTCUSDC', stop: 58900, _deps });
    assert.equal(r.dry_run, true);
    assert.equal(r.action, 'would_place');
    assert.equal(r.stop_preview.side, 'SELL');
    assert.equal(r.stop_preview.positionSide, 'LONG');
  });
  it('confirm places a closePosition STOP_MARKET via the algo endpoint', async () => {
    const _deps = deps({ openOrders: [], openAlgoOrders: [], positionRisk: [{ symbol: 'BTCUSDC', positionAmt: '1.6', entryPrice: '60000', markPrice: '59000', unRealizedProfit: '-1600', leverage: '3' }], algoOrder: { algoId: 555 } });
    const r = await ensureProtectiveStop({ market: 'futures', symbol: 'BTCUSDC', stop: 58900, confirm: true, _deps });
    assert.equal(r.action, 'placed');
    assert.equal(r.stop.algoId, 555);
    assert.ok(posts(_deps.fetch).some((c) => /algoOrder/.test(c.url)));
  });
  it('warns when there is no position and no stop', async () => {
    const _deps = deps({ openOrders: [], openAlgoOrders: [], positionRisk: [] });
    const r = await ensureProtectiveStop({ market: 'futures', symbol: 'BTCUSDC', stop: 58900, _deps });
    assert.equal(r.success, false);
    assert.match(r.warning, /no open position/);
  });
});

// ── isolated-margin adjustment (borrowed from muvon/mcp-binance-futures) ──────
describe('adjustIsolatedMargin', () => {
  it('dry-run previews type=1 (add) and sends nothing', async () => {
    const _deps = deps();
    const r = await adjustIsolatedMargin({ market: 'futures', symbol: 'BTCUSDC', amount: 25, direction: 'add', _deps });
    assert.equal(r.dry_run, true);
    assert.equal(r.margin_preview.type, '1');
    assert.equal(r.margin_preview.amount, '25');
    assert.match(r.margin_preview.endpoint, /\/fapi\/v1\/positionMargin/);
    assert.equal(posts(_deps.fetch).length, 0);
  });
  it('confirm POSTs type=2 (remove) to positionMargin', async () => {
    const _deps = deps({ positionMargin: { code: 200, msg: 'success', amount: 25, type: 2 } });
    const r = await adjustIsolatedMargin({ market: 'futures', symbol: 'BTCUSDC', amount: 25, direction: 'remove', positionSide: 'LONG', confirm: true, _deps });
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
    const _deps = deps({ positionMargin: { code: 200 } });
    await adjustIsolatedMargin({ market: 'coinm', symbol: 'BTCUSD_PERP', amount: 1, positionSide: 'SHORT', confirm: true, _deps });
    assert.match(posts(_deps.fetch)[0].url, /\/dapi\/v1\/positionMargin/);
  });
  it('throws on confirm in Hedge Mode when positionSide is omitted', async () => {
    const _deps = deps({ 'positionSide/dual': { dualSidePosition: true } });
    await assert.rejects(
      adjustIsolatedMargin({ market: 'futures', symbol: 'BTCUSDC', amount: 25, confirm: true, _deps }),
      /Hedge Mode/,
    );
  });
  it('rejects a non-positive amount and a bad direction', async () => {
    await assert.rejects(adjustIsolatedMargin({ symbol: 'BTCUSDC', amount: 0, _deps: deps() }), /amount must be > 0/);
    await assert.rejects(adjustIsolatedMargin({ symbol: 'BTCUSDC', amount: 5, direction: 'sideways', _deps: deps() }), /direction must be/);
  });
  it('is futures-only', async () => {
    await assert.rejects(adjustIsolatedMargin({ market: 'spot', symbol: 'BTCUSDC', amount: 5, _deps: deps() }), /futures-only/);
  });
});

// ── risk sizing / risk report / rate-limit backoff ───────────────────────────
describe('calcPositionSize', () => {
  it('sizes from an explicit risk amount and computes notional + margin', async () => {
    // entry 60000, stop 58000 → risk/unit 2000; risk $1000 → qty 0.5 (snapped to 0.001 step)
    const r = await calcPositionSize({ market: 'futures', symbol: 'BTCUSDC', entry: 60000, stop: 58000, leverage: 3, riskAmount: 1000, _deps: deps() });
    assert.equal(r.quantity, 0.5);
    assert.equal(r.notional, 30000);
    assert.equal(r.requiredMargin, 10000);
    assert.equal(r.side, 'LONG (BUY)');
  });
  it('derives risk from riskPct × balance and flags >3x implied leverage', async () => {
    // balance 50000, 5% → risk 2500; entry 60000 stop 59000 → unit 1000 → qty 2.5 → notional 150000 → 3x
    const r = await calcPositionSize({ market: 'futures', symbol: 'BTCUSDC', entry: 60000, stop: 59000, leverage: 3, riskPct: 5, balance: 50000, _deps: deps() });
    assert.equal(r.quantity, 2.5);
    assert.equal(r.notional, 150000);
    assert.equal(r.impliedAccountLeverage, 3);
    // exactly 3x → no breach warning
    assert.ok(!(r.warnings || []).some((w) => /implied account leverage/.test(w)));
  });
  it('warns when leverage exceeds the 3x rule', async () => {
    const r = await calcPositionSize({ market: 'futures', symbol: 'BTCUSDC', entry: 60000, stop: 59000, leverage: 5, riskAmount: 100, _deps: deps() });
    assert.ok((r.warnings || []).some((w) => /3x rule/.test(w)));
  });
  it('requires entry !== stop and a risk budget', async () => {
    await assert.rejects(calcPositionSize({ market: 'futures', symbol: 'BTCUSDC', entry: 60000, stop: 60000, riskAmount: 100, _deps: deps() }), /must differ/);
    await assert.rejects(calcPositionSize({ market: 'futures', symbol: 'BTCUSDC', entry: 60000, stop: 59000, _deps: deps() }), /riskAmount.*riskPct/);
  });
});

describe('calcExpectancy — the math of expectancy', () => {
  it('reproduces the 50% / 2:1 / $100 → $5000-over-100-trades example', () => {
    const r = calcExpectancy({ winRate: 50, rrRatio: 2, riskAmount: 100, trades: 100 });
    assert.equal(r.expectancyR, 0.5);              // 0.5·2 − 0.5·1
    assert.equal(r.expectancyPerTrade, 50);        // 0.5R × $100
    assert.equal(r.expectedPnlOverTrades, 5000);   // × 100 trades
    assert.equal(r.edge, 'positive');
  });
  it('computes break-even win rate 1/(1+rr) — 33.33% for 2:1', () => {
    const r = calcExpectancy({ winRate: 40, rrRatio: 2 });
    assert.equal(r.breakevenWinRatePct, 33.33);
    assert.equal(r.marginOverBreakevenPct, 6.67);  // 40 − 33.33
  });
  it('flags a negative edge below break-even', () => {
    const r = calcExpectancy({ winRate: 30, rrRatio: 2 });
    assert.equal(r.edge, 'negative');
    assert.ok(r.expectancyR < 0);
  });
  it('derives $ risk from riskPct × balance and a %-per-trade expectancy', () => {
    const r = calcExpectancy({ winRate: 50, rrRatio: 2, riskPct: 1, balance: 10000 });
    assert.equal(r.riskPerTrade, 100);
    assert.equal(r.expectancyPctPerTrade, 0.5);    // 0.5R × 1%
  });
  it('rejects bad inputs', () => {
    assert.throws(() => calcExpectancy({ winRate: 50, rrRatio: 0 }), /rrRatio/);
    assert.throws(() => calcExpectancy({ winRate: 120, rrRatio: 2 }), /winRate/);
  });
});

describe('estimateLosingStreak — Nick Radge probabilistic estimate', () => {
  it("matches the video's numbers: 90%/1000→3, 90%/1M→6, 60%/1000→8", () => {
    assert.equal(estimateLosingStreak({ winRate: 90, sampleSize: 1000 }).maxLosingStreak, 3);
    assert.equal(estimateLosingStreak({ winRate: 90, sampleSize: 1000000 }).maxLosingStreak, 6);
    assert.equal(estimateLosingStreak({ winRate: 60, sampleSize: 1000 }).maxLosingStreak, 8);
  });
  it('returns a table across sample sizes', () => {
    const r = estimateLosingStreak({ winRate: 60, sampleSize: 1000 });
    assert.equal(r.table.length, 5);
    assert.equal(r.table.find((t) => t.sampleSize === 1000000).maxLosingStreak, 16);
  });
  it('adds the implied drawdown when riskPct is given', () => {
    const r = estimateLosingStreak({ winRate: 60, sampleSize: 1000, riskPct: 2 });
    assert.equal(r.streakDrawdownPctFixed, 16);    // 8 losses × 2%
    assert.ok(r.streakDrawdownPctCompounded < 16); // geometric is gentler
    assert.ok(r.streakDrawdownPctCompounded > 14);
  });
  it('rejects win rates at or beyond the bounds', () => {
    assert.throws(() => estimateLosingStreak({ winRate: 100 }), /strictly between/);
    assert.throws(() => estimateLosingStreak({ winRate: 0 }), /strictly between/);
  });
});

describe('simulateEquity — Monte Carlo (deterministic via injected rng)', () => {
  // rng that always wins (returns 0 < p) → every trade is a win, no drawdown, no ruin
  const alwaysWin = () => 0;
  // rng that always loses (returns ~1 ≥ p) → every trade loses
  const alwaysLose = () => 0.999999;
  it('all-wins run: positive return, zero drawdown, zero ruin', () => {
    const r = simulateEquity({ winRate: 50, rrRatio: 2, riskPct: 1, trades: 100, runs: 5, _deps: { rng: alwaysWin } });
    assert.equal(r.ruinRunsPct, 0);
    assert.equal(r.maxDrawdownPct.worst, 0);
    assert.equal(r.profitableRunsPct, 100);
    assert.ok(r.finalReturnPct.median > 0);
  });
  it('all-losses run: every run ruined, longest streak = trade count', () => {
    const r = simulateEquity({ winRate: 50, rrRatio: 2, riskPct: 2, trades: 50, runs: 5, ruinDrawdownPct: 50, _deps: { rng: alwaysLose } });
    assert.equal(r.ruinRunsPct, 100);
    assert.equal(r.profitableRunsPct, 0);
    assert.equal(r.longestLosingStreak.worst, 50);
  });
  it('caps trades and runs, echoes inputs', () => {
    const r = simulateEquity({ winRate: 55, rrRatio: 1, trades: 999999, runs: 99999, _deps: { rng: alwaysWin } });
    assert.equal(r.inputs.trades, 100000);
    assert.equal(r.inputs.runs, 10000);
  });
  it('rejects bad inputs', () => {
    assert.throws(() => simulateEquity({ winRate: 50, rrRatio: 0 }), /rrRatio/);
    assert.throws(() => simulateEquity({ winRate: 50, rrRatio: 2, riskPct: 0 }), /riskPct/);
  });
});

describe('getRiskReport', () => {
  it('computes per-position liq distance, % of equity and gross exposure', async () => {
    const _deps = deps({
      'fapi/v2/account': { totalWalletBalance: '50000', totalUnrealizedProfit: '-1000', totalMarginBalance: '49000', availableBalance: '20000', totalMaintMargin: '490' },
      positionRisk: [{ symbol: 'BTCUSDC', positionAmt: '1.6', entryPrice: '60000', markPrice: '59000', liquidationPrice: '45000', leverage: '3', unRealizedProfit: '-1600' }],
    });
    const r = await getRiskReport({ market: 'futures', _deps });
    assert.equal(r.positions.length, 1);
    assert.equal(r.positions[0].notional, 94400); // 1.6 × 59000
    // distance to liq: |59000-45000|/59000 = 23.73%
    assert.equal(r.positions[0].distanceToLiqPct, 23.73);
    assert.equal(r.grossExposure, 94400);
    assert.equal(r.exposureToEquity, '1.93x'); // 94400 / 49000
  });
});

describe('signedRequest — rate-limit backoff', () => {
  it('retries on a 429 then succeeds (no real sleep)', async () => {
    let n = 0;
    const fetch = async (url, _opts = {}) => {
      // exchangeInfo etc. not needed here; getOrderHistory only signs allOrders
      n += 1;
      if (n === 1) return { ok: false, status: 429, headers: { get: () => null }, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ([{ orderId: 1, status: 'FILLED' }]) };
    };
    fetch.calls = [];
    const _deps = { fetch, keys: { key: 'k', secret: 's' }, now: () => 1700000000000, sleep: () => Promise.resolve() };
    const r = await getOrderHistory({ market: 'futures', symbol: 'BTCUSDC', _deps });
    assert.equal(r.success, true);
    assert.equal(r.count, 1);
    assert.equal(n, 2); // one 429, one success
  });
});

// ── watchPrice — bounded WebSocket capture ──────────────────────────────────
// Fake WebSocket: delivers `messages` then optionally a close, all on a microtask.
function makeWS({ messages = [], closeAfter = true } = {}) {
  const seen = { url: null };
  const cls = class {
    constructor(url) {
      seen.url = url;
      this._l = {};
      queueMicrotask(() => {
        for (const data of messages) (this._l.message || []).forEach((cb) => cb({ data: JSON.stringify(data) }));
        if (closeAfter) (this._l.close || []).forEach((cb) => cb());
      });
    }
    addEventListener(ev, cb) { (this._l[ev] ||= []).push(cb); }
    close() {}
  };
  return { cls, seen };
}
// Timer deps that never auto-fire — the fake socket's close drives resolution.
const inertTimers = { setTimeout: () => 0, clearTimeout: () => {} };

describe('watchPrice', () => {
  it('subscribes to the lowercase <symbol>@aggTrade stream on the futures host', async () => {
    const { cls, seen } = makeWS({ messages: [{ p: '64800.0', q: '1', T: 1 }] });
    await watchPrice({ market: 'futures', symbol: 'BTCUSDC', _deps: { WebSocket: cls, ...inertTimers } });
    assert.equal(seen.url, 'wss://fstream.binance.com/ws/btcusdc@aggTrade');
  });

  it('summarizes OHLC, change, VWAP and volume from the captured ticks', async () => {
    const messages = [
      { p: '100', q: '2', T: 10 },
      { p: '110', q: '1', T: 20 },
      { p: '90', q: '1', T: 30 },
      { p: '105', q: '2', T: 40 },
    ];
    const { cls } = makeWS({ messages });
    const r = await watchPrice({ market: 'spot', symbol: 'btcusdt', durationSec: 5, _deps: { WebSocket: cls, ...inertTimers } });
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
    const { cls } = makeWS({ messages: [{ p: '1', q: '1', T: 1 }] });
    const hi = await watchPrice({ symbol: 'BTCUSDC', durationSec: 999, _deps: { WebSocket: cls, ...inertTimers } });
    assert.equal(hi.durationSec, 60);
    const lo = await watchPrice({ symbol: 'BTCUSDC', durationSec: 0, _deps: { WebSocket: cls, ...inertTimers } });
    assert.equal(lo.durationSec, 10); // 0 -> falls back to default 10
  });

  it('returns a note (not an error) when no trades arrive before the window ends', async () => {
    const { cls } = makeWS({ messages: [], closeAfter: false });
    // setTimeout fires immediately to end the empty window.
    const r = await watchPrice({ symbol: 'BTCUSDC', _deps: { WebSocket: cls, setTimeout: (fn) => { fn(); return 0; }, clearTimeout: () => {} } });
    assert.equal(r.success, true);
    assert.equal(r.ticks, 0);
    assert.match(r.note, /No trades observed/);
    assert.equal(r.open, undefined);
  });

  it('rejects an unknown market', async () => {
    const { cls } = makeWS();
    await assert.rejects(
      watchPrice({ market: 'nope', symbol: 'BTCUSDC', _deps: { WebSocket: cls, ...inertTimers } }),
      /unknown market/,
    );
  });
});

describe('watchOrderFlow', () => {
  it('builds a combined stream URL (aggTrade + depth + bookTicker)', async () => {
    const { cls, seen } = makeWS({ messages: [{ data: { e: 'aggTrade', p: '1', q: '1', m: false, T: 1 } }] });
    await watchOrderFlow({ market: 'futures', symbol: 'BTCUSDC', levels: 20, _deps: { WebSocket: cls, ...inertTimers } });
    assert.equal(seen.url, 'wss://fstream.binance.com/stream?streams=btcusdc@aggTrade/btcusdc@depth20@100ms/btcusdc@bookTicker');
  });

  it('summarizes aggression delta, spread and depth imbalance', async () => {
    const { cls } = makeWS({
      messages: [
        { data: { e: 'aggTrade', p: '100', q: '2', m: false, T: 10 } },
        { data: { e: 'aggTrade', p: '101', q: '1', m: true, T: 11 } },
        { data: { e: 'depthUpdate', b: [['100', '5'], ['99', '2']], a: [['101', '4'], ['102', '3']], E: 12 } },
        { data: { s: 'BTCUSDC', b: '100', B: '1', a: '101', A: '1', E: 13 } },
      ],
    });
    const r = await watchOrderFlow({ symbol: 'BTCUSDC', _deps: { WebSocket: cls, ...inertTimers } });
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
    const r = await getFootprintBars({ market: 'futures', symbol: 'BTCUSDC', interval: '1m', _deps: deps({ 'fapi/v1/klines': kl }) });
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
      _deps: deps({ 'fapi/v1/klines': kl }),
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
      if (String(url).includes('/eapi/v1/exchangeInfo')) return { ok: true, status: 200, json: async () => exchangeInfo };
      if (String(url).includes('/eapi/v1/mark')) return { ok: true, status: 200, json: async () => marks };
      if (String(url).includes('/eapi/v1/index')) return { ok: true, status: 200, json: async () => idx };
      return { ok: true, status: 200, json: async () => ({}) };
    },
  });

  it('builds an options IV surface and computes ATM call-put skew per expiry', async () => {
    const exchangeInfo = {
      optionSymbols: [
        { symbol: 'BTC-260626-60000-C', underlying: 'BTCUSDT', expiryDate: Date.UTC(2026, 5, 26), strikePrice: '60000', side: 'CALL' },
        { symbol: 'BTC-260626-60000-P', underlying: 'BTCUSDT', expiryDate: Date.UTC(2026, 5, 26), strikePrice: '60000', side: 'PUT' },
        { symbol: 'BTC-260926-65000-C', underlying: 'BTCUSDT', expiryDate: Date.UTC(2026, 8, 26), strikePrice: '65000', side: 'CALL' },
      ],
    };
    const marks = [
      { symbol: 'BTC-260626-60000-C', markIV: '0.55', bidIV: '0.54', askIV: '0.56', delta: '0.52', gamma: '0.01', theta: '-0.02', vega: '0.12', markPrice: '2200' },
      { symbol: 'BTC-260626-60000-P', markIV: '0.60', bidIV: '0.59', askIV: '0.61', delta: '-0.48', gamma: '0.01', theta: '-0.02', vega: '0.11', markPrice: '2400' },
      { symbol: 'BTC-260926-65000-C', markIV: '0.50', bidIV: '0.49', askIV: '0.51', delta: '0.35', gamma: '0.008', theta: '-0.015', vega: '0.10', markPrice: '1800' },
    ];
    const idx = { indexPrice: '60123.4' };
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
        { symbol: 'BTC-260626-60000-C', underlying: 'BTCUSDT', expiryDate: Date.UTC(2026, 5, 26), strikePrice: '60000', side: 'CALL' },
        { symbol: 'BTC-260926-60000-C', underlying: 'BTCUSDT', expiryDate: Date.UTC(2026, 8, 26), strikePrice: '60000', side: 'CALL' },
      ],
    };
    const marks = [
      { symbol: 'BTC-260626-60000-C', markIV: '0.55' },
      { symbol: 'BTC-260926-60000-C', markIV: '0.50' },
    ];
    const r = await getOptionsSurface({
      underlying: 'BTCUSDT', expirations: ['20260626'],
      _deps: optionsDeps(exchangeInfo, marks, { indexPrice: '60000' }),
    });
    assert.equal(r.success, true);
    assert.equal(r.contracts, 1);
    assert.equal(r.expiries.length, 1);
    assert.equal(r.expiries[0].expiry, '20260626');
  });
});

// ── buildMarketStream — combined public-stream URL builder ──────────────────
describe('buildMarketStream', () => {
  it('builds a multiplexed combined-stream URL (symbols × streams) on the futures host', () => {
    const r = buildMarketStream({ market: 'futures', symbols: 'BTCUSDC,ETHUSDC', streams: 'trade,bookTicker' });
    assert.equal(r.success, true);
    assert.deepEqual(r.subscriptions, ['btcusdc@trade', 'btcusdc@bookTicker', 'ethusdc@trade', 'ethusdc@bookTicker']);
    assert.equal(r.wsUrl, 'wss://fstream.binance.com/stream?streams=btcusdc@trade/btcusdc@bookTicker/ethusdc@trade/ethusdc@bookTicker');
  });

  it('accepts arrays, uppercases symbols, and de-duplicates subscriptions', () => {
    const r = buildMarketStream({ market: 'spot', symbols: ['btcusdt', 'BTCUSDT'], streams: ['trade', 'trade'] });
    assert.deepEqual(r.symbols, ['BTCUSDT']);
    assert.deepEqual(r.subscriptions, ['btcusdt@trade']);
    assert.match(r.wsUrl, /^wss:\/\/stream\.binance\.com:9443\/stream\?streams=btcusdt@trade$/);
  });

  it('maps kline[:interval] (default 1m) and folds funding into the markPrice stream', () => {
    const r = buildMarketStream({ market: 'futures', symbols: 'BTCUSDC', streams: 'kline:5m,kline,markPrice,funding' });
    assert.deepEqual(r.subscriptions, ['btcusdc@kline_5m', 'btcusdc@kline_1m', 'btcusdc@markPrice@1s']);
  });

  it('rejects markPrice/funding on spot (futures-only) and unknown stream kinds', () => {
    assert.throws(() => buildMarketStream({ market: 'spot', symbols: 'BTCUSDT', streams: 'markPrice' }), /futures-only/);
    assert.throws(() => buildMarketStream({ market: 'spot', symbols: 'BTCUSDT', streams: 'funding' }), /futures-only/);
    assert.throws(() => buildMarketStream({ market: 'futures', symbols: 'BTCUSDC', streams: 'depth' }), /unknown stream/);
  });

  it('requires symbols and an unknown market throws', () => {
    assert.throws(() => buildMarketStream({ market: 'futures', symbols: '', streams: 'trade' }), /symbols is required/);
    assert.throws(() => buildMarketStream({ market: 'nope', symbols: 'BTCUSDC' }), /unknown market/);
  });
});

// ── formatMarketEvent — compact normalization of stream payloads ────────────
describe('formatMarketEvent', () => {
  it('unwraps the combined-stream envelope and normalizes a trade', () => {
    const e = formatMarketEvent({ stream: 'btcusdc@trade', data: { e: 'trade', s: 'BTCUSDC', p: '64800.0', q: '0.5', T: 10, m: true } });
    assert.deepEqual(e, { event: 'trade', symbol: 'BTCUSDC', price: 64800, qty: 0.5, time: 10, buyerMaker: true });
  });

  it('normalizes a 24hrTicker into a compact ticker line', () => {
    const e = formatMarketEvent({ data: { e: '24hrTicker', s: 'BTCUSDC', c: '65000', P: '1.5', h: '66000', l: '64000', v: '100', q: '6500000' } });
    assert.deepEqual(e, { event: 'ticker', symbol: 'BTCUSDC', last: 65000, changePct: 1.5, high: 66000, low: 64000, volume: 100, quoteVolume: 6500000 });
  });

  it('normalizes a markPriceUpdate including the funding rate', () => {
    const e = formatMarketEvent({ data: { e: 'markPriceUpdate', s: 'BTCUSDC', p: '64810', i: '64800', r: '0.0001', T: 200, E: 100 } });
    assert.deepEqual(e, { event: 'markPrice', symbol: 'BTCUSDC', mark: 64810, index: 64800, fundingRate: 0.0001, nextFundingTime: 200, time: 100 });
  });

  it('normalizes a kline event from its k sub-object', () => {
    const e = formatMarketEvent({ data: { e: 'kline', s: 'BTCUSDC', k: { i: '1m', o: '1', h: '3', l: '0.5', c: '2', v: '10', x: true, t: 1, T: 2 } } });
    assert.deepEqual(e, { event: 'kline', symbol: 'BTCUSDC', interval: '1m', open: 1, high: 3, low: 0.5, close: 2, volume: 10, closed: true, openTime: 1, closeTime: 2 });
  });

  it('detects spot bookTicker (no e field) by its b/a/s shape', () => {
    const e = formatMarketEvent({ data: { u: 1, s: 'BTCUSDT', b: '64999', B: '1', a: '65001', A: '2' } });
    assert.equal(e.event, 'bookTicker');
    assert.equal(e.bid, 64999);
    assert.equal(e.ask, 65001);
  });

  it('falls back to {event,stream,raw} for unrecognized events', () => {
    const e = formatMarketEvent({ stream: 'btcusdc@forceOrder', data: { e: 'forceOrder', o: {} } });
    assert.equal(e.event, 'forceOrder');
    assert.equal(e.stream, 'btcusdc@forceOrder');
    assert.ok(e.raw);
  });
});

// ── compareSymbols — ranked multi-symbol comparison ─────────────────────────
// A fetch that returns per-symbol 24hr stats keyed on the URL's symbol= param.
function compareFetch(bySymbol) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const m = url.match(/symbol=([A-Z0-9]+)/);
    const sym = m ? m[1] : null;
    if (url.includes('ticker/24hr') && sym && bySymbol[sym]) {
      return { ok: true, status: 200, json: async () => ({ symbol: sym, ...bySymbol[sym] }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  fn.calls = calls;
  return fn;
}

describe('compareSymbols', () => {
  it('ranks by priceChangePercent (descending) with leader/laggard', async () => {
    const fetch = compareFetch({
      BTCUSDC: { lastPrice: '60000', priceChangePercent: '2.5', quoteVolume: '100' },
      ETHUSDC: { lastPrice: '3000', priceChangePercent: '-1.0', quoteVolume: '300' },
      SOLUSDC: { lastPrice: '150', priceChangePercent: '5.2', quoteVolume: '200' },
    });
    const r = await compareSymbols({ market: 'futures', symbols: 'BTCUSDC,ETHUSDC,SOLUSDC', _deps: { fetch } });
    assert.equal(r.count, 3);
    assert.equal(r.sortBy, 'priceChangePercent');
    assert.deepEqual(r.comparison.map((x) => x.symbol), ['SOLUSDC', 'BTCUSDC', 'ETHUSDC']);
    assert.deepEqual(r.comparison.map((x) => x.rank), [1, 2, 3]);
    assert.equal(r.leader, 'SOLUSDC');
    assert.equal(r.laggard, 'ETHUSDC');
  });

  it('sorts by quoteVolume when requested', async () => {
    const fetch = compareFetch({
      BTCUSDC: { priceChangePercent: '2.5', quoteVolume: '100' },
      ETHUSDC: { priceChangePercent: '-1.0', quoteVolume: '300' },
    });
    const r = await compareSymbols({ market: 'futures', symbols: ['BTCUSDC', 'ETHUSDC'], sortBy: 'quoteVolume', _deps: { fetch } });
    assert.equal(r.sortBy, 'quoteVolume');
    assert.deepEqual(r.comparison.map((x) => x.symbol), ['ETHUSDC', 'BTCUSDC']);
  });

  it('unknown sortBy falls back to priceChangePercent and dedupes symbols', async () => {
    const fetch = compareFetch({ BTCUSDC: { priceChangePercent: '1' } });
    const r = await compareSymbols({ symbols: 'BTCUSDC,btcusdc', sortBy: 'nope', _deps: { fetch } });
    assert.equal(r.sortBy, 'priceChangePercent');
    assert.equal(r.count, 1); // deduped (case-insensitive)
  });

  it('requires at least one symbol', async () => {
    await assert.rejects(compareSymbols({ symbols: '', _deps: { fetch: compareFetch({}) } }), /symbols is required/);
    await assert.rejects(compareSymbols({ _deps: { fetch: compareFetch({}) } }), /symbols is required/);
  });
});

// ── testnet switch ───────────────────────────────────────────────────────────
// The global BINANCE_TESTNET flag routes every market to its testnet host (and uses
// TESTNET credentials). _deps.testnet overrides the env for deterministic unit tests.
describe('testnet switch', () => {
  it('routes a public read to the testnet host with _deps.testnet', async () => {
    const _deps = { ...deps(), testnet: true };
    await getTicker({ market: 'futures', symbol: 'BTCUSDC', _deps });
    assert.match(_deps.fetch.calls[0].url, /testnet\.binancefuture\.com/);
  });

  it('routes a signed read to the testnet host', async () => {
    const _deps = { ...deps({ balance: [] }), testnet: true };
    await getBalance({ market: 'futures', _deps });
    const call = _deps.fetch.calls.find((c) => c.url.includes('/fapi/v2/balance'));
    assert.match(call.url, /testnet\.binancefuture\.com/);
  });

  it('uses the mainnet host without the switch', async () => {
    const _deps = deps();
    await getTicker({ market: 'futures', symbol: 'BTCUSDC', _deps });
    assert.match(_deps.fetch.calls[0].url, /fapi\.binance\.com/);
    assert.ok(!_deps.fetch.calls[0].url.includes('testnet'));
  });

  it('placeOrder dry-run reports live_funds:false under the switch', async () => {
    const _deps = { ...deps(), testnet: true };
    const r = await placeOrder({ market: 'futures', symbol: 'BTCUSDC', side: 'SELL', type: 'LIMIT', quantity: 1, price: 64800, _deps });
    assert.equal(r.order_preview.live_funds, false);
  });

  it('getServerTime reports the testnet flag and routes to the testnet host', async () => {
    const _deps = { ...deps({ time: { serverTime: 1700000000000 } }), testnet: true };
    const r = await getServerTime({ market: 'futures', _deps });
    assert.equal(r.testnet, true);
    assert.match(_deps.fetch.calls.find((c) => c.url.includes('/v1/time')).url, /testnet\.binancefuture\.com/);
  });

  it('an explicit *-testnet market routes to testnet even without the global switch', async () => {
    const _deps = deps();
    await getTicker({ market: 'futures-testnet', symbol: 'BTCUSDC', _deps });
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
      const base = mockFetch({ balance: [] });
      const headers = [];
      const fetch = async (url, opts = {}) => { headers.push(opts.headers?.['X-MBX-APIKEY']); return base(url, opts); };
      fetch.calls = base.calls;
      await getBalance({ market: 'futures', _deps: { fetch, now: () => 1700000000000 } });
      assert.ok(headers.includes('tk')); // signed with the TESTNET key, not BINANCE_API_KEY
      assert.match(fetch.calls.find((c) => c.url.includes('balance')).url, /testnet\.binancefuture\.com/);
    } finally {
      for (const [k, v] of [['BINANCE_TESTNET', saved.flag], ['BINANCE_TESTNET_API_KEY', saved.key], ['BINANCE_TESTNET_API_SECRET', saved.secret]]) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });
});

// ── Technical analysis (computed off klines) ─────────────────────────────────
// Build deterministic positional klines: [openTime, open, high, low, close, volume, closeTime, …].
// `fn(i)` drives the close; high/low straddle it. No Math.random — fully reproducible.
function genKlines(n, fn) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const c = fn(i);
    out.push([i * 3600000, String(c), String(c + 50), String(c - 50), String(c), '10', i * 3600000 + 1, '600000', 50, '5', '300000', '0']);
  }
  return out;
}

describe('getTechnicals — indicators off klines', () => {
  it('computes RSI/ATR/MACD/SMA/EMA/Bollinger/VWAP and classifies an uptrend', async () => {
    const _deps = deps({ klines: genKlines(120, (i) => 60000 + i * 30 + i * i * 0.4) }); // accelerating uptrend → +MACD hist
    const r = await getTechnicals({ market: 'futures', symbol: 'BTCUSDC', interval: '1h', _deps });
    assert.equal(r.success, true);
    assert.equal(r.bars, 120);
    assert.equal(typeof r.atr, 'number');
    assert.ok(r.atr > 0);
    assert.ok(r.rsi >= 0 && r.rsi <= 100);
    assert.equal(typeof r.macd.hist, 'number');
    assert.equal(typeof r.sma['20'], 'number');
    assert.equal(typeof r.sma['50'], 'number');
    assert.equal(typeof r.ema['12'], 'number');
    assert.ok(r.bollinger.upper > r.bollinger.lower);
    assert.equal(typeof r.vwap, 'number');
    assert.equal(r.classification.trend, 'bullish'); // rising price + positive MACD hist
    assert.match(_deps.fetch.calls.find((c) => c.url.includes('klines')).url, /\/fapi\/v1\/klines/);
  });

  it('returns null indicators (not an error) when there are too few bars', async () => {
    const _deps = deps({ klines: genKlines(10, (i) => 100 + i) }); // < periods for ATR/MACD/SMA50
    const r = await getTechnicals({ market: 'futures', symbol: 'BTCUSDC', _deps });
    assert.equal(r.success, true);
    assert.equal(r.atr, null);
    assert.equal(r.macd, null);
    assert.equal(r.sma, null); // SMA20 needs 20 bars
  });

  it('requires a symbol', async () => {
    await assert.rejects(getTechnicals({ market: 'futures', _deps: deps() }), /symbol is required/);
  });
});

describe('calcPositionSize — ATR-derived stop', () => {
  it('derives a LONG stop below entry from ATR and sizes off it', async () => {
    const _deps = deps({ klines: genKlines(120, (i) => 60000 + i * 50) });
    const r = await calcPositionSize({ market: 'futures', symbol: 'BTCUSDC', entry: 66000, side: 'BUY', atrMult: 1.5, riskAmount: 100, _deps });
    assert.equal(r.atrStop.source, 'ATR');
    assert.equal(r.atrStop.atrMult, 1.5);
    assert.ok(r.atrStop.atr > 0);
    assert.ok(r.stop < 66000); // long → stop sits below entry
    assert.ok(r.quantity > 0);
    assert.equal(r.side, 'LONG (BUY)');
  });

  it('derives a SHORT stop above entry', async () => {
    const _deps = deps({ klines: genKlines(120, (i) => 60000 + i * 50) });
    const r = await calcPositionSize({ market: 'futures', symbol: 'BTCUSDC', entry: 66000, side: 'SELL', atrMult: 2, riskAmount: 100, _deps });
    assert.ok(r.stop > 66000);
  });

  it('rejects an ATR stop without a side', async () => {
    const _deps = deps({ klines: genKlines(120, (i) => 60000 + i * 50) });
    await assert.rejects(calcPositionSize({ market: 'futures', symbol: 'BTCUSDC', entry: 66000, atrMult: 1.5, riskAmount: 100, _deps }), /side/);
  });

  it('rejects when neither stop nor atrMult is given', async () => {
    await assert.rejects(calcPositionSize({ market: 'futures', symbol: 'BTCUSDC', entry: 66000, riskAmount: 100, _deps: deps() }), /pass stop, or atrMult/);
  });

  it('still works with an explicit stop (no ATR, no klines call)', async () => {
    const _deps = deps();
    const r = await calcPositionSize({ market: 'futures', symbol: 'BTCUSDC', entry: 66000, stop: 65000, riskAmount: 100, _deps });
    assert.equal(r.atrStop, undefined);
    assert.equal(r.stop, 65000);
    assert.equal(_deps.fetch.calls.filter((c) => c.url.includes('klines')).length, 0);
  });
});

describe('correlateSymbols — correlation + rankings off klines', () => {
  // Per-symbol klines: BTC and ETH rise together (corr≈1); INV mirrors BTC (corr≈-1).
  function corrDeps() {
    const series = {
      BTCUSDC: (i) => 60000 + i * 50 + Math.sin(i / 5) * 100,
      ETHUSDC: (i) => 3000 + i * 3 + Math.sin(i / 5) * 6,
      INVUSDC: (i) => 60000 - i * 50 - Math.sin(i / 5) * 100,
    };
    const fetch = async (url) => {
      if (url.includes('exchangeInfo')) return { ok: true, status: 200, json: async () => FILTERS };
      if (url.includes('klines')) {
        const m = url.match(/symbol=([A-Z]+)/);
        const fn = series[m && m[1]] || series.BTCUSDC;
        return { ok: true, status: 200, json: async () => genKlines(120, fn) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };
    fetch.calls = [];
    const wrapped = async (u, o) => { fetch.calls.push({ url: u }); return fetch(u, o); };
    wrapped.calls = fetch.calls;
    return { fetch: wrapped, keys: { key: 'k', secret: 's' }, now: () => 1700000000000 };
  }

  it('returns per-symbol stats, a correlation matrix and rankings', async () => {
    const r = await correlateSymbols({ market: 'futures', symbols: 'BTCUSDC,ETHUSDC,INVUSDC', interval: '1h', _deps: corrDeps() });
    assert.equal(r.success, true);
    assert.equal(r.count, 3);
    assert.equal(r.symbols[0].symbol, 'BTCUSDC');
    assert.equal(typeof r.symbols[0].volatilityPct, 'number');
    assert.equal(typeof r.symbols[0].sharpe, 'number');
    // diagonal is 1
    assert.equal(r.correlation.matrix[0][0], 1);
    // BTC vs ETH (both rising) strongly positive; BTC vs INV (mirror) strongly negative
    const idx = (s) => r.correlation.symbols.indexOf(s);
    assert.ok(r.correlation.matrix[idx('BTCUSDC')][idx('ETHUSDC')] > 0.8);
    assert.ok(r.correlation.matrix[idx('BTCUSDC')][idx('INVUSDC')] < -0.8);
    assert.equal(r.rankings.byReturn.length, 3);
    assert.equal(r.rankings.byVolatility.length, 3);
  });

  it('accepts an array and dedupes/caps, reports per-symbol fetch errors inline', async () => {
    const r = await correlateSymbols({ market: 'futures', symbols: ['BTCUSDC', 'ETHUSDC'], _deps: corrDeps() });
    assert.equal(r.count, 2);
  });

  it('requires at least two symbols', async () => {
    await assert.rejects(correlateSymbols({ market: 'futures', symbols: 'BTCUSDC', _deps: deps() }), /at least two symbols/);
  });
});

// ── Backtesting engine ───────────────────────────────────────────────────────
describe('backtestStrategy — off klines, no lookahead', () => {
  it('produces institutional metrics and a buy&hold benchmark on a trending series', async () => {
    const _deps = deps({ klines: genKlines(400, (i) => 60000 + i * 30 + Math.sin(i / 7) * 400) });
    const r = await backtestStrategy({ market: 'futures', symbol: 'BTCUSDC', interval: '1h', strategy: 'ema_cross', _deps });
    assert.equal(r.success, true);
    assert.equal(r.strategy, 'ema_cross');
    assert.equal(r.bars, 400);
    assert.equal(typeof r.totalReturnPct, 'number');
    assert.equal(typeof r.buyHoldReturnPct, 'number');
    assert.equal(typeof r.sharpe, 'number');
    assert.equal(typeof r.maxDrawdownPct, 'number');
    assert.ok(r.maxDrawdownPct <= 0); // drawdown is non-positive
    assert.equal(typeof r.tradeCount, 'number');
    assert.equal(r.trades, undefined);       // not attached by default
    assert.equal(r.equityCurve, undefined);
  });

  it('attaches trades and equity curve on request', async () => {
    const _deps = deps({ klines: genKlines(300, (i) => 50000 + i * 20) });
    const r = await backtestStrategy({ market: 'futures', symbol: 'BTCUSDC', strategy: 'supertrend', includeTrades: true, includeEquityCurve: true, _deps });
    assert.ok(Array.isArray(r.trades));
    assert.ok(Array.isArray(r.equityCurve));
    assert.equal(r.equityCurve.length, r.bars); // one point per bar (incl. the seed)
    if (r.trades.length) {
      assert.ok(['LONG', 'SHORT'].includes(r.trades[0].side));
      assert.equal(typeof r.trades[0].returnPct, 'number');
    }
  });

  it('allowShort:false clamps out short trades (long-only)', async () => {
    const _deps = deps({ klines: genKlines(300, (i) => 60000 - i * 20) }); // downtrend
    const r = await backtestStrategy({ market: 'futures', symbol: 'BTCUSDC', strategy: 'ema_cross', allowShort: false, includeTrades: true, _deps });
    assert.equal(r.longOnly, true);
    assert.ok(r.trades.every((t) => t.side === 'LONG'));
  });

  it('higher commission reduces net return (costs are charged on turnover)', async () => {
    const series = (i) => 60000 + Math.sin(i / 4) * 800; // choppy → frequent flips → more cost
    const lo = await backtestStrategy({ market: 'futures', symbol: 'BTCUSDC', strategy: 'macd', commission: 0, slippage: 0, _deps: deps({ klines: genKlines(300, series) }) });
    const hi = await backtestStrategy({ market: 'futures', symbol: 'BTCUSDC', strategy: 'macd', commission: 0.005, slippage: 0.005, _deps: deps({ klines: genKlines(300, series) }) });
    assert.ok(hi.totalReturnPct < lo.totalReturnPct);
  });

  it('rejects an unknown strategy and a missing symbol', async () => {
    await assert.rejects(backtestStrategy({ market: 'futures', symbol: 'BTCUSDC', strategy: 'nope', _deps: deps({ klines: genKlines(80, (i) => 100 + i) }) }), /unknown strategy/);
    await assert.rejects(backtestStrategy({ market: 'futures', _deps: deps() }), /symbol is required/);
  });

  it('rejects too few bars', async () => {
    await assert.rejects(backtestStrategy({ market: 'futures', symbol: 'BTCUSDC', _deps: deps({ klines: genKlines(40, (i) => 100 + i) }) }), /not enough candles/);
  });

  it('exposes all 9 strategy keys', () => {
    assert.equal(STRATEGY_KEYS.length, 9);
    for (const k of ['rsi', 'bollinger', 'macd', 'ema_cross', 'supertrend', 'donchian', 'rsi_pullback', 'keltner', 'triple_ema']) {
      assert.ok(STRATEGY_KEYS.includes(k), `missing ${k}`);
    }
  });
});

describe('compareStrategies — ranked table', () => {
  it('runs all strategies once and ranks them by the chosen metric', async () => {
    const _deps = deps({ klines: genKlines(400, (i) => 60000 + i * 25 + Math.sin(i / 6) * 300) });
    const r = await compareStrategies({ market: 'futures', symbol: 'BTCUSDC', sortBy: 'sharpe', _deps });
    assert.equal(r.success, true);
    assert.equal(r.ranked.length, 9);
    assert.equal(r.sortBy, 'sharpe');
    assert.equal(r.best, r.ranked[0].strategy);
    // descending by the sort key (nulls sink)
    for (let i = 1; i < r.ranked.length; i++) {
      assert.ok((r.ranked[i - 1].sharpe ?? -Infinity) >= (r.ranked[i].sharpe ?? -Infinity));
    }
    // only one klines fetch despite 9 strategies
    assert.equal(_deps.fetch.calls.filter((c) => c.url.includes('klines')).length, 1);
  });

  it('falls back to totalReturnPct for an invalid sortBy', async () => {
    const r = await compareStrategies({ market: 'futures', symbol: 'BTCUSDC', sortBy: 'bogus', _deps: deps({ klines: genKlines(200, (i) => 50000 + i * 10) }) });
    assert.equal(r.sortBy, 'totalReturnPct');
  });
});

describe('walkForwardBacktest — train/test verdict', () => {
  it('splits, scores both windows, and emits a verdict', async () => {
    const _deps = deps({ klines: genKlines(500, (i) => 60000 + i * 20 + Math.sin(i / 8) * 200) });
    const r = await walkForwardBacktest({ market: 'futures', symbol: 'BTCUSDC', strategy: 'ema_cross', limit: 500, _deps });
    assert.equal(r.success, true);
    assert.equal(r.trainRatio, 0.7);
    assert.ok(r.train && r.test);
    assert.ok(['ROBUST', 'MODERATE', 'WEAK', 'OVERFITTED', 'UNPROFITABLE', 'INCONCLUSIVE', 'INSUFFICIENT_DATA'].includes(r.verdict));
    assert.ok(typeof r.splitTime === 'number');
  });

  it('rejects an out-of-range trainRatio', async () => {
    await assert.rejects(walkForwardBacktest({ market: 'futures', symbol: 'BTCUSDC', trainRatio: 0.99, _deps: deps({ klines: genKlines(200, (i) => 100 + i) }) }), /trainRatio/);
  });
});

// ── Multi-timeframe / signal scan / candlesticks ─────────────────────────────
describe('getMultiTimeframe — confluence', () => {
  it('aggregates trend across timeframes and flags alignment', async () => {
    const _deps = deps({ klines: genKlines(300, (i) => 60000 + i * 40 + i * i * 0.5) }); // strong uptrend on every TF
    const r = await getMultiTimeframe({ market: 'futures', symbol: 'BTCUSDC', intervals: ['15m', '1h', '4h'], _deps });
    assert.equal(r.success, true);
    assert.equal(r.timeframes.length, 3);
    assert.equal(r.confluence.bullish, 3);
    assert.equal(r.confluence.score, 1);
    assert.equal(r.confluence.bias, 'bullish');
    assert.equal(r.confluence.aligned, true);
  });

  it('defaults to 15m/1h/4h/1d', async () => {
    const r = await getMultiTimeframe({ market: 'futures', symbol: 'BTCUSDC', _deps: deps({ klines: genKlines(300, (i) => 60000 + i * 10) }) });
    assert.deepEqual(r.timeframes.map((t) => t.interval), ['15m', '1h', '4h', '1d']);
  });
});

describe('scanSignals — symbol screening', () => {
  it('matches bullish symbols and dedupes/caps', async () => {
    const _deps = deps({ klines: genKlines(300, (i) => 60000 + i * 50 + i * i * 0.6) }); // uptrend for every symbol
    const r = await scanSignals({ market: 'futures', symbols: ['BTCUSDC', 'ETHUSDC'], signal: 'bullish', _deps });
    assert.equal(r.success, true);
    assert.equal(r.signal, 'bullish');
    assert.equal(r.scanned, 2);
    assert.equal(r.matchCount, 2);
    assert.equal(r.matches[0].trend, 'bullish');
  });

  it('rejects an unknown signal and an empty list', async () => {
    await assert.rejects(scanSignals({ market: 'futures', symbols: ['BTCUSDC'], signal: 'nope', _deps: deps() }), /unknown signal/);
    await assert.rejects(scanSignals({ market: 'futures', symbols: [], signal: 'oversold', _deps: deps() }), /at least one symbol/);
  });

  it('exposes the signal keys', () => {
    assert.ok(SCAN_SIGNAL_KEYS.includes('oversold'));
    assert.ok(SCAN_SIGNAL_KEYS.includes('breakdown'));
  });
});

describe('detectCandlestickPatterns', () => {
  // Build positional klines from explicit OHLC tuples [o,h,l,c].
  const candles = (rows) => rows.map((r, i) => [i * 3600000, String(r[0]), String(r[1]), String(r[2]), String(r[3]), '10', i * 3600000 + 1]);
  const csDeps = (rows) => {
    const fetch = async (url) => {
      if (url.includes('exchangeInfo')) return { ok: true, status: 200, json: async () => ({ symbols: [] }) };
      if (url.includes('klines')) return { ok: true, status: 200, json: async () => candles(rows) };
      return { ok: true, status: 200, json: async () => ({}) };
    };
    const wrapped = async (...a) => { (wrapped.calls ||= []).push({ url: a[0] }); return fetch(...a); };
    return { fetch: wrapped, keys: { key: 'k', secret: 's' }, now: () => 1700000000000 };
  };

  it('detects a bullish engulfing on the last bar', async () => {
    // prev bar bearish (100→95), last bar bullish engulfing it (94→102)
    const rows = [[100, 101, 99, 100], [100, 100.5, 94.5, 95], [94, 102.5, 93.5, 102]];
    const r = await detectCandlestickPatterns({ market: 'futures', symbol: 'BTCUSDC', lookback: 1, _deps: csDeps(rows) });
    assert.equal(r.success, true);
    assert.ok(r.lastBar.patterns.some((p) => p.pattern === 'bullish_engulfing' && p.bias === 'bullish'));
  });

  it('detects a doji on the last bar', async () => {
    const rows = [[100, 101, 99, 100], [100, 101, 99, 100], [100, 105, 95, 100.05]];
    const r = await detectCandlestickPatterns({ market: 'futures', symbol: 'BTCUSDC', lookback: 1, _deps: csDeps(rows) });
    assert.ok(r.lastBar.patterns.some((p) => p.pattern === 'doji'));
  });

  it('rejects with fewer than 3 candles', async () => {
    await assert.rejects(detectCandlestickPatterns({ market: 'futures', symbol: 'BTCUSDC', _deps: csDeps([[1, 2, 0.5, 1.5], [1, 2, 0.5, 1.5]]) }), /at least 3 candles/);
  });
});

describe('getSignal — composite decision score', () => {
  it('returns BUY with bullish reasons on a strong uptrend', async () => {
    const _deps = deps({ klines: genKlines(300, (i) => 50000 + i * 40 + i * i * 0.5) });
    const r = await getSignal({ market: 'futures', symbol: 'BTCUSDC', interval: '1h', _deps });
    assert.equal(r.success, true);
    assert.equal(r.signal, 'BUY');
    assert.ok(r.score > 0.3);
    assert.ok(r.bullishFactors > r.bearishFactors);
    assert.ok(Array.isArray(r.reasons) && r.reasons.length > 0);
    assert.ok(['low', 'moderate', 'high'].includes(r.confidence));
    assert.equal(r.multiTimeframe, undefined); // mtf off by default
  });

  it('returns SELL on a downtrend', async () => {
    const _deps = deps({ klines: genKlines(300, (i) => 90000 - i * 40 - i * i * 0.4) });
    const r = await getSignal({ market: 'futures', symbol: 'BTCUSDC', _deps });
    assert.equal(r.signal, 'SELL');
    assert.ok(r.score < -0.3);
    assert.ok(r.bearishFactors > r.bullishFactors);
  });

  it('flags overbought as a caution and dampens confidence', async () => {
    const _deps = deps({ klines: genKlines(300, (i) => 50000 + i * 60 + i * i * 0.8) }); // very steep → RSI ~100
    const r = await getSignal({ market: 'futures', symbol: 'BTCUSDC', _deps });
    assert.ok((r.cautions || []).some((c) => /overbought/.test(c)));
    assert.notEqual(r.confidence, 'high'); // a caution knocks "high" down to "moderate"
  });

  it('folds in multi-timeframe confluence when mtf:true', async () => {
    const _deps = deps({ klines: genKlines(300, (i) => 50000 + i * 40 + i * i * 0.5) });
    const r = await getSignal({ market: 'futures', symbol: 'BTCUSDC', mtf: true, _deps });
    assert.ok(r.multiTimeframe);
    assert.equal(typeof r.multiTimeframe.score, 'number');
    assert.ok(r.reasons.some((x) => /multi-timeframe/.test(x)));
  });

  it('requires a symbol', async () => {
    await assert.rejects(getSignal({ market: 'futures', _deps: deps() }), /symbol is required/);
  });
});
