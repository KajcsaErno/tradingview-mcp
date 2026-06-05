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
  placeLadder, ensureProtectiveStop, getFundingRate, getIncome, getAccountSnapshot,
  calcPositionSize, getRiskReport,
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
    const fetch = async (url, opts = {}) => {
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
