/**
 * Unit tests for src/core/binance.js — account: balances/summaries/snapshot,
 * risk report, leverage/margin/position-mode config, income, liquidation &
 * wallet history, transfers, and the account-routing regression suite.
 * Pure, no network.
 */
import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {
    cancelAlgoOrder,
    cancelOrder,
    getAccountSnapshot,
    getAccountSummary,
    getAccountTrades,
    getCommissionRate,
    getDepositAddress,
    getDepositHistory,
    getHistoricalTrades,
    getIncome,
    getLeverageBrackets,
    getLiquidationHistory,
    getOrder,
    getOrderHistory,
    getPositionMode,
    getRiskReport,
    getTransferHistory,
    getWithdrawHistory,
    placeOrder,
    setLeverage,
    setMarginType,
    setPositionMode,
    transfer,
} from '../src/core/binance.js';
import {deps, FILTERS, mockFetch, posts} from './_binance_helpers.js';

// ── Universal Transfer ──────────────────────────────────────────────────────
describe('transfer (wallet-to-wallet)', () => {
    it('dry-run previews UMFUTURE_MAIN and sends nothing', async () => {
        const _deps = deps();
        const r = await transfer({asset: 'USDC', amount: 100, from: 'futures', to: 'spot', _deps});
        assert.equal(r.dry_run, true);
        assert.equal(r.transfer_preview.type, 'UMFUTURE_MAIN');
        assert.equal(r.transfer_preview.asset, 'USDC');
        assert.equal(r.transfer_preview.amount, '100');
        assert.equal(posts(_deps.fetch).length, 0);
    });

    it('confirm POSTs to /sapi/v1/asset/transfer on the spot host', async () => {
        const _deps = deps({'/sapi/v1/asset/transfer': {tranId: 123456}});
        const r = await transfer({asset: 'USDC', amount: 100, from: 'futures', to: 'spot', confirm: true, _deps});
        assert.equal(r.success, true);
        assert.equal(r.tranId, 123456);
        const p = posts(_deps.fetch);
        assert.equal(p.length, 1);
        assert.match(p[0].url, /api\.binance\.com\/sapi\/v1\/asset\/transfer/);
    });

    it('derives correct types and validates wallets', async () => {
        const spotToCoinm = await transfer({asset: 'BTC', amount: 1, from: 'spot', to: 'coinm', _deps: deps()});
        assert.equal(spotToCoinm.transfer_preview.type, 'MAIN_CMFUTURE');
        await assert.rejects(transfer({asset: 'USDC', amount: 1, from: 'spot', to: 'spot', _deps: deps()}), /must differ/);
        await assert.rejects(transfer({asset: 'USDC', amount: 1, from: 'usdm', to: 'coinm', _deps: deps()}), /one side must be spot/);
    });

    it('getTransferHistory queries with the derived type', async () => {
        const _deps = deps({
            '/sapi/v1/asset/transfer': {
                total: 1,
                rows: [{asset: 'USDC', amount: '100', type: 'UMFUTURE_MAIN', status: 'CONFIRMED', tranId: 1}]
            }
        });
        const r = await getTransferHistory({from: 'futures', to: 'spot', _deps});
        assert.equal(r.type, 'UMFUTURE_MAIN');
        assert.equal(r.total, 1);
    });
});

// ── Multi-account: key resolution ────────────────────────────────────────────
describe('multi-account key resolution', () => {
    it('placeOrder account:"2" signs with the BINANCE_API_KEY_2 key set (via getKeys override)', async () => {
        const calls = [];
        const fetch = async (url, opts = {}) => {
            calls.push({url, method: opts.method || 'GET', apiKey: opts.headers?.['X-MBX-APIKEY']});
            if (url.includes('exchangeInfo')) return {ok: true, status: 200, json: async () => FILTERS};
            return {ok: true, status: 200, json: async () => ({orderId: 1, status: 'NEW'})};
        };
        const _deps = {fetch, getKeys: (acct) => ({key: `k${acct}`, secret: `s${acct}`}), now: () => 1700000000000};
        const r = await placeOrder({
            market: 'futures',
            symbol: 'BTCUSDC',
            side: 'SELL',
            type: 'LIMIT',
            quantity: 1,
            price: 64800,
            positionSide: 'SHORT',
            account: '2',
            confirm: true,
            _deps
        });
        assert.equal(r.success, true);
        assert.equal(r.account, '2');
        const post = calls.find((c) => c.method === 'POST' && c.url.includes('/fapi/v1/order'));
        assert.equal(post.apiKey, 'k2'); // resolved the second account's key
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
    const getKeys = (account) => {
        seen.push(account);
        return {key: `K_${account}`, secret: `S_${account}`};
    };
    return {_deps: {fetch, getKeys, now: () => 1700000000000}, seen, headers};
}

describe('account routing — signed calls use the requested account, not "1"', () => {
    it('getPositionMode', async () => {
        const {_deps, seen, headers} = routingDeps({'positionSide/dual': {dualSidePosition: true}});
        const r = await getPositionMode({account: '2', _deps});
        assert.equal(r.account, '2');
        assert.deepEqual(seen, ['2']);
        assert.ok(headers.includes('K_2'));
        assert.ok(!seen.includes('1'));
    });

    it('setLeverage', async () => {
        const {_deps, seen, headers} = routingDeps({leverage: {leverage: 3, symbol: 'BTCUSDC', maxNotionalValue: '1'}});
        await setLeverage({symbol: 'BTCUSDC', leverage: 3, account: '3', _deps});
        assert.deepEqual(seen, ['3']);
        assert.ok(headers.includes('K_3'));
    });

    it('setMarginType', async () => {
        const {_deps, seen} = routingDeps({marginType: {code: 200, msg: 'success'}});
        await setMarginType({symbol: 'BTCUSDC', marginType: 'CROSSED', account: '2', _deps});
        assert.deepEqual(seen, ['2']);
    });

    it('getCommissionRate', async () => {
        const {_deps, seen} = routingDeps({commissionRate: {makerCommissionRate: '0', takerCommissionRate: '0.0004'}});
        await getCommissionRate({symbol: 'BTCUSDC', account: '2', _deps});
        assert.deepEqual(seen, ['2']);
    });

    it('getOrder', async () => {
        const {_deps, seen} = routingDeps();
        await getOrder({symbol: 'BTCUSDC', orderId: 5, account: '2', _deps});
        assert.deepEqual(seen, ['2']);
    });

    it('cancelOrder', async () => {
        const {_deps, seen, headers} = routingDeps();
        await cancelOrder({symbol: 'BTCUSDC', orderId: 5, account: '2', _deps});
        assert.deepEqual(seen, ['2']);
        assert.ok(headers.includes('K_2'));
    });

    it('cancelAlgoOrder', async () => {
        const {_deps, seen} = routingDeps();
        await cancelAlgoOrder({algoId: 99, account: '2', _deps});
        assert.deepEqual(seen, ['2']);
    });

    it('getAccountTrades', async () => {
        const {_deps, seen} = routingDeps({userTrades: []});
        await getAccountTrades({symbol: 'BTCUSDC', account: '2', _deps});
        assert.deepEqual(seen, ['2']);
    });

    it('getHistoricalTrades (API-key header, spot)', async () => {
        const {_deps, seen, headers} = routingDeps({historicalTrades: []});
        await getHistoricalTrades({market: 'spot', symbol: 'BTCUSDC', account: '2', _deps});
        assert.deepEqual(seen, ['2']);
        assert.ok(headers.includes('K_2'));
    });

    it('transfer (confirmed)', async () => {
        const {_deps, seen, headers} = routingDeps({'asset/transfer': {tranId: 1}});
        await transfer({asset: 'USDC', amount: 10, from: 'futures', to: 'spot', account: '2', confirm: true, _deps});
        assert.deepEqual(seen, ['2']);
        assert.ok(headers.includes('K_2'));
    });

    it('getTransferHistory', async () => {
        const {_deps, seen} = routingDeps({'asset/transfer': {total: 0, rows: []}});
        await getTransferHistory({from: 'futures', to: 'spot', account: '2', _deps});
        assert.deepEqual(seen, ['2']);
    });

    it('getLiquidationHistory', async () => {
        const {_deps, seen, headers} = routingDeps({forceOrders: []});
        await getLiquidationHistory({market: 'futures', symbol: 'BTCUSDC', account: '2', _deps});
        assert.deepEqual(seen, ['2']);
        assert.ok(headers.includes('K_2'));
    });

    it('getDepositHistory', async () => {
        const {_deps, seen} = routingDeps({'capital/deposit/hisrec': []});
        await getDepositHistory({coin: 'USDC', account: '2', _deps});
        assert.deepEqual(seen, ['2']);
    });

    it('getWithdrawHistory', async () => {
        const {_deps, seen} = routingDeps({'capital/withdraw/history': []});
        await getWithdrawHistory({coin: 'USDC', account: '2', _deps});
        assert.deepEqual(seen, ['2']);
    });

    it('getDepositAddress', async () => {
        const {_deps, seen} = routingDeps({'capital/deposit/address': {coin: 'USDC', address: '0xabc', tag: '', url: ''}});
        await getDepositAddress({coin: 'USDC', account: '2', _deps});
        assert.deepEqual(seen, ['2']);
    });

    it('placeOrder still routes account on confirm (regression guard)', async () => {
        const {_deps, seen} = routingDeps({'positionSide/dual': {dualSidePosition: false}});
        await placeOrder({market: 'futures', symbol: 'BTCUSDC', side: 'BUY', type: 'LIMIT', quantity: 0.01, price: 60000, account: '2', confirm: true, _deps});
        assert.ok(seen.every((a) => a === '2'));
        assert.ok(!seen.includes('1'));
    });
});

// ── tools borrowed from muvon/mcp-binance-futures ────────────────────────────
describe('setPositionMode', () => {
    it('POSTs dualSidePosition=true for hedge', async () => {
        const _deps = deps({'positionSide/dual': {code: 200, msg: 'success'}});
        const r = await setPositionMode({market: 'futures', hedgeMode: true, _deps});
        assert.equal(r.success, true);
        assert.equal(r.hedgeMode, true);
        assert.equal(r.changed, true);
        const p = posts(_deps.fetch);
        assert.equal(p.length, 1);
        assert.match(p[0].url, /dualSidePosition=true/);
    });
    it('treats -4059 "no need to change" as idempotent success', async () => {
        // fetch returns the -4059 error → signedRequest throws → setPositionMode swallows it
        const _deps = deps({'positionSide/dual': {code: -4059, msg: 'No need to change position side.'}});
        const r = await setPositionMode({market: 'futures', hedgeMode: false, _deps});
        assert.equal(r.success, true);
        assert.equal(r.changed, false);
    });
    it('requires a boolean hedgeMode', async () => {
        await assert.rejects(setPositionMode({market: 'futures', _deps: deps()}), /hedgeMode must be/);
    });
});

describe('getOrderHistory', () => {
    it('hits allOrders with symbol+limit', async () => {
        const _deps = deps({allOrders: [{orderId: 1, status: 'FILLED'}, {orderId: 2, status: 'CANCELED'}]});
        const r = await getOrderHistory({market: 'futures', symbol: 'BTCUSDC', _deps});
        assert.equal(r.count, 2);
        assert.match(_deps.fetch.calls[0].url, /\/fapi\/v1\/allOrders/);
    });
});

describe('getLeverageBrackets', () => {
    it('normalizes brackets per symbol', async () => {
        const _deps = deps({
            leverageBracket: [{
                symbol: 'BTCUSDC',
                brackets: [{bracket: 1, initialLeverage: 125, notionalCap: 50000, notionalFloor: 0, maintMarginRatio: 0.004}]
            }]
        });
        const r = await getLeverageBrackets({market: 'futures', symbol: 'BTCUSDC', _deps});
        assert.equal(r.symbols[0].symbol, 'BTCUSDC');
        assert.equal(r.symbols[0].brackets[0].initialLeverage, 125);
    });
});

describe('getAccountSummary', () => {
    it('computes margin ratio from totals', async () => {
        const _deps = deps({
            'fapi/v2/account': {
                totalWalletBalance: '50000',
                totalUnrealizedProfit: '-1200',
                totalMarginBalance: '48800',
                availableBalance: '15000',
                totalInitialMargin: '33000',
                totalMaintMargin: '2440'
            }
        });
        const r = await getAccountSummary({market: 'futures', _deps});
        assert.equal(r.totalWalletBalance, '50000');
        assert.equal(r.totalUnrealizedPnl, '-1200');
        assert.equal(r.marginRatio, '5.00%'); // 2440 / 48800
    });
    it('is futures-only', async () => {
        await assert.rejects(getAccountSummary({market: 'spot', _deps: deps()}), /futures-only/);
    });
});

describe('getIncome', () => {
    it('summarizes income by type', async () => {
        const _deps = deps({
            income: [
                {incomeType: 'REALIZED_PNL', income: '10', asset: 'USDC'},
                {incomeType: 'REALIZED_PNL', income: '5', asset: 'USDC'},
                {incomeType: 'FUNDING_FEE', income: '-2', asset: 'USDC'},
            ]
        });
        const r = await getIncome({market: 'futures', symbol: 'BTCUSDC', _deps});
        assert.equal(r.count, 3);
        assert.equal(r.summary.REALIZED_PNL, 15);
        assert.equal(r.summary.FUNDING_FEE, -2);
        assert.match(_deps.fetch.calls[0].url, /\/fapi\/v1\/income/);
    });
});

describe('getLiquidationHistory', () => {
    it('hits forceOrders with symbol + capped limit', async () => {
        const _deps = deps({forceOrders: [{symbol: 'BTCUSDC', side: 'SELL', type: 'LIMIT', origQty: '0.5', avgPrice: '60000'}]});
        const r = await getLiquidationHistory({market: 'futures', symbol: 'BTCUSDC', limit: 999, _deps});
        assert.equal(r.count, 1);
        assert.match(_deps.fetch.calls[0].url, /\/fapi\/v1\/forceOrders/);
        assert.match(_deps.fetch.calls[0].url, /symbol=BTCUSDC/);
        assert.match(_deps.fetch.calls[0].url, /limit=100/); // clamped to the 100 max
    });
    it('passes autoCloseType and routes COIN-M to /dapi', async () => {
        const _deps = deps({forceOrders: []});
        await getLiquidationHistory({market: 'coinm', autoCloseType: 'liquidation', _deps});
        assert.match(_deps.fetch.calls[0].url, /\/dapi\/v1\/forceOrders/);
        assert.match(_deps.fetch.calls[0].url, /autoCloseType=LIQUIDATION/);
    });
    it('rejects a bad autoCloseType and is futures-only', async () => {
        await assert.rejects(getLiquidationHistory({market: 'futures', autoCloseType: 'nope', _deps: deps()}), /autoCloseType must be/);
        await assert.rejects(getLiquidationHistory({market: 'spot', _deps: deps()}), /futures-only/);
    });
});

describe('wallet history / address (SAPI, spot host)', () => {
    it('getDepositHistory hits capital/deposit/hisrec on the spot host', async () => {
        const _deps = deps({'capital/deposit/hisrec': [{coin: 'USDC', amount: '100', status: 1}]});
        const r = await getDepositHistory({coin: 'usdc', _deps});
        assert.equal(r.count, 1);
        assert.match(_deps.fetch.calls[0].url, /api\.binance\.com\/sapi\/v1\/capital\/deposit\/hisrec/);
        assert.match(_deps.fetch.calls[0].url, /coin=USDC/);
    });
    it('getWithdrawHistory hits capital/withdraw/history', async () => {
        const _deps = deps({'capital/withdraw/history': []});
        const r = await getWithdrawHistory({_deps});
        assert.equal(r.count, 0);
        assert.match(_deps.fetch.calls[0].url, /\/sapi\/v1\/capital\/withdraw\/history/);
    });
    it('getDepositAddress returns address fields and requires coin', async () => {
        const _deps = deps({'capital/deposit/address': {coin: 'USDC', address: '0xabc', tag: '', url: 'https://x', network: 'ETH'}});
        const r = await getDepositAddress({coin: 'USDC', network: 'eth', _deps});
        assert.equal(r.address, '0xabc');
        assert.equal(r.network, 'ETH');
        assert.match(_deps.fetch.calls[0].url, /\/sapi\/v1\/capital\/deposit\/address/);
        await assert.rejects(getDepositAddress({_deps: deps()}), /coin is required/);
    });
});

describe('getAccountSnapshot', () => {
    it('aggregates summary + positions + open-order counts', async () => {
        const _deps = deps({
            'fapi/v2/account': {
                totalWalletBalance: '50000',
                totalUnrealizedProfit: '-1600',
                totalMarginBalance: '48400',
                availableBalance: '15000',
                totalMaintMargin: '2420'
            },
            positionRisk: [{symbol: 'BTCUSDC', positionAmt: '1.6', entryPrice: '60000', markPrice: '59000', unRealizedProfit: '-1600.123', leverage: '3'}],
            openOrders: [{orderId: 1}, {orderId: 2}],
            openAlgoOrders: [{algoId: 9}],
        });
        const r = await getAccountSnapshot({market: 'futures', symbol: 'BTCUSDC', _deps});
        assert.equal(r.openOrders, 2);
        assert.equal(r.openAlgoOrders, 1);
        assert.equal(r.positions[0].side, 'LONG');
        assert.equal(r.positions[0].uPnl, -1600.12);
        assert.equal(r.marginRatio, '5.00%');
    });
});

describe('getRiskReport', () => {
    it('computes per-position liq distance, % of equity and gross exposure', async () => {
        const _deps = deps({
            'fapi/v2/account': {
                totalWalletBalance: '50000',
                totalUnrealizedProfit: '-1000',
                totalMarginBalance: '49000',
                availableBalance: '20000',
                totalMaintMargin: '490'
            },
            positionRisk: [{
                symbol: 'BTCUSDC',
                positionAmt: '1.6',
                entryPrice: '60000',
                markPrice: '59000',
                liquidationPrice: '45000',
                leverage: '3',
                unRealizedProfit: '-1600'
            }],
        });
        const r = await getRiskReport({market: 'futures', _deps});
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
            if (n === 1) return {ok: false, status: 429, headers: {get: () => null}, json: async () => ({})};
            return {ok: true, status: 200, json: async () => ([{orderId: 1, status: 'FILLED'}])};
        };
        fetch.calls = [];
        const _deps = {fetch, keys: {key: 'k', secret: 's'}, now: () => 1700000000000, sleep: () => Promise.resolve()};
        const r = await getOrderHistory({market: 'futures', symbol: 'BTCUSDC', _deps});
        assert.equal(r.success, true);
        assert.equal(r.count, 1);
        assert.equal(n, 2); // one 429, one success
    });
});
