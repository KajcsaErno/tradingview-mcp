/**
 * Shared fixtures/helpers for the binance-*.test.js suites — pure, no network.
 * NOT a test file (doesn't match *.test.js) so the node:test runner skips it.
 */

// ── Mocks ────────────────────────────────────────────────────────────────
export const FILTERS = {
    symbols: [
        ...['BTCUSDC', 'BTCUSDT'].map((symbol) => ({
            symbol, status: 'TRADING', pricePrecision: 2, quantityPrecision: 3,
            filters: [
                {filterType: 'PRICE_FILTER', tickSize: '0.10'},
                {filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001'},
                {filterType: 'MIN_NOTIONAL', notional: '50'},
            ],
        })),
        // COIN-M contract: quantity in whole contracts (stepSize 1), $100 notional each.
        {
            symbol: 'BTCUSD_PERP', status: 'TRADING', pricePrecision: 1, quantityPrecision: 0, contractSize: 100,
            filters: [
                {filterType: 'PRICE_FILTER', tickSize: '0.1'},
                {filterType: 'LOT_SIZE', stepSize: '1', minQty: '1'},
            ],
        },
    ],
};

export function mockFetch(routes = {}) {
    const calls = [];
    const fn = async (url, opts = {}) => {
        calls.push({url, method: opts.method || 'GET'});
        const merged = {exchangeInfo: FILTERS, 'positionSide/dual': {dualSidePosition: false}, ...routes};
        for (const [substr, data] of Object.entries(merged)) {
            if (url.includes(substr)) return {ok: true, status: 200, json: async () => data};
        }
        return {ok: true, status: 200, json: async () => ({orderId: 1, status: 'NEW'})};
    };
    fn.calls = calls;
    return fn;
}

export function deps(routes) {
    const fetch = mockFetch(routes);
    return {fetch, keys: {key: 'k', secret: 's'}, now: () => 1700000000000};
}

export const posts = (fetch) => fetch.calls.filter((c) => c.method === 'POST');

// Build deterministic positional klines: [openTime, open, high, low, close, volume, closeTime, …].
// `fn(i)` drives the close; high/low straddle it. No Math.random — fully reproducible.
export function genKlines(n, fn) {
    const out = [];
    for (let i = 0; i < n; i++) {
        const c = fn(i);
        out.push([i * 3600000, String(c), String(c + 50), String(c - 50), String(c), '10', i * 3600000 + 1, '600000', 50, '5', '300000', '0']);
    }
    return out;
}
