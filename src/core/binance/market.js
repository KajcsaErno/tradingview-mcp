// Binance core — public market data (tickers, klines, depth, trades, funding,
// symbol filters), bounded WS watchers, options surface, and stream builders.
import {requireFinite} from '../../connection.js';
import {futPrefix, isFuturesLike, publicRequest, resolveDeps, resolveMarket, snap} from './request.js';

/** Get recent trades for a symbol (public endpoint, unsigned) */
export async function getRecentTrades({market = 'futures', symbol, limit = 50, _deps = {}} = {}) {
    if (!symbol) throw new Error('symbol is required');
    const sym = String(symbol).toUpperCase();
    const lim = Math.max(1, Math.min(Number(limit) || 50, 1000));
    // endpoint differences: spot /api/v3/trades, USD-M /fapi/v1/trades, COIN-M /dapi/v1/trades
    const endpoint = isFuturesLike(market) ? `${futPrefix(market)}/v1/trades` : '/api/v3/trades';
    const data = await publicRequest({market, endpoint, params: {symbol: sym, limit: String(lim)}, _deps});
    return {success: true, market, symbol: sym, count: data.length, trades: data};
}

/** Get aggregated trades (aggTrades) for a symbol (public) */
export async function getAggTrades({market = 'futures', symbol, fromId, startTime, endTime, limit = 500, _deps = {}} = {}) {
    if (!symbol) throw new Error('symbol is required');
    const sym = String(symbol).toUpperCase();
    const params = {symbol: sym};
    if (fromId !== undefined) params.fromId = String(fromId);
    if (startTime !== undefined) params.startTime = String(requireFinite(startTime, 'startTime'));
    if (endTime !== undefined) params.endTime = String(requireFinite(endTime, 'endTime'));
    const lim = Math.max(1, Math.min(Number(limit) || 500, 1000));
    params.limit = String(lim);
    const endpoint = isFuturesLike(market) ? `${futPrefix(market)}/v1/aggTrades` : '/api/v3/aggTrades';
    const data = await publicRequest({market, endpoint, params, _deps});
    return {success: true, market, symbol: sym, count: data.length, aggTrades: data};
}

/** Historical trades (spot only) — requires API key; we use signedRequest to include auth */
export async function getHistoricalTrades({market = 'spot', symbol, fromId, limit = 500, account = '1', _deps = {}} = {}) {
    if (isFuturesLike(market)) throw new Error('historicalTrades is spot-only');
    if (!symbol) throw new Error('symbol is required');
    const sym = String(symbol).toUpperCase();
    const deps = resolveDeps(account, _deps);
    const params = {symbol: sym};
    if (fromId !== undefined) params.fromId = String(fromId);
    const lim = Math.max(1, Math.min(Number(limit) || 500, 1000));
    params.limit = String(lim);
    const endpoint = '/api/v3/historicalTrades';
    // historicalTrades requires an API key header but does not require signature
    const data = await publicRequest({market, endpoint, params, includeApiKey: true, _deps: deps});
    return {success: true, market, symbol: sym, count: data.length, historicalTrades: data};
}

/** Latest price for a symbol (public). Handy for sizing before an order. */
export async function getTicker({market = 'futures', symbol, _deps = {}} = {}) {
    if (!symbol) throw new Error('symbol is required');
    const sym = String(symbol).toUpperCase();
    const endpoint = isFuturesLike(market) ? `${futPrefix(market)}/v1/ticker/price` : '/api/v3/ticker/price';
    const data = await publicRequest({market, endpoint, params: {symbol: sym}, _deps});
    // COIN-M returns an array (one per contract); USD-M/spot return a single object.
    const tick = Array.isArray(data) ? (data.find((t) => t.symbol === sym) || data[0] || {}) : data;
    return {success: true, market, symbol: tick.symbol || sym, price: tick.price};
}

/** Order book depth (public). */
export async function getOrderBook({market = 'futures', symbol, limit = 20, _deps = {}} = {}) {
    if (!symbol) throw new Error('symbol is required');
    const sym = String(symbol).toUpperCase();
    const lim = Math.max(1, Math.min(Number(limit) || 20, 1000));
    const endpoint = isFuturesLike(market) ? `${futPrefix(market)}/v1/depth` : '/api/v3/depth';
    const data = await publicRequest({market, endpoint, params: {symbol: sym, limit: String(lim)}, _deps});
    return {
        success: true, market, symbol: sym,
        bids: (data.bids || []).map(([p, q]) => ({price: p, qty: q})),
        asks: (data.asks || []).map(([p, q]) => ({price: p, qty: q})),
    };
}

// Klines/candlesticks come back as positional arrays; name the fields we expose.
export const KLINE_INTERVALS = ['1s', '1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '3d', '1w', '1M'];

/** Candlesticks (klines) for a symbol (public). Pulls OHLCV for the EXACT Binance
 *  contract you trade (e.g. BTCUSDC futures), independent of any TradingView chart. */
export async function getKlines({market = 'futures', symbol, interval = '1h', startTime, endTime, limit = 500, extended = false, _deps = {}} = {}) {
    if (!symbol) throw new Error('symbol is required');
    const sym = String(symbol).toUpperCase();
    const iv = String(interval);
    if (!KLINE_INTERVALS.includes(iv)) throw new Error(`interval must be one of: ${KLINE_INTERVALS.join(', ')}`);
    const params = {symbol: sym, interval: iv};
    if (startTime !== undefined) params.startTime = String(requireFinite(startTime, 'startTime'));
    if (endTime !== undefined) params.endTime = String(requireFinite(endTime, 'endTime'));
    // spot caps at 1000 bars/request, futures at 1500.
    const cap = isFuturesLike(market) ? 1500 : 1000;
    params.limit = String(Math.max(1, Math.min(Number(limit) || 500, cap)));
    const endpoint = isFuturesLike(market) ? `${futPrefix(market)}/v1/klines` : '/api/v3/klines';
    const data = await publicRequest({market, endpoint, params, _deps});
    const candles = (data || []).map((k) => mapKline(k, extended));
    return {success: true, market, symbol: sym, interval: iv, count: candles.length, candles};
}

// Klines come back as positional arrays — name the fields we expose. With `extended`, also
// surface the order-flow columns Binance returns (quote volume, trade count, taker buys) —
// useful for flow analysis, off by default to keep payloads compact.
const mapKline = (k, extended = false) => {
    const c = {openTime: k[0], open: k[1], high: k[2], low: k[3], close: k[4], volume: k[5], closeTime: k[6]};
    if (extended) {
        c.quoteVolume = k[7];
        c.trades = k[8];
        c.takerBuyVolume = k[9];
        c.takerBuyQuoteVolume = k[10];
    }
    return c;
};

/** UI-optimized candlesticks (spot-only `/api/v3/uiKlines`) — same shape as getKlines but the
 *  bars are tuned by Binance for chart presentation (consistent spacing at boundaries). */
export async function getUiKlines({market = 'spot', symbol, interval = '1h', startTime, endTime, limit = 500, extended = false, _deps = {}} = {}) {
    if (isFuturesLike(market)) throw new Error('uiKlines is spot-only (use getKlines for futures)');
    if (!symbol) throw new Error('symbol is required');
    const sym = String(symbol).toUpperCase();
    const iv = String(interval);
    if (!KLINE_INTERVALS.includes(iv)) throw new Error(`interval must be one of: ${KLINE_INTERVALS.join(', ')}`);
    const params = {symbol: sym, interval: iv};
    if (startTime !== undefined) params.startTime = String(requireFinite(startTime, 'startTime'));
    if (endTime !== undefined) params.endTime = String(requireFinite(endTime, 'endTime'));
    params.limit = String(Math.max(1, Math.min(Number(limit) || 500, 1000)));
    const data = await publicRequest({market, endpoint: '/api/v3/uiKlines', params, _deps});
    const candles = (data || []).map((k) => mapKline(k, extended));
    return {success: true, market, symbol: sym, interval: iv, count: candles.length, candles};
}

// Shape a raw 24hr/tradingDay ticker row into our compact field set.
const map24hr = (t) => ({
    symbol: t.symbol,
    lastPrice: t.lastPrice, priceChange: t.priceChange, priceChangePercent: t.priceChangePercent,
    weightedAvgPrice: t.weightedAvgPrice, highPrice: t.highPrice, lowPrice: t.lowPrice,
    openPrice: t.openPrice, volume: t.volume, quoteVolume: t.quoteVolume,
});
// Shape a raw bookTicker row, computing the spread.
const mapBook = (t) => {
    const bid = Number(t.bidPrice), ask = Number(t.askPrice);
    const spread = Number.isFinite(bid) && Number.isFinite(ask) ? ask - bid : undefined;
    return {
        symbol: t.symbol, bidPrice: t.bidPrice, bidQty: t.bidQty, askPrice: t.askPrice, askQty: t.askQty,
        spread: spread === undefined ? undefined : String(spread),
        spreadPct: spread !== undefined && bid ? `${(spread / bid * 100).toFixed(4)}%` : undefined,
    };
};
// Keep only symbols ending in the given quote asset (e.g. "USDC") — for one-call screening.
const filterByQuote = (rows, quote) => {
    if (!quote) return rows;
    const q = String(quote).toUpperCase();
    return rows.filter((r) => (r.symbol || '').toUpperCase().endsWith(q));
};

/** 24-hour rolling price-change stats (public). Single symbol by default; pass `all:true` to
 *  return every symbol on the market (optionally narrowed to a `quote` asset, e.g. "USDC"). */
export async function get24hrTicker({market = 'futures', symbol, all = false, quote, _deps = {}} = {}) {
    const endpoint = isFuturesLike(market) ? `${futPrefix(market)}/v1/ticker/24hr` : '/api/v3/ticker/24hr';
    if (all) {
        const data = await publicRequest({market, endpoint, _deps}); // no symbol ⇒ array of all
        const tickers = filterByQuote((Array.isArray(data) ? data : []).map(map24hr), quote);
        return {success: true, market, all: true, quote: quote ? String(quote).toUpperCase() : undefined, count: tickers.length, tickers};
    }
    if (!symbol) throw new Error('symbol is required (or pass all:true)');
    const sym = String(symbol).toUpperCase();
    const data = await publicRequest({market, endpoint, params: {symbol: sym}, _deps});
    // COIN-M returns an array (one row per contract); pick the matching symbol.
    const t = Array.isArray(data) ? (data.find((x) => x.symbol === sym) || data[0] || {}) : data;
    return {success: true, market, ...map24hr({...t, symbol: t.symbol || sym})};
}

/** Best bid/ask (top of book) with computed spread (public). Single symbol by default; pass
 *  `all:true` for every symbol on the market (optionally narrowed to a `quote` asset). */
export async function getBookTicker({market = 'futures', symbol, all = false, quote, _deps = {}} = {}) {
    const endpoint = isFuturesLike(market) ? `${futPrefix(market)}/v1/ticker/bookTicker` : '/api/v3/ticker/bookTicker';
    if (all) {
        const data = await publicRequest({market, endpoint, _deps}); // no symbol ⇒ array of all
        const tickers = filterByQuote((Array.isArray(data) ? data : []).map(mapBook), quote);
        return {success: true, market, all: true, quote: quote ? String(quote).toUpperCase() : undefined, count: tickers.length, tickers};
    }
    if (!symbol) throw new Error('symbol is required (or pass all:true)');
    const sym = String(symbol).toUpperCase();
    const data = await publicRequest({market, endpoint, params: {symbol: sym}, _deps});
    const t = Array.isArray(data) ? (data.find((x) => x.symbol === sym) || data[0] || {}) : data;
    return {success: true, market, ...mapBook({...t, symbol: t.symbol || sym})};
}

// Parse a list given as an array or a non-empty CSV string; null when absent.
const parseCsvList = (value) => {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string' && value) return value.split(',');
    return null;
};

/** Trading-day price-change stats (spot-only `/api/v3/ticker/tradingDay`) — like 24hr but
 *  anchored to the exchange trading day in `timeZone` (default 0/UTC). One `symbol`, or a
 *  `symbols` list (array or CSV) to scan several at once. */
export async function getTradingDayTicker({market = 'spot', symbol, symbols, timeZone, _deps = {}} = {}) {
    if (isFuturesLike(market)) throw new Error('tradingDay ticker is spot-only');
    const list = parseCsvList(symbols);
    const params = {};
    if (timeZone !== undefined) params.timeZone = String(timeZone);
    if (list && list.length) {
        params.symbols = JSON.stringify(list.map((s) => String(s).trim().toUpperCase()));
        const data = await publicRequest({market, endpoint: '/api/v3/ticker/tradingDay', params, _deps});
        const tickers = (Array.isArray(data) ? data : [data]).map(map24hr);
        return {success: true, market, count: tickers.length, tickers};
    }
    if (!symbol) throw new Error('symbol or symbols is required');
    params.symbol = String(symbol).toUpperCase();
    const data = await publicRequest({market, endpoint: '/api/v3/ticker/tradingDay', params, _deps});
    const t = Array.isArray(data) ? (data[0] || {}) : data;
    return {success: true, market, ...map24hr({...t, symbol: t.symbol || params.symbol})};
}

/** Current average price over a short window (spot-only; Binance returns ~5-min avg). */
export async function getAvgPrice({market = 'spot', symbol, _deps = {}} = {}) {
    if (isFuturesLike(market)) throw new Error('avgPrice is spot-only (use get24hrTicker.weightedAvgPrice for futures)');
    if (!symbol) throw new Error('symbol is required');
    const sym = String(symbol).toUpperCase();
    const data = await publicRequest({market, endpoint: '/api/v3/avgPrice', params: {symbol: sym}, _deps});
    return {success: true, market, symbol: sym, mins: data.mins, price: data.price};
}

/** Rolling-window price-change stats with a custom window (spot-only; windowSize e.g. "1d", "4h").
 *  Binance's `/api/v3/ticker` has no bare "all" — scan several at once with a `symbols` list
 *  (array or CSV) instead. */
export async function getRollingWindowTicker({market = 'spot', symbol, symbols, windowSize = '1d', _deps = {}} = {}) {
    if (isFuturesLike(market)) throw new Error('rolling-window ticker is spot-only (use get24hrTicker for futures)');
    const win = String(windowSize);
    const list = parseCsvList(symbols);
    if (list && list.length) {
        const params = {symbols: JSON.stringify(list.map((s) => String(s).trim().toUpperCase())), windowSize: win};
        const data = await publicRequest({market, endpoint: '/api/v3/ticker', params, _deps});
        const tickers = (Array.isArray(data) ? data : [data]).map((t) => ({...map24hr(t), windowSize: win}));
        return {success: true, market, windowSize: win, count: tickers.length, tickers};
    }
    if (!symbol) throw new Error('symbol or symbols is required');
    const sym = String(symbol).toUpperCase();
    const data = await publicRequest({market, endpoint: '/api/v3/ticker', params: {symbol: sym, windowSize: win}, _deps});
    const t = Array.isArray(data) ? (data[0] || {}) : data;
    return {success: true, market, windowSize: win, ...map24hr({...t, symbol: t.symbol || sym})};
}

const COMPARE_SORT_KEYS = new Set(['priceChangePercent', 'priceChange', 'quoteVolume', 'volume', 'lastPrice']);

/** Compare several symbols side-by-side on 24-hour stats, ranked by one metric (public). Fetches
 *  each symbol's 24hr ticker (works on spot/futures/coinm), then returns a sorted, ranked table
 *  plus the leader/laggard. `symbols` is an array or CSV; `sortBy` is one of priceChangePercent
 *  (default), priceChange, quoteVolume, volume, lastPrice (descending). Unknown sortBy falls back
 *  to priceChangePercent. */
export async function compareSymbols({market = 'futures', symbols, sortBy = 'priceChangePercent', _deps = {}} = {}) {
    const list = parseCsvList(symbols);
    const syms = [...new Set((list || []).map((s) => String(s).trim().toUpperCase()).filter(Boolean))];
    if (!syms.length) throw new Error('symbols is required (array or CSV, e.g. "BTCUSDC,ETHUSDC")');
    const key = COMPARE_SORT_KEYS.has(sortBy) ? sortBy : 'priceChangePercent';
    const rows = await Promise.all(syms.map(async (sym) => {
        const t = await get24hrTicker({market, symbol: sym, _deps});
        return {
            symbol: sym, lastPrice: t.lastPrice,
            priceChange: t.priceChange, priceChangePercent: t.priceChangePercent,
            highPrice: t.highPrice, lowPrice: t.lowPrice,
            volume: t.volume, quoteVolume: t.quoteVolume,
        };
    }));
    rows.sort((a, b) => (Number(b[key]) || 0) - (Number(a[key]) || 0));
    rows.forEach((r, i) => {
        r.rank = i + 1;
    });
    return {
        success: true, market, sortBy: key, count: rows.length,
        leader: rows[0] ? rows[0].symbol : undefined,
        laggard: rows.length ? rows.at(-1).symbol : undefined,
        comparison: rows,
    };
}

/** Funding rate for a perpetual (public). Default returns the current premium-index snapshot
 *  (mark/index price + last & next funding); history:true returns recent funding payments. */
export async function getFundingRate({market = 'futures', symbol, history = false, limit = 10, _deps = {}} = {}) {
    if (!isFuturesLike(market)) throw new Error('funding rate is futures-only');
    if (!symbol) throw new Error('symbol is required');
    const sym = String(symbol).toUpperCase();
    if (history) {
        const lim = Math.max(1, Math.min(Number(limit) || 10, 1000));
        const data = await publicRequest({market, endpoint: `${futPrefix(market)}/v1/fundingRate`, params: {symbol: sym, limit: String(lim)}, _deps});
        return {
            success: true, market, symbol: sym, count: data.length,
            fundingHistory: (data || []).map((f) => ({
                fundingRate: f.fundingRate,
                fundingRatePct: `${(Number(f.fundingRate) * 100).toFixed(4)}%`,
                fundingTime: f.fundingTime
            })),
        };
    }
    const data = await publicRequest({market, endpoint: `${futPrefix(market)}/v1/premiumIndex`, params: {symbol: sym}, _deps});
    const t = Array.isArray(data) ? (data.find((x) => x.symbol === sym) || data[0] || {}) : data;
    return {
        success: true, market, symbol: t.symbol || sym,
        markPrice: t.markPrice, indexPrice: t.indexPrice,
        lastFundingRate: t.lastFundingRate,
        lastFundingRatePct: t.lastFundingRate == null ? undefined : `${(Number(t.lastFundingRate) * 100).toFixed(4)}%`,
        nextFundingTime: t.nextFundingTime, interestRate: t.interestRate,
    };
}

// ── User-data stream (listenKey) ─────────────────────────────────────────────
// Powers real-time PUSH of order fills, position and balance changes over a WebSocket —
// the low-latency alternative to polling getAccountSnapshot. The REST calls here manage the
// listenKey lifecycle; the actual WS loop lives in the `tv binance user-stream` CLI subcommand
// (a long-running loop, like `tv binance stream`). Uses the API key header only (NOT signed).
const WS_BASES = {
    spot: 'wss://stream.binance.com:9443',
    futures: 'wss://fstream.binance.com',
    coinm: 'wss://dstream.binance.com',
    'spot-testnet': 'wss://stream.testnet.binance.vision',
    'futures-testnet': 'wss://stream.binancefuture.com',
    'coinm-testnet': 'wss://dstream.binancefuture.com',
};
const listenKeyEndpoint = (market) => (isFuturesLike(market) ? `${futPrefix(market)}/v1/listenKey` : '/api/v3/userDataStream');

/** Open a user-data stream: returns a `listenKey` and the `wsUrl` to connect to. The key
 *  expires ~60 min after creation unless refreshed via keepAliveUserStream. Per-account. */
export async function startUserStream({market = 'futures', account = '1', _deps = {}} = {}) {
    const deps = resolveDeps(account, _deps);
    const data = await publicRequest({market, method: 'POST', endpoint: listenKeyEndpoint(market), includeApiKey: true, _deps: deps});
    if (!data || !data.listenKey) throw new Error('Binance returned no listenKey');
    return {success: true, market, account, listenKey: data.listenKey, wsUrl: `${WS_BASES[resolveMarket(market, deps)]}/ws/${data.listenKey}`};
}

/** Refresh a user-data stream's 60-min expiry (call ~every 30 min). Futures key off the account;
 *  spot requires the listenKey as a parameter. */
export async function keepAliveUserStream({market = 'futures', account = '1', listenKey, _deps = {}} = {}) {
    const deps = resolveDeps(account, _deps);
    const futuresLike = isFuturesLike(market);
    if (!futuresLike && !listenKey) throw new Error('listenKey is required to keep a spot stream alive');
    const params = futuresLike ? {} : {listenKey: String(listenKey)};
    await publicRequest({market, method: 'PUT', endpoint: listenKeyEndpoint(market), params, includeApiKey: true, _deps: deps});
    return {success: true, market, account};
}

/** Close a user-data stream (best-effort cleanup on shutdown). */
export async function closeUserStream({market = 'futures', account = '1', listenKey, _deps = {}} = {}) {
    const deps = resolveDeps(account, _deps);
    const futuresLike = isFuturesLike(market);
    const params = futuresLike ? {} : {listenKey: String(listenKey || '')};
    await publicRequest({market, method: 'DELETE', endpoint: listenKeyEndpoint(market), params, includeApiKey: true, _deps: deps});
    return {success: true, market, account};
}

// Resolve the WebSocket constructor: injected via _deps for tests, else the runtime global.
const resolveWS = (_deps) => {
    if (_deps.WebSocket) return _deps.WebSocket;
    return typeof WebSocket === 'undefined' ? null : WebSocket;
};

// Shared settle-once finisher for the bounded WS watchers (watchPrice / watchOrderFlow):
// clear the timer, close the socket, then reject the error or resolve the summary.
// `state` is the watcher's mutable {settled, timer, ws} bag.
const wsFinisher = (state, clearTimer, resolve, reject, summarize) => (err) => {
    if (state.settled) return;
    state.settled = true;
    if (state.timer) clearTimer(state.timer);
    try {
        state.ws && state.ws.close();
    } catch { /* ignore */
    }
    if (err) reject(err); else resolve(summarize());
};

/** Watch a symbol's live trades over a public WebSocket for a bounded window, then return a
 *  compact summary (open/high/low/close + change, VWAP, volume, tick count). Public/unsigned —
 *  subscribes to the `<symbol>@aggTrade` stream (available on spot, USD-M and COIN-M). This is
 *  the bounded, request/response counterpart to the unbounded `tv binance stream` loop: an
 *  agent can ask "watch BTC for 15s and tell me what happened" and get one result back.
 *  `durationSec` is clamped to [1, 60]. If the socket closes early, whatever was collected is
 *  summarized. `_deps.WebSocket` / `_deps.setTimeout` / `_deps.clearTimeout` are injectable
 *  for testing (defaults to the runtime globals). */
export async function watchPrice({market = 'futures', symbol, durationSec = 10, _deps = {}} = {}) {
    if (!symbol) throw new Error('symbol is required');
    const sym = String(symbol).toUpperCase();
    const dur = Math.max(1, Math.min(Number(durationSec) || 10, 60));
    const base = WS_BASES[resolveMarket(market, _deps)];
    if (!base) throw new Error(`unknown market ${market}`);
    const WS = resolveWS(_deps);
    if (!WS) throw new Error('WebSocket is not available in this runtime');
    const setTimer = _deps.setTimeout || setTimeout;
    const clearTimer = _deps.clearTimeout || clearTimeout;
    const wsUrl = `${base}/ws/${sym.toLowerCase()}@aggTrade`;

    return new Promise((resolve, reject) => {
        const ticks = [];
        const state = {settled: false, timer: null, ws: undefined};

        const summarize = () => {
            const n = ticks.length;
            if (!n) {
                return {
                    success: true, market, symbol: sym, durationSec: dur, ticks: 0,
                    note: 'No trades observed in the window (illiquid pair, wrong symbol/market, or window too short).',
                };
            }
            let high = -Infinity, low = Infinity, volume = 0, pv = 0;
            for (const t of ticks) {
                if (t.price > high) high = t.price;
                if (t.price < low) low = t.price;
                volume += t.qty;
                pv += t.price * t.qty;
            }
            const open = ticks[0].price, close = ticks[n - 1].price, change = close - open;
            return {
                success: true, market, symbol: sym, durationSec: dur, ticks: n,
                open, high, low, close, change,
                changePct: open ? `${((change / open) * 100).toFixed(4)}%` : undefined,
                vwap: volume > 0 ? Number((pv / volume).toFixed(8)) : undefined,
                volume: Number(volume.toFixed(8)),
                firstTradeTime: ticks[0].time, lastTradeTime: ticks[n - 1].time,
            };
        };

        const finish = wsFinisher(state, clearTimer, resolve, reject, summarize);

        try {
            state.ws = new WS(wsUrl);
        } catch (err) {
            return finish(err);
        }
        state.timer = setTimer(() => finish(), dur * 1000);
        state.ws.addEventListener('message', (ev) => {
            let m;
            try {
                m = JSON.parse(ev.data);
            } catch {
                return;
            }
            const price = Number(m.p), qty = Number(m.q);
            if (Number.isFinite(price)) ticks.push({price, qty: Number.isFinite(qty) ? qty : 0, time: m.T});
        });
        state.ws.addEventListener('error', () => { /* a close event follows; we summarize there */
        });
        state.ws.addEventListener('close', () => finish());
    });
}

// Supported partial-book depth sizes on Binance streams.
const ORDER_FLOW_DEPTH_LEVELS = new Set([5, 10, 20]);

// Snap a requested depth-levels value to a supported partial-book stream size.
const snapDepthLevels = (lvNum) => {
    if (ORDER_FLOW_DEPTH_LEVELS.has(lvNum)) return lvNum;
    if (lvNum <= 5) return 5;
    if (lvNum <= 10) return 10;
    return 20;
};

// Resolve top-of-book from the bookTicker snapshot, falling back to the depth snapshot,
// with the computed spread (absolute + bps).
const orderFlowTopOfBook = (top, depth) => {
    const bid = Number.isFinite(top.bid) ? top.bid : (depth.bids[0]?.price);
    const ask = Number.isFinite(top.ask) ? top.ask : (depth.asks[0]?.price);
    const spread = Number.isFinite(bid) && Number.isFinite(ask) ? ask - bid : undefined;
    return {
        bid: Number.isFinite(bid) ? bid : undefined,
        ask: Number.isFinite(ask) ? ask : undefined,
        spread: Number.isFinite(spread) ? Number(spread.toFixed(8)) : undefined,
        spreadBps: Number.isFinite(spread) && bid ? Number(((spread / bid) * 10000).toFixed(2)) : undefined,
        bidQty: Number.isFinite(top.bidQty) ? top.bidQty : undefined,
        askQty: Number.isFinite(top.askQty) ? top.askQty : undefined,
    };
};

// Largest resting level (by qty) on one side of the depth snapshot.
const largestWall = (rows) => rows.reduce((best, x) => (x.qty > (best?.qty || 0) ? x : best), null);

// Notional bid-vs-ask imbalance over the captured depth snapshot.
const orderFlowDepthImbalance = (depth) => {
    const bidNotional = depth.bids.reduce((s0, x) => s0 + (x.price * x.qty), 0);
    const askNotional = depth.asks.reduce((s0, x) => s0 + (x.price * x.qty), 0);
    const depthSum = bidNotional + askNotional;
    const imbalance = depthSum > 0 ? (bidNotional - askNotional) / depthSum : undefined;
    return {
        bidNotional: Number(bidNotional.toFixed(2)),
        askNotional: Number(askNotional.toFixed(2)),
        imbalance: imbalance == null ? undefined : Number(imbalance.toFixed(4)),
        imbalancePct: imbalance == null ? undefined : `${(imbalance * 100).toFixed(2)}%`,
        largestBidWall: largestWall(depth.bids),
        largestAskWall: largestWall(depth.asks),
    };
};

/** Watch real-time order flow over a bounded window and return a compact microstructure read:
 *  aggressive buy/sell delta from aggTrades, top-of-book spread, and depth imbalance from a
 *  partial depth stream. This is the nearest Binance-native analog to a lightweight heatmap read.
 *  `durationSec` clamps to [1,60]. `levels` snaps to one of 5/10/20 (Binance stream limits). */
export async function watchOrderFlow({market = 'futures', symbol, durationSec = 10, levels = 20, _deps = {}} = {}) {
    if (!symbol) throw new Error('symbol is required');
    const sym = String(symbol).toUpperCase();
    const dur = Math.max(1, Math.min(Number(durationSec) || 10, 60));
    const lvNum = requireFinite(levels, 'levels');
    const lv = snapDepthLevels(lvNum);
    const base = WS_BASES[resolveMarket(market, _deps)];
    if (!base) throw new Error(`unknown market ${market}`);
    const WS = resolveWS(_deps);
    if (!WS) throw new Error('WebSocket is not available in this runtime');
    const setTimer = _deps.setTimeout || setTimeout;
    const clearTimer = _deps.clearTimeout || clearTimeout;
    const s = sym.toLowerCase();
    // Use @trade (raw trades) not @aggTrade: Binance's USD-M futures @aggTrade stream
    // intermittently delivers nothing, silently zeroing the aggressive buy/sell metrics.
    // @trade is reliable on both spot and futures and carries the same `m` (buyer-is-maker)
    // aggressor flag, so the delta/VWAP math is identical.
    const wsUrl = `${base}/stream?streams=${s}@trade/${s}@depth${lv}@100ms/${s}@bookTicker`;

    return new Promise((resolve, reject) => {
        const state = {settled: false, timer: null, ws: undefined};
        const agg = {count: 0, buyQty: 0, sellQty: 0, buyNotional: 0, sellNotional: 0, firstTradeTime: undefined, lastTradeTime: undefined};
        let top = {bid: undefined, ask: undefined, bidQty: undefined, askQty: undefined, time: undefined};
        let depth = {bids: [], asks: [], time: undefined};

        const toLevels = (rows = []) => rows
            .map(([p, q]) => ({price: Number(p), qty: Number(q)}))
            .filter((x) => Number.isFinite(x.price) && Number.isFinite(x.qty) && x.qty > 0)
            .slice(0, lv);

        const summarize = () => {
            const totalQty = agg.buyQty + agg.sellQty;
            const deltaQty = agg.buyQty - agg.sellQty;
            const totalNotional = agg.buyNotional + agg.sellNotional;
            const deltaNotional = agg.buyNotional - agg.sellNotional;
            const noEvents = agg.count === 0 && depth.bids.length === 0 && depth.asks.length === 0;

            return {
                success: true, market, symbol: sym, durationSec: dur, levels: lv,
                tradeTicks: agg.count,
                aggressiveBuyQty: Number(agg.buyQty.toFixed(8)),
                aggressiveSellQty: Number(agg.sellQty.toFixed(8)),
                deltaQty: Number(deltaQty.toFixed(8)),
                deltaQtyPct: totalQty > 0 ? `${((deltaQty / totalQty) * 100).toFixed(2)}%` : undefined,
                aggressiveBuyNotional: Number(agg.buyNotional.toFixed(2)),
                aggressiveSellNotional: Number(agg.sellNotional.toFixed(2)),
                deltaNotional: Number(deltaNotional.toFixed(2)),
                vwap: totalQty > 0 ? Number((totalNotional / totalQty).toFixed(8)) : undefined,
                topOfBook: orderFlowTopOfBook(top, depth),
                depthImbalance: orderFlowDepthImbalance(depth),
                firstTradeTime: agg.firstTradeTime,
                lastTradeTime: agg.lastTradeTime,
                note: noEvents
                    ? 'No trade/depth events observed in the window (illiquid pair, wrong symbol/market, or window too short).'
                    : undefined,
            };
        };

        const finish = wsFinisher(state, clearTimer, resolve, reject, summarize);

        try {
            state.ws = new WS(wsUrl);
        } catch (err) {
            return finish(err);
        }
        state.timer = setTimer(() => finish(), dur * 1000);
        state.ws.addEventListener('message', (ev) => {
            let m;
            try {
                m = JSON.parse(ev.data);
            } catch {
                return;
            }
            const d = m?.data || m || {};
            if (d.e === 'trade' || d.e === 'aggTrade') {
                const price = Number(d.p), qty = Number(d.q);
                if (!Number.isFinite(price) || !Number.isFinite(qty)) return;
                const notional = price * qty;
                const sellAggressor = !!d.m; // buyer is maker => seller was aggressive
                if (sellAggressor) {
                    agg.sellQty += qty;
                    agg.sellNotional += notional;
                } else {
                    agg.buyQty += qty;
                    agg.buyNotional += notional;
                }
                agg.count += 1;
                if (agg.firstTradeTime == null) agg.firstTradeTime = d.T;
                agg.lastTradeTime = d.T;
                return;
            }
            if (d.e === 'depthUpdate' || (Array.isArray(d.b) && Array.isArray(d.a))) {
                depth = {bids: toLevels(d.b), asks: toLevels(d.a), time: d.E || d.T};
                return;
            }
            if (d.e === 'bookTicker' || (d.b !== undefined && d.a !== undefined && d.s)) {
                top = {
                    bid: Number(d.b), ask: Number(d.a),
                    bidQty: Number(d.B), askQty: Number(d.A),
                    time: d.E || d.T,
                };
            }
        });
        state.ws.addEventListener('error', () => { /* a close event follows; summarize there */
        });
        state.ws.addEventListener('close', () => finish());
    });
}

// Tag a bar's flow by the aggressive-buy share of its quote volume.
const footprintFlowTag = (buyShare) => {
    if (buyShare == null) return 'no_flow';
    if (buyShare >= 0.55) return 'buyers_in_control';
    if (buyShare <= 0.45) return 'sellers_in_control';
    return 'balanced';
};

/** Footprint-style per-candle aggression read from Binance kline order-flow fields. Each bar
 *  estimates aggressive buy/sell quote flow using takerBuyQuoteVolume vs total quoteVolume. */
export async function getFootprintBars({market = 'futures', symbol, interval = '1m', limit = 100, _deps = {}} = {}) {
    const lim = Math.max(1, Math.min(Math.trunc(requireFinite(limit, 'limit')), 500));
    const k = await getKlines({market, symbol, interval, limit: lim, extended: true, _deps});
    const bars = (k.candles || []).map((c) => {
        const quoteVolume = Number(c.quoteVolume) || 0;
        const buyQuote = Number(c.takerBuyQuoteVolume) || 0;
        const sellQuote = Math.max(quoteVolume - buyQuote, 0);
        const delta = buyQuote - sellQuote;
        const buyShare = quoteVolume > 0 ? (buyQuote / quoteVolume) : null;
        const sellShare = quoteVolume > 0 ? (sellQuote / quoteVolume) : null;
        return {
            openTime: c.openTime,
            closeTime: c.closeTime,
            open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close),
            trades: Number(c.trades) || 0,
            quoteVolume: Number(quoteVolume.toFixed(2)),
            aggressiveBuyQuote: Number(buyQuote.toFixed(2)),
            aggressiveSellQuote: Number(sellQuote.toFixed(2)),
            deltaQuote: Number(delta.toFixed(2)),
            buyShare: buyShare == null ? undefined : Number((buyShare * 100).toFixed(2)),
            sellShare: sellShare == null ? undefined : Number((sellShare * 100).toFixed(2)),
            flowTag: footprintFlowTag(buyShare),
        };
    });
    const totalBuy = bars.reduce((s0, b) => s0 + b.aggressiveBuyQuote, 0);
    const totalSell = bars.reduce((s0, b) => s0 + b.aggressiveSellQuote, 0);
    const total = totalBuy + totalSell;
    return {
        success: true, market, symbol: k.symbol, interval: k.interval,
        count: bars.length,
        totals: {
            aggressiveBuyQuote: Number(totalBuy.toFixed(2)),
            aggressiveSellQuote: Number(totalSell.toFixed(2)),
            deltaQuote: Number((totalBuy - totalSell).toFixed(2)),
            buyShare: total > 0 ? Number(((totalBuy / total) * 100).toFixed(2)) : undefined,
        },
        bars,
    };
}

const OPTIONS_BASE = 'https://eapi.binance.com';

/** Public request helper for Binance Options (EAPI) endpoints. */
async function optionsPublicRequest({endpoint, params = {}, _deps = {}} = {}) {
    const fetchFn = _deps.fetch || fetch;
    const query = new URLSearchParams(params).toString();
    const qs = query ? `?${query}` : '';
    const url = `${OPTIONS_BASE}${endpoint}${qs}`;
    const res = await fetchFn(url);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Binance options ${res.status}: ${data?.msg || JSON.stringify(data)}`);
    return data;
}

const toExpCode = (ms) => {
    const d = new Date(Number(ms));
    if (!Number.isFinite(d.getTime())) return undefined;
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}${m}${day}`;
};

// Join exchangeInfo option symbols with their mark rows into flat per-contract rows,
// keeping only the requested expirations (when a filter is given).
const buildOptionRows = (symbols, markBySymbol, expFilter) => {
    const rows = [];
    for (const s of symbols) {
        const expiry = toExpCode(s.expiryDate);
        if (expFilter.size && !expFilter.has(expiry)) continue;
        const m = markBySymbol.get(String(s.symbol));
        if (!m) continue;
        rows.push({
            symbol: String(s.symbol),
            expiry,
            strike: Number(s.strikePrice),
            side: String(s.side || '').toUpperCase(),
            markIV: Number(m.markIV),
            bidIV: Number(m.bidIV),
            askIV: Number(m.askIV),
            delta: Number(m.delta),
            gamma: Number(m.gamma),
            theta: Number(m.theta),
            vega: Number(m.vega),
            markPrice: Number(m.markPrice),
        });
    }
    return rows;
};

// Group contract rows by expiry, collecting mark IVs and a strike → {CALL, PUT} pair map.
const groupOptionRowsByExpiry = (rows) => {
    const byExpiry = new Map();
    for (const r of rows) {
        if (!Number.isFinite(r.markIV)) continue;
        const k = r.expiry || 'unknown';
        const g = byExpiry.get(k) || {ivs: [], strikes: new Map()};
        g.ivs.push(r.markIV);
        const pair = g.strikes.get(r.strike) || {};
        pair[r.side] = r;
        g.strikes.set(r.strike, pair);
        byExpiry.set(k, g);
    }
    return byExpiry;
};

// ATM call-vs-put IV snapshot for one expiry group: the strike nearest the index price.
const optionAtmSkew = (g, indexPrice) => {
    if (!Number.isFinite(indexPrice) || !g.strikes.size) return null;
    const bestStrike = [...g.strikes.keys()].reduce((best, st) => (
        best == null || Math.abs(st - indexPrice) < Math.abs(best - indexPrice) ? st : best
    ), null);
    const p = g.strikes.get(bestStrike) || {};
    if (!p.CALL && !p.PUT) return null;
    const callIv = Number.isFinite(p.CALL?.markIV) ? p.CALL.markIV : null;
    const putIv = Number.isFinite(p.PUT?.markIV) ? p.PUT.markIV : null;
    return {
        strike: bestStrike,
        callIv,
        putIv,
        callPutSkew: (callIv != null && putIv != null) ? Number((callIv - putIv).toFixed(6)) : null,
    };
};

/**
 * Options IV/skew snapshot (public): builds an implied-vol surface from Binance Options mark data,
 * then reports per-expiry term structure and simple call-vs-put skew around ATM.
 */
export async function getOptionsSurface({underlying = 'BTCUSDT', expirations, full = false, _deps = {}} = {}) {
    const u = String(underlying || '').trim().toUpperCase();
    if (!u) throw new Error('underlying is required (e.g. BTCUSDT)');
    const expFilter = new Set(
        (parseCsvList(expirations) || [])
            .map((x) => String(x).trim())
            .filter(Boolean),
    );

    const [info, marks, idx] = await Promise.all([
        optionsPublicRequest({endpoint: '/eapi/v1/exchangeInfo', _deps}),
        optionsPublicRequest({endpoint: '/eapi/v1/mark', params: {underlying: u}, _deps}),
        optionsPublicRequest({endpoint: '/eapi/v1/index', params: {underlying: u}, _deps}).catch(() => null),
    ]);

    const indexPrice = Number(idx?.indexPrice);
    const symbols = (info?.optionSymbols || []).filter((s) => String(s.underlying || '').toUpperCase() === u);
    const markBySymbol = new Map((Array.isArray(marks) ? marks : []).map((m) => [String(m.symbol), m]));

    const rows = buildOptionRows(symbols, markBySymbol, expFilter);
    const byExpiry = groupOptionRowsByExpiry(rows);

    const expiries = [];
    for (const [expiry, g] of [...byExpiry.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])))) {
        const avgIv = g.ivs.length ? (g.ivs.reduce((s0, x) => s0 + x, 0) / g.ivs.length) : null;
        expiries.push({
            expiry,
            contracts: g.ivs.length,
            avgMarkIv: avgIv == null ? null : Number(avgIv.toFixed(6)),
            atm: optionAtmSkew(g, indexPrice),
        });
    }

    return {
        success: true,
        underlying: u,
        indexPrice: Number.isFinite(indexPrice) ? indexPrice : undefined,
        expirationsRequested: expFilter.size ? [...expFilter] : undefined,
        expiries,
        contracts: rows.length,
        // Per-contract rows (every strike × side, with full greeks) can be 200KB+. Default to the
        // per-expiry ATM/skew summary only; pass full:true for the raw chain. (context-management rules)
        surface: full ? rows : undefined,
        surfaceOmitted: full ? undefined : `${rows.length} contracts — pass full:true to include the per-contract chain`,
        note: 'Implied volatility from Binance Options mark data. Skew is a simple ATM call-vs-put snapshot, not a full dealer vol model.',
    };
}

// ── Public market-data stream (combined multiplex) ───────────────────────────
// Continuous PUSH of public market data — the unbounded, multi-symbol/multi-stream-type
// counterpart to the bounded watchPrice. buildMarketStream() builds the combined-stream URL
// (`/stream?streams=a@trade/b@bookTicker/…`) and is pure/DI-testable like startUserStream;
// the actual WS loop lives in the `tv binance market-stream` CLI subcommand. Unsigned/public.
const PUBLIC_STREAM_KINDS = new Set(['trade', 'aggTrade', 'ticker', 'bookTicker', 'kline', 'markPrice', 'funding']);

/** Map one stream spec → its Binance suffix. Specs are a kind, optionally `kind:arg`
 *  (only `kline:<interval>` uses the arg, defaulting to 1m). On futures, the `markPrice`
 *  stream already carries the funding rate + next funding time, so `funding` is an alias
 *  for it. markPrice/funding are futures-only. */
function streamSuffix(spec, market) {
    const [kind, arg] = String(spec).trim().split(':');
    if (!PUBLIC_STREAM_KINDS.has(kind))
        throw new Error(`unknown stream "${spec}" (use trade, aggTrade, ticker, bookTicker, kline[:1m], markPrice, funding)`);
    if ((kind === 'markPrice' || kind === 'funding') && !isFuturesLike(market))
        throw new Error(`${kind} stream is futures-only`);
    switch (kind) {
        case 'trade':
            return '@trade';
        case 'aggTrade':
            return '@aggTrade';
        case 'ticker':
            return '@ticker';
        case 'bookTicker':
            return '@bookTicker';
        case 'kline':
            return `@kline_${arg || '1m'}`;
        case 'markPrice':
        case 'funding':
            return '@markPrice@1s';
    }
}

/** Build the combined-stream WebSocket URL for one or more symbols × stream types. Returns the
 *  resolved market, the (de-duplicated) raw subscription names and the wsUrl to connect to —
 *  this is the testable seam; the CLI loop just opens the socket. `symbols`/`streams` are arrays
 *  or CSV strings; `streams` defaults to `trade`. */
export function buildMarketStream({market = 'futures', symbols, streams = 'trade', _deps = {}} = {}) {
    const m = resolveMarket(market, _deps);
    const base = WS_BASES[m];
    if (!base) throw new Error(`unknown market ${market}`);
    const symList = [...new Set((parseCsvList(symbols) || [])
        .map((s) => String(s).trim().toUpperCase()).filter(Boolean))];
    if (!symList.length) throw new Error('symbols is required (array or CSV, e.g. "BTCUSDC,ETHUSDC")');
    const streamList = (Array.isArray(streams) ? streams : String(streams).split(','))
        .map((s) => String(s).trim()).filter(Boolean);
    if (!streamList.length) throw new Error('streams is required (e.g. "trade,bookTicker,markPrice")');
    const subscriptions = [];
    for (const sym of symList)
        for (const spec of streamList)
            subscriptions.push(`${sym.toLowerCase()}${streamSuffix(spec, m)}`);
    const uniq = [...new Set(subscriptions)];
    return {
        success: true, market: m, symbols: symList, streams: streamList,
        subscriptions: uniq, wsUrl: `${base}/stream?streams=${uniq.join('/')}`,
    };
}

/** Normalize a combined-stream message into a compact, uniform line. Accepts the wrapped
 *  `{ stream, data }` envelope (combined streams) or a bare event. Unknown events fall back to
 *  `{ event, stream, raw }`. Note: spot `bookTicker` carries no `e` field, so it's detected by
 *  its b/a/s shape. */
export function formatMarketEvent(msg) {
    const stream = msg && msg.stream;
    const d = (msg && msg.data) || msg || {};
    const e = d.e;
    if (e === 'trade' || e === 'aggTrade')
        return {event: e, symbol: d.s, price: Number(d.p), qty: Number(d.q), time: d.T, buyerMaker: d.m};
    if (e === '24hrTicker')
        return {
            event: 'ticker',
            symbol: d.s,
            last: Number(d.c),
            changePct: Number(d.P),
            high: Number(d.h),
            low: Number(d.l),
            volume: Number(d.v),
            quoteVolume: Number(d.q)
        };
    if (e === 'markPriceUpdate')
        return {event: 'markPrice', symbol: d.s, mark: Number(d.p), index: Number(d.i), fundingRate: Number(d.r), nextFundingTime: d.T, time: d.E};
    if (e === 'kline') {
        const k = d.k || {};
        return {
            event: 'kline',
            symbol: d.s,
            interval: k.i,
            open: Number(k.o),
            high: Number(k.h),
            low: Number(k.l),
            close: Number(k.c),
            volume: Number(k.v),
            closed: k.x,
            openTime: k.t,
            closeTime: k.T
        };
    }
    if (e === 'bookTicker' || (d.b !== undefined && d.a !== undefined && d.s))
        return {event: 'bookTicker', symbol: d.s, bid: Number(d.b), bidQty: Number(d.B), ask: Number(d.a), askQty: Number(d.A), time: d.T || d.E};
    return {event: e || 'unknown', stream, raw: d};
}

/** Symbol trading filters (tick size, step size, min notional) — use these to
 *  round price/quantity so orders aren't rejected for bad precision. */
export async function getSymbolInfo({market = 'futures', symbol, _deps = {}} = {}) {
    if (!symbol) throw new Error('symbol is required');
    const sym = String(symbol).toUpperCase();
    const endpoint = isFuturesLike(market) ? `${futPrefix(market)}/v1/exchangeInfo` : '/api/v3/exchangeInfo';
    // Spot supports ?symbol=; futures (USD-M & COIN-M) return all symbols — filter client-side.
    const params = isFuturesLike(market) ? {} : {symbol: sym};
    const data = await publicRequest({market, endpoint, params, _deps});
    const s = (data.symbols || []).find((x) => x.symbol === sym);
    if (!s) throw new Error(`symbol ${sym} not found on ${market}`);
    const f = (type) => (s.filters || []).find((x) => x.filterType === type) || {};
    return {
        success: true, market, symbol: sym, status: s.status,
        pricePrecision: s.pricePrecision, quantityPrecision: s.quantityPrecision,
        contractSize: s.contractSize, // COIN-M only: USD notional per contract
        tickSize: f('PRICE_FILTER').tickSize,
        stepSize: f('LOT_SIZE').stepSize,
        minQty: f('LOT_SIZE').minQty,
        minNotional: (f('MIN_NOTIONAL').notional || f('MIN_NOTIONAL').minNotional),
    };
}

/** Round a price/quantity to a symbol's tickSize/stepSize (reads exchangeInfo). */
export async function roundToFilters({market = 'futures', symbol, price, quantity, stopPrice, _deps = {}} = {}) {
    const info = await getSymbolInfo({market, symbol, _deps});
    const out = {success: true, market, symbol: info.symbol, tickSize: info.tickSize, stepSize: info.stepSize};
    if (price !== undefined) out.price = snap(price, info.tickSize, 'round');
    if (stopPrice !== undefined) out.stopPrice = snap(stopPrice, info.tickSize, 'round');
    if (quantity !== undefined) out.quantity = snap(quantity, info.stepSize, 'floor');
    return out;
}
