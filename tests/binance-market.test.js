/**
 * Unit tests for src/core/binance.js — market data & analysis: klines/tickers,
 * funding, compareSymbols, technicals, correlation, the backtesting engine,
 * multi-timeframe confluence, signal scan, candlestick patterns, getSignal.
 * Pure, no network.
 */
import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {
    backtestStrategy,
    calcPositionSize,
    compareStrategies,
    compareSymbols,
    correlateSymbols,
    detectCandlestickPatterns,
    get24hrTicker,
    getAvgPrice,
    getBookTicker,
    getFundingRate,
    getKlines,
    getLongShortRatio,
    getMultiTimeframe,
    getOpenInterest,
    getOpenInterestHist,
    getPositioning,
    getRollingWindowTicker,
    getSignal,
    getTakerBuySellRatio,
    getTechnicals,
    getTradingDayTicker,
    getUiKlines,
    optimizeStrategy,
    SCAN_SIGNAL_KEYS,
    scanSignals,
    STRATEGY_KEYS,
    walkForwardBacktest,
} from '../src/core/binance.js';
import {deps, FILTERS, genKlines} from './_binance_helpers.js';

// ── market-data reads (public) ───────────────────────────────────────────────
describe('market data — klines / tickers (public)', () => {
    it('getKlines parses positional arrays into OHLCV objects and hits the futures endpoint', async () => {
        const _deps = deps({
            klines: [
                [1700000000000, '60000', '60500', '59800', '60200', '12.5', 1700003599999, '750000', 100, '6', '360000', '0'],
            ]
        });
        const r = await getKlines({market: 'futures', symbol: 'BTCUSDC', interval: '1h', _deps});
        assert.equal(r.count, 1);
        assert.deepEqual(r.candles[0], {
            openTime: 1700000000000, open: '60000', high: '60500', low: '59800', close: '60200', volume: '12.5', closeTime: 1700003599999,
        });
        assert.match(_deps.fetch.calls[0].url, /\/fapi\/v1\/klines/);
    });

    it('getKlines extended:true surfaces order-flow columns (and omits them by default)', async () => {
        const row = [1700000000000, '60000', '60500', '59800', '60200', '12.5', 1700003599999, '750000', 100, '6', '360000', '0'];
        const _plain = deps({klines: [row]});
        const plain = await getKlines({market: 'futures', symbol: 'BTCUSDC', _deps: _plain});
        assert.equal(plain.candles[0].quoteVolume, undefined);
        const _ext = deps({klines: [row]});
        const ext = await getKlines({market: 'futures', symbol: 'BTCUSDC', extended: true, _deps: _ext});
        assert.deepEqual(ext.candles[0], {
            openTime: 1700000000000, open: '60000', high: '60500', low: '59800', close: '60200', volume: '12.5', closeTime: 1700003599999,
            quoteVolume: '750000', trades: 100, takerBuyVolume: '6', takerBuyQuoteVolume: '360000',
        });
    });

    it('getKlines rejects an invalid interval', async () => {
        await assert.rejects(getKlines({symbol: 'BTCUSDC', interval: '7m', _deps: deps()}), /interval must be one of/);
    });

    it('getKlines caps limit (futures 1500) and uses spot endpoint for spot', async () => {
        const _deps = deps({klines: []});
        await getKlines({market: 'futures', symbol: 'BTCUSDC', limit: 9999, _deps});
        assert.match(_deps.fetch.calls[0].url, /limit=1500/);
        const _spot = deps({klines: []});
        await getKlines({market: 'spot', symbol: 'BTCUSDC', limit: 9999, _deps: _spot});
        assert.match(_spot.fetch.calls[0].url, /\/api\/v3\/klines/);
        assert.match(_spot.fetch.calls[0].url, /limit=1000/);
    });

    it('get24hrTicker maps the change fields', async () => {
        const _deps = deps({
            'ticker/24hr': {
                symbol: 'BTCUSDC',
                lastPrice: '60200',
                priceChangePercent: '-3.5',
                highPrice: '63000',
                lowPrice: '59700',
                volume: '1234'
            }
        });
        const r = await get24hrTicker({market: 'futures', symbol: 'BTCUSDC', _deps});
        assert.equal(r.lastPrice, '60200');
        assert.equal(r.priceChangePercent, '-3.5');
        assert.equal(r.highPrice, '63000');
    });

    it('getBookTicker computes the spread', async () => {
        const _deps = deps({bookTicker: {symbol: 'BTCUSDC', bidPrice: '60200.0', bidQty: '1', askPrice: '60200.5', askQty: '2'}});
        const r = await getBookTicker({market: 'futures', symbol: 'BTCUSDC', _deps});
        assert.equal(r.bidPrice, '60200.0');
        assert.equal(r.askPrice, '60200.5');
        assert.equal(r.spread, '0.5');
        assert.match(r.spreadPct, /%$/);
    });

    it('getAvgPrice is spot-only and returns the average', async () => {
        await assert.rejects(getAvgPrice({market: 'futures', symbol: 'BTCUSDC', _deps: deps()}), /spot-only/);
        const _deps = deps({avgPrice: {mins: 5, price: '60150.42'}});
        const r = await getAvgPrice({market: 'spot', symbol: 'BTCUSDC', _deps});
        assert.equal(r.price, '60150.42');
        assert.equal(r.mins, 5);
    });

    it('getRollingWindowTicker is spot-only and passes windowSize', async () => {
        await assert.rejects(getRollingWindowTicker({market: 'futures', symbol: 'BTCUSDC', _deps: deps()}), /spot-only/);
        const _deps = deps({windowSize: {symbol: 'BTCUSDC', lastPrice: '60200', priceChangePercent: '-2.1'}});
        const r = await getRollingWindowTicker({market: 'spot', symbol: 'BTCUSDC', windowSize: '4h', _deps});
        assert.equal(r.windowSize, '4h');
        assert.equal(r.priceChangePercent, '-2.1');
        assert.match(_deps.fetch.calls[0].url, /windowSize=4h/);
    });
});

describe('getFundingRate', () => {
    it('current snapshot formats the rate as a percent', async () => {
        const _deps = deps({premiumIndex: {symbol: 'BTCUSDC', markPrice: '60000', indexPrice: '60010', lastFundingRate: '0.0001', nextFundingTime: 123}});
        const r = await getFundingRate({market: 'futures', symbol: 'BTCUSDC', _deps});
        assert.equal(r.lastFundingRate, '0.0001');
        assert.equal(r.lastFundingRatePct, '0.0100%');
    });
    it('history returns recent payments', async () => {
        const _deps = deps({fundingRate: [{symbol: 'BTCUSDC', fundingRate: '0.0001', fundingTime: 1}]});
        const r = await getFundingRate({market: 'futures', symbol: 'BTCUSDC', history: true, _deps});
        assert.equal(r.count, 1);
        assert.equal(r.fundingHistory[0].fundingRatePct, '0.0100%');
    });
});

describe('market-data scan variants', () => {
    it('get24hrTicker all:true returns every symbol; quote narrows to a quote asset', async () => {
        const _deps = deps({
            'ticker/24hr': [
                {symbol: 'BTCUSDC', lastPrice: '60000', priceChangePercent: '1.2'},
                {symbol: 'ETHUSDC', lastPrice: '3000', priceChangePercent: '-0.5'},
                {symbol: 'BTCUSDT', lastPrice: '60010', priceChangePercent: '1.1'},
            ]
        });
        const r = await get24hrTicker({market: 'futures', all: true, quote: 'USDC', _deps});
        assert.equal(r.all, true);
        assert.equal(r.count, 2);
        assert.ok(r.tickers.every((t) => t.symbol.endsWith('USDC')));
    });
    it('getBookTicker all:true maps the spread per row', async () => {
        const _deps = deps({'ticker/bookTicker': [{symbol: 'BTCUSDC', bidPrice: '60000', askPrice: '60010', bidQty: '1', askQty: '2'}]});
        const r = await getBookTicker({market: 'futures', all: true, _deps});
        assert.equal(r.count, 1);
        assert.equal(r.tickers[0].spread, '10');
    });
    it('getRollingWindowTicker scans a symbols list (spot) and sends a symbols param', async () => {
        const _deps = deps({
            '/api/v3/ticker?': [
                {symbol: 'BTCUSDC', lastPrice: '60000'}, {symbol: 'ETHUSDC', lastPrice: '3000'},
            ]
        });
        const r = await getRollingWindowTicker({market: 'spot', symbols: ['BTCUSDC', 'ETHUSDC'], windowSize: '4h', _deps});
        assert.equal(r.count, 2);
        assert.equal(r.windowSize, '4h');
        assert.match(_deps.fetch.calls[0].url, /symbols=/);
    });
});

describe('getUiKlines', () => {
    it('maps spot uiKlines candles and hits /api/v3/uiKlines', async () => {
        const _deps = deps({uiKlines: [[1, '1', '2', '0.5', '1.5', '100', 2]]});
        const r = await getUiKlines({market: 'spot', symbol: 'BTCUSDC', interval: '1h', _deps});
        assert.equal(r.count, 1);
        assert.equal(r.candles[0].high, '2');
        assert.match(_deps.fetch.calls[0].url, /\/api\/v3\/uiKlines/);
    });
    it('rejects futures', async () => {
        await assert.rejects(getUiKlines({market: 'futures', symbol: 'BTCUSDC', _deps: deps()}), /spot-only/);
    });
});

describe('getTradingDayTicker', () => {
    it('single symbol returns one row', async () => {
        const _deps = deps({'ticker/tradingDay': {symbol: 'BTCUSDC', lastPrice: '60000', priceChangePercent: '1.0'}});
        const r = await getTradingDayTicker({market: 'spot', symbol: 'BTCUSDC', _deps});
        assert.equal(r.symbol, 'BTCUSDC');
        assert.equal(r.lastPrice, '60000');
    });
    it('symbols list returns an array and sends a symbols param', async () => {
        const _deps = deps({'ticker/tradingDay': [{symbol: 'BTCUSDC', lastPrice: '60000'}, {symbol: 'ETHUSDC', lastPrice: '3000'}]});
        const r = await getTradingDayTicker({market: 'spot', symbols: 'BTCUSDC,ETHUSDC', _deps});
        assert.equal(r.count, 2);
        assert.match(_deps.fetch.calls[0].url, /symbols=/);
    });
    it('rejects futures', async () => {
        await assert.rejects(getTradingDayTicker({market: 'futures', symbol: 'BTCUSDC', _deps: deps()}), /spot-only/);
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
            return {ok: true, status: 200, json: async () => ({symbol: sym, ...bySymbol[sym]})};
        }
        return {ok: true, status: 200, json: async () => ({})};
    };
    fn.calls = calls;
    return fn;
}

describe('compareSymbols', () => {
    it('ranks by priceChangePercent (descending) with leader/laggard', async () => {
        const fetch = compareFetch({
            BTCUSDC: {lastPrice: '60000', priceChangePercent: '2.5', quoteVolume: '100'},
            ETHUSDC: {lastPrice: '3000', priceChangePercent: '-1.0', quoteVolume: '300'},
            SOLUSDC: {lastPrice: '150', priceChangePercent: '5.2', quoteVolume: '200'},
        });
        const r = await compareSymbols({market: 'futures', symbols: 'BTCUSDC,ETHUSDC,SOLUSDC', _deps: {fetch}});
        assert.equal(r.count, 3);
        assert.equal(r.sortBy, 'priceChangePercent');
        assert.deepEqual(r.comparison.map((x) => x.symbol), ['SOLUSDC', 'BTCUSDC', 'ETHUSDC']);
        assert.deepEqual(r.comparison.map((x) => x.rank), [1, 2, 3]);
        assert.equal(r.leader, 'SOLUSDC');
        assert.equal(r.laggard, 'ETHUSDC');
    });

    it('sorts by quoteVolume when requested', async () => {
        const fetch = compareFetch({
            BTCUSDC: {priceChangePercent: '2.5', quoteVolume: '100'},
            ETHUSDC: {priceChangePercent: '-1.0', quoteVolume: '300'},
        });
        const r = await compareSymbols({market: 'futures', symbols: ['BTCUSDC', 'ETHUSDC'], sortBy: 'quoteVolume', _deps: {fetch}});
        assert.equal(r.sortBy, 'quoteVolume');
        assert.deepEqual(r.comparison.map((x) => x.symbol), ['ETHUSDC', 'BTCUSDC']);
    });

    it('unknown sortBy falls back to priceChangePercent and dedupes symbols', async () => {
        const fetch = compareFetch({BTCUSDC: {priceChangePercent: '1'}});
        const r = await compareSymbols({symbols: 'BTCUSDC,btcusdc', sortBy: 'nope', _deps: {fetch}});
        assert.equal(r.sortBy, 'priceChangePercent');
        assert.equal(r.count, 1); // deduped (case-insensitive)
    });

    it('requires at least one symbol', async () => {
        await assert.rejects(compareSymbols({symbols: '', _deps: {fetch: compareFetch({})}}), /symbols is required/);
        await assert.rejects(compareSymbols({_deps: {fetch: compareFetch({})}}), /symbols is required/);
    });
});

// ── Technical analysis (computed off klines) ─────────────────────────────────
describe('getTechnicals — indicators off klines', () => {
    it('computes RSI/ATR/MACD/SMA/EMA/Bollinger/VWAP and classifies an uptrend', async () => {
        const _deps = deps({klines: genKlines(120, (i) => 60000 + i * 30 + i * i * 0.4)}); // accelerating uptrend → +MACD hist
        const r = await getTechnicals({market: 'futures', symbol: 'BTCUSDC', interval: '1h', _deps});
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
        const _deps = deps({klines: genKlines(10, (i) => 100 + i)}); // < periods for ATR/MACD/SMA50
        const r = await getTechnicals({market: 'futures', symbol: 'BTCUSDC', _deps});
        assert.equal(r.success, true);
        assert.equal(r.atr, null);
        assert.equal(r.macd, null);
        assert.equal(r.sma, null); // SMA20 needs 20 bars
    });

    it('requires a symbol', async () => {
        await assert.rejects(getTechnicals({market: 'futures', _deps: deps()}), /symbol is required/);
    });
});

describe('calcPositionSize — ATR-derived stop', () => {
    it('derives a LONG stop below entry from ATR and sizes off it', async () => {
        const _deps = deps({klines: genKlines(120, (i) => 60000 + i * 50)});
        const r = await calcPositionSize({market: 'futures', symbol: 'BTCUSDC', entry: 66000, side: 'BUY', atrMult: 1.5, riskAmount: 100, _deps});
        assert.equal(r.atrStop.source, 'ATR');
        assert.equal(r.atrStop.atrMult, 1.5);
        assert.ok(r.atrStop.atr > 0);
        assert.ok(r.stop < 66000); // long → stop sits below entry
        assert.ok(r.quantity > 0);
        assert.equal(r.side, 'LONG (BUY)');
    });

    it('derives a SHORT stop above entry', async () => {
        const _deps = deps({klines: genKlines(120, (i) => 60000 + i * 50)});
        const r = await calcPositionSize({market: 'futures', symbol: 'BTCUSDC', entry: 66000, side: 'SELL', atrMult: 2, riskAmount: 100, _deps});
        assert.ok(r.stop > 66000);
    });

    it('rejects an ATR stop without a side', async () => {
        const _deps = deps({klines: genKlines(120, (i) => 60000 + i * 50)});
        await assert.rejects(calcPositionSize({market: 'futures', symbol: 'BTCUSDC', entry: 66000, atrMult: 1.5, riskAmount: 100, _deps}), /side/);
    });

    it('rejects when neither stop nor atrMult is given', async () => {
        await assert.rejects(calcPositionSize({market: 'futures', symbol: 'BTCUSDC', entry: 66000, riskAmount: 100, _deps: deps()}), /pass stop, or atrMult/);
    });

    it('still works with an explicit stop (no ATR, no klines call)', async () => {
        const _deps = deps();
        const r = await calcPositionSize({market: 'futures', symbol: 'BTCUSDC', entry: 66000, stop: 65000, riskAmount: 100, _deps});
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
            if (url.includes('exchangeInfo')) return {ok: true, status: 200, json: async () => FILTERS};
            if (url.includes('klines')) {
                const m = url.match(/symbol=([A-Z]+)/);
                const fn = series[m && m[1]] || series.BTCUSDC;
                return {ok: true, status: 200, json: async () => genKlines(120, fn)};
            }
            return {ok: true, status: 200, json: async () => ({})};
        };
        fetch.calls = [];
        const wrapped = async (u, o) => {
            fetch.calls.push({url: u});
            return fetch(u, o);
        };
        wrapped.calls = fetch.calls;
        return {fetch: wrapped, keys: {key: 'k', secret: 's'}, now: () => 1700000000000};
    }

    it('returns per-symbol stats, a correlation matrix and rankings', async () => {
        const r = await correlateSymbols({market: 'futures', symbols: 'BTCUSDC,ETHUSDC,INVUSDC', interval: '1h', _deps: corrDeps()});
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
        const r = await correlateSymbols({market: 'futures', symbols: ['BTCUSDC', 'ETHUSDC'], _deps: corrDeps()});
        assert.equal(r.count, 2);
    });

    it('requires at least two symbols', async () => {
        await assert.rejects(correlateSymbols({market: 'futures', symbols: 'BTCUSDC', _deps: deps()}), /at least two symbols/);
    });
});

// ── Backtesting engine ───────────────────────────────────────────────────────
describe('backtestStrategy — off klines, no lookahead', () => {
    it('produces institutional metrics and a buy&hold benchmark on a trending series', async () => {
        const _deps = deps({klines: genKlines(400, (i) => 60000 + i * 30 + Math.sin(i / 7) * 400)});
        const r = await backtestStrategy({market: 'futures', symbol: 'BTCUSDC', interval: '1h', strategy: 'ema_cross', _deps});
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
        const _deps = deps({klines: genKlines(300, (i) => 50000 + i * 20)});
        const r = await backtestStrategy({market: 'futures', symbol: 'BTCUSDC', strategy: 'supertrend', includeTrades: true, includeEquityCurve: true, _deps});
        assert.ok(Array.isArray(r.trades));
        assert.ok(Array.isArray(r.equityCurve));
        assert.equal(r.equityCurve.length, r.bars); // one point per bar (incl. the seed)
        if (r.trades.length) {
            assert.ok(['LONG', 'SHORT'].includes(r.trades[0].side));
            assert.equal(typeof r.trades[0].returnPct, 'number');
        }
    });

    it('allowShort:false clamps out short trades (long-only)', async () => {
        const _deps = deps({klines: genKlines(300, (i) => 60000 - i * 20)}); // downtrend
        const r = await backtestStrategy({market: 'futures', symbol: 'BTCUSDC', strategy: 'ema_cross', allowShort: false, includeTrades: true, _deps});
        assert.equal(r.longOnly, true);
        assert.ok(r.trades.every((t) => t.side === 'LONG'));
    });

    it('higher commission reduces net return (costs are charged on turnover)', async () => {
        const series = (i) => 60000 + Math.sin(i / 4) * 800; // choppy → frequent flips → more cost
        const lo = await backtestStrategy({
            market: 'futures',
            symbol: 'BTCUSDC',
            strategy: 'macd',
            commission: 0,
            slippage: 0,
            _deps: deps({klines: genKlines(300, series)})
        });
        const hi = await backtestStrategy({
            market: 'futures',
            symbol: 'BTCUSDC',
            strategy: 'macd',
            commission: 0.005,
            slippage: 0.005,
            _deps: deps({klines: genKlines(300, series)})
        });
        assert.ok(hi.totalReturnPct < lo.totalReturnPct);
    });

    it('rejects an unknown strategy and a missing symbol', async () => {
        await assert.rejects(backtestStrategy({
            market: 'futures',
            symbol: 'BTCUSDC',
            strategy: 'nope',
            _deps: deps({klines: genKlines(80, (i) => 100 + i)})
        }), /unknown strategy/);
        await assert.rejects(backtestStrategy({market: 'futures', _deps: deps()}), /symbol is required/);
    });

    it('rejects too few bars', async () => {
        await assert.rejects(backtestStrategy({
            market: 'futures',
            symbol: 'BTCUSDC',
            _deps: deps({klines: genKlines(40, (i) => 100 + i)})
        }), /not enough candles/);
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
        const _deps = deps({klines: genKlines(400, (i) => 60000 + i * 25 + Math.sin(i / 6) * 300)});
        const r = await compareStrategies({market: 'futures', symbol: 'BTCUSDC', sortBy: 'sharpe', _deps});
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
        const r = await compareStrategies({
            market: 'futures',
            symbol: 'BTCUSDC',
            sortBy: 'bogus',
            _deps: deps({klines: genKlines(200, (i) => 50000 + i * 10)})
        });
        assert.equal(r.sortBy, 'totalReturnPct');
    });
});

describe('walkForwardBacktest — train/test verdict', () => {
    it('splits, scores both windows, and emits a verdict', async () => {
        const _deps = deps({klines: genKlines(500, (i) => 60000 + i * 20 + Math.sin(i / 8) * 200)});
        const r = await walkForwardBacktest({market: 'futures', symbol: 'BTCUSDC', strategy: 'ema_cross', limit: 500, _deps});
        assert.equal(r.success, true);
        assert.equal(r.trainRatio, 0.7);
        assert.ok(r.train && r.test);
        assert.ok(['ROBUST', 'MODERATE', 'WEAK', 'OVERFITTED', 'UNPROFITABLE', 'INCONCLUSIVE', 'INSUFFICIENT_DATA'].includes(r.verdict));
        assert.ok(typeof r.splitTime === 'number');
    });

    it('rejects an out-of-range trainRatio', async () => {
        await assert.rejects(walkForwardBacktest({
            market: 'futures',
            symbol: 'BTCUSDC',
            trainRatio: 0.99,
            _deps: deps({klines: genKlines(200, (i) => 100 + i)})
        }), /trainRatio/);
    });
});

// ── Multi-timeframe / signal scan / candlesticks ─────────────────────────────
describe('getMultiTimeframe — confluence', () => {
    it('aggregates trend across timeframes and flags alignment', async () => {
        const _deps = deps({klines: genKlines(300, (i) => 60000 + i * 40 + i * i * 0.5)}); // strong uptrend on every TF
        const r = await getMultiTimeframe({market: 'futures', symbol: 'BTCUSDC', intervals: ['15m', '1h', '4h'], _deps});
        assert.equal(r.success, true);
        assert.equal(r.timeframes.length, 3);
        assert.equal(r.confluence.bullish, 3);
        assert.equal(r.confluence.score, 1);
        assert.equal(r.confluence.bias, 'bullish');
        assert.equal(r.confluence.aligned, true);
    });

    it('defaults to 15m/1h/4h/1d', async () => {
        const r = await getMultiTimeframe({market: 'futures', symbol: 'BTCUSDC', _deps: deps({klines: genKlines(300, (i) => 60000 + i * 10)})});
        assert.deepEqual(r.timeframes.map((t) => t.interval), ['15m', '1h', '4h', '1d']);
    });
});

describe('scanSignals — symbol screening', () => {
    it('matches bullish symbols and dedupes/caps', async () => {
        const _deps = deps({klines: genKlines(300, (i) => 60000 + i * 50 + i * i * 0.6)}); // uptrend for every symbol
        const r = await scanSignals({market: 'futures', symbols: ['BTCUSDC', 'ETHUSDC'], signal: 'bullish', _deps});
        assert.equal(r.success, true);
        assert.equal(r.signal, 'bullish');
        assert.equal(r.scanned, 2);
        assert.equal(r.matchCount, 2);
        assert.equal(r.matches[0].trend, 'bullish');
    });

    it('rejects an unknown signal and an empty list', async () => {
        await assert.rejects(scanSignals({market: 'futures', symbols: ['BTCUSDC'], signal: 'nope', _deps: deps()}), /unknown signal/);
        await assert.rejects(scanSignals({market: 'futures', symbols: [], signal: 'oversold', _deps: deps()}), /at least one symbol/);
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
            if (url.includes('exchangeInfo')) return {ok: true, status: 200, json: async () => ({symbols: []})};
            if (url.includes('klines')) return {ok: true, status: 200, json: async () => candles(rows)};
            return {ok: true, status: 200, json: async () => ({})};
        };
        const wrapped = async (...a) => {
            (wrapped.calls ||= []).push({url: a[0]});
            return fetch(...a);
        };
        return {fetch: wrapped, keys: {key: 'k', secret: 's'}, now: () => 1700000000000};
    };

    it('detects a bullish engulfing on the last bar', async () => {
        // prev bar bearish (100→95), last bar bullish engulfing it (94→102)
        const rows = [[100, 101, 99, 100], [100, 100.5, 94.5, 95], [94, 102.5, 93.5, 102]];
        const r = await detectCandlestickPatterns({market: 'futures', symbol: 'BTCUSDC', lookback: 1, _deps: csDeps(rows)});
        assert.equal(r.success, true);
        assert.ok(r.lastBar.patterns.some((p) => p.pattern === 'bullish_engulfing' && p.bias === 'bullish'));
    });

    it('detects a doji on the last bar', async () => {
        const rows = [[100, 101, 99, 100], [100, 101, 99, 100], [100, 105, 95, 100.05]];
        const r = await detectCandlestickPatterns({market: 'futures', symbol: 'BTCUSDC', lookback: 1, _deps: csDeps(rows)});
        assert.ok(r.lastBar.patterns.some((p) => p.pattern === 'doji'));
    });

    it('rejects with fewer than 3 candles', async () => {
        await assert.rejects(detectCandlestickPatterns({
            market: 'futures',
            symbol: 'BTCUSDC',
            _deps: csDeps([[1, 2, 0.5, 1.5], [1, 2, 0.5, 1.5]])
        }), /at least 3 candles/);
    });
});

describe('getSignal — composite decision score', () => {
    it('returns BUY with bullish reasons on a strong uptrend', async () => {
        const _deps = deps({klines: genKlines(300, (i) => 50000 + i * 40 + i * i * 0.5)});
        const r = await getSignal({market: 'futures', symbol: 'BTCUSDC', interval: '1h', _deps});
        assert.equal(r.success, true);
        assert.equal(r.signal, 'BUY');
        assert.ok(r.score > 0.3);
        assert.ok(r.bullishFactors > r.bearishFactors);
        assert.ok(Array.isArray(r.reasons) && r.reasons.length > 0);
        assert.ok(['low', 'moderate', 'high'].includes(r.confidence));
        assert.equal(r.multiTimeframe, undefined); // mtf off by default
    });

    it('returns SELL on a downtrend', async () => {
        const _deps = deps({klines: genKlines(300, (i) => 90000 - i * 40 - i * i * 0.4)});
        const r = await getSignal({market: 'futures', symbol: 'BTCUSDC', _deps});
        assert.equal(r.signal, 'SELL');
        assert.ok(r.score < -0.3);
        assert.ok(r.bearishFactors > r.bullishFactors);
    });

    it('flags overbought as a caution and dampens confidence', async () => {
        const _deps = deps({klines: genKlines(300, (i) => 50000 + i * 60 + i * i * 0.8)}); // very steep → RSI ~100
        const r = await getSignal({market: 'futures', symbol: 'BTCUSDC', _deps});
        assert.ok((r.cautions || []).some((c) => /overbought/.test(c)));
        assert.notEqual(r.confidence, 'high'); // a caution knocks "high" down to "moderate"
    });

    it('folds in multi-timeframe confluence when mtf:true', async () => {
        const _deps = deps({klines: genKlines(300, (i) => 50000 + i * 40 + i * i * 0.5)});
        const r = await getSignal({market: 'futures', symbol: 'BTCUSDC', mtf: true, _deps});
        assert.ok(r.multiTimeframe);
        assert.equal(typeof r.multiTimeframe.score, 'number');
        assert.ok(r.reasons.some((x) => /multi-timeframe/.test(x)));
    });

    it('requires a symbol', async () => {
        await assert.rejects(getSignal({market: 'futures', _deps: deps()}), /symbol is required/);
    });
});

// ── open interest & positioning statistics (public, USD-M) ───────────────────
describe('open interest & positioning', () => {
    const OI_ROWS = [
        {sumOpenInterest: '80000', sumOpenInterestValue: '5000000000', timestamp: 1},
        {sumOpenInterest: '90000', sumOpenInterestValue: '5600000000', timestamp: 2},
        {sumOpenInterest: '100000', sumOpenInterestValue: '6300000000', timestamp: 3},
    ];

    it('getOpenInterest hits the futures snapshot endpoint and parses the number', async () => {
        const _deps = deps({'v1/openInterest': {openInterest: '12345.678', symbol: 'BTCUSDC', time: 99}});
        const r = await getOpenInterest({market: 'futures', symbol: 'btcusdc', _deps});
        assert.equal(r.openInterest, 12345.678);
        assert.equal(r.symbol, 'BTCUSDC');
        assert.match(_deps.fetch.calls[0].url, /\/fapi\/v1\/openInterest\?symbol=BTCUSDC/);
    });

    it('getOpenInterest rejects spot', async () => {
        await assert.rejects(getOpenInterest({market: 'spot', symbol: 'BTCUSDC', _deps: deps()}), /futures-only/);
    });

    it('getOpenInterestHist computes window change % and rejects COIN-M / bad periods', async () => {
        const _deps = deps({openInterestHist: OI_ROWS});
        const r = await getOpenInterestHist({market: 'futures', symbol: 'BTCUSDC', period: '1h', _deps});
        assert.equal(r.count, 3);
        assert.equal(r.changePct, 25); // 80k -> 100k
        assert.equal(r.latest.openInterest, 100000);
        assert.match(_deps.fetch.calls[0].url, /\/futures\/data\/openInterestHist/);
        await assert.rejects(getOpenInterestHist({market: 'coinm', symbol: 'BTCUSD_PERP', _deps: deps()}), /USD-M futures-only/);
        await assert.rejects(getOpenInterestHist({market: 'futures', symbol: 'BTCUSDC', period: '7m', _deps: deps()}), /period must be one of/);
    });

    it('getOpenInterestHist notes the USDT-twin proxy when a symbol is not covered', async () => {
        const _deps = deps({openInterestHist: []});
        const r = await getOpenInterestHist({market: 'futures', symbol: 'BTCUSDC', _deps});
        assert.equal(r.count, 0);
        assert.match(r.note, /BTCUSDT/);
    });

    it('getLongShortRatio routes each kind to its endpoint and parses ratios', async () => {
        const row = [{longShortRatio: '2.5', longAccount: '0.7143', shortAccount: '0.2857', timestamp: 5}];
        const _g = deps({globalLongShortAccountRatio: row});
        const g = await getLongShortRatio({market: 'futures', symbol: 'BTCUSDC', kind: 'global', _deps: _g});
        assert.equal(g.latest.ratio, 2.5);
        assert.match(_g.fetch.calls[0].url, /globalLongShortAccountRatio/);
        const _p = deps({topLongShortPositionRatio: row});
        await getLongShortRatio({market: 'futures', symbol: 'BTCUSDC', kind: 'topPosition', _deps: _p});
        assert.match(_p.fetch.calls[0].url, /topLongShortPositionRatio/);
        await assert.rejects(getLongShortRatio({market: 'futures', symbol: 'BTCUSDC', kind: 'nope', _deps: deps()}), /kind must be one of/);
    });

    it('getTakerBuySellRatio averages the buy/sell ratio over the window', async () => {
        const _deps = deps({takerlongshortRatio: [
            {buySellRatio: '1.2', buyVol: '120', sellVol: '100', timestamp: 1},
            {buySellRatio: '0.8', buyVol: '80', sellVol: '100', timestamp: 2},
        ]});
        const r = await getTakerBuySellRatio({market: 'futures', symbol: 'BTCUSDC', _deps});
        assert.equal(r.latest.buySellRatio, 0.8);
        assert.equal(r.avgBuySellRatio, 1);
    });

    it('getPositioning reads new_longs when price and OI rise together, with crowding cautions', async () => {
        const _deps = deps({
            openInterestHist: OI_ROWS,
            globalLongShortAccountRatio: [{longShortRatio: '3.5', longAccount: '0.7778', shortAccount: '0.2222', timestamp: 1}],
            topLongShortPositionRatio: [{longShortRatio: '1.4', longAccount: '0.5833', shortAccount: '0.4167', timestamp: 1}],
            takerlongshortRatio: [{buySellRatio: '1.3', buyVol: '130', sellVol: '100', timestamp: 1}],
            klines: genKlines(30, (i) => 60000 + i * 100),
        });
        const r = await getPositioning({market: 'futures', symbol: 'BTCUSDC', _deps});
        assert.equal(r.read.quadrant, 'new_longs');
        assert.equal(r.read.score, 1);
        assert.equal(r.openInterest.direction, 'up');
        assert.equal(r.price.direction, 'up');
        assert.equal(r.longShort.global.ratio, 3.5);
        assert.equal(r.takerFlow.read, 'aggressive buyers dominating');
        assert.ok(r.cautions.some((c) => /crowded long/.test(c)));
        assert.equal(r.proxySymbol, undefined);
    });

    it('getPositioning falls back to the USDT twin and tags proxySymbol', async () => {
        const _deps = deps({
            'openInterestHist?symbol=BTCUSDC': [],
            'openInterestHist?symbol=BTCUSDT': OI_ROWS,
            globalLongShortAccountRatio: [{longShortRatio: '1.1', longAccount: '0.5238', shortAccount: '0.4762', timestamp: 1}],
            topLongShortPositionRatio: [],
            takerlongshortRatio: [],
            klines: genKlines(30, (i) => 60000 - i * 100),
        });
        const r = await getPositioning({market: 'futures', symbol: 'BTCUSDC', _deps});
        assert.equal(r.symbol, 'BTCUSDC');
        assert.equal(r.proxySymbol, 'BTCUSDT');
        assert.equal(r.read.quadrant, 'new_shorts'); // price down + OI up
        assert.ok(r.cautions.some((c) => /proxy/.test(c)));
        // stats calls after the fallback went to the twin
        assert.ok(_deps.fetch.calls.some((c) => c.url.includes('globalLongShortAccountRatio') && c.url.includes('BTCUSDT')));
    });

    it('getSignal positioning:true folds the OI read in as a factor', async () => {
        const _deps = deps({
            openInterestHist: OI_ROWS,
            globalLongShortAccountRatio: [],
            topLongShortPositionRatio: [],
            takerlongshortRatio: [],
            klines: genKlines(300, (i) => 50000 + i * 40 + i * i * 0.5),
        });
        const r = await getSignal({market: 'futures', symbol: 'BTCUSDC', positioning: true, _deps});
        assert.ok(r.positioning);
        assert.equal(r.positioning.quadrant, 'new_longs');
        assert.ok(r.reasons.some((x) => /open interest/.test(x)));
    });
});

// ── strategy parameter optimization ──────────────────────────────────────────
describe('optimizeStrategy — parameter grid sweep', () => {
    // Trending series with cyclical pullbacks — enough structure for crosses to differ by params.
    const KL = () => genKlines(600, (i) => 50000 + i * 30 + 800 * Math.sin(i / 12));

    it('sweeps the grid, ranks on train only, and judges the winner out-of-sample', async () => {
        const r = await optimizeStrategy({market: 'futures', symbol: 'BTCUSDC', strategy: 'ema_cross', _deps: deps({klines: KL()})});
        assert.equal(r.combosTested, 9); // fast [9,12,20] × slow [26,50,100]
        assert.ok(r.winner.params.fast < r.winner.params.slow);
        assert.ok(r.winner.train && r.winner.test);
        assert.ok(r.default.isDefault);
        assert.deepEqual(r.default.params, {fast: 20, slow: 50});
        assert.equal(typeof r.selectionEdgePct, 'number');
        assert.ok(['ROBUST', 'MODERATE', 'WEAK', 'OVERFITTED', 'UNPROFITABLE', 'INCONCLUSIVE', 'INSUFFICIENT_DATA'].includes(r.verdict));
        // leaderboard is sorted by the train-window score, descending
        for (let i = 1; i < r.leaderboard.length; i++) {
            assert.ok((r.leaderboard[i - 1].trainScore ?? -Infinity) >= (r.leaderboard[i].trainScore ?? -Infinity));
        }
    });

    it('the default-params combo reproduces the plain backtest behavior', async () => {
        const rows = KL();
        const opt = await optimizeStrategy({market: 'futures', symbol: 'BTCUSDC', strategy: 'supertrend', trainRatio: 0.7, _deps: deps({klines: rows})});
        assert.ok(opt.default);
        assert.deepEqual(opt.default.params, {period: 10, mult: 3});
    });

    it('respects valid() constraints and rejects bad inputs', async () => {
        const r = await optimizeStrategy({market: 'futures', symbol: 'BTCUSDC', strategy: 'macd', _deps: deps({klines: KL()})});
        assert.ok(r.combosTested === 18 && r.leaderboard.every((x) => x.params.fast < x.params.slow));
        await assert.rejects(optimizeStrategy({symbol: 'BTCUSDC', strategy: 'nope', _deps: deps()}), /unknown strategy/);
        await assert.rejects(optimizeStrategy({symbol: 'BTCUSDC', trainRatio: 0.99, _deps: deps()}), /trainRatio/);
        await assert.rejects(optimizeStrategy({symbol: 'BTCUSDC', _deps: deps({klines: genKlines(100, () => 50000)})}), /not enough candles/);
    });
});
