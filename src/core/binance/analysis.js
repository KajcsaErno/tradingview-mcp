// Binance core — technical analysis, backtesting and trade-math planners,
// all computed off klines (or pure math): indicator point/series helpers,
// getTechnicals, the 9-strategy backtester, scanners, and expectancy tools.
import {requireFinite} from '../../connection.js';
import {isFuturesLike} from './request.js';
import {getKlines, KLINE_INTERVALS} from './market.js';

// ── Trade-math planners (pure, no network) ──────────────────────────────────
// Forward-looking counterparts to backtestStrategy's backward-looking metrics:
// the math of expectancy. Given a win rate and reward:risk, what should you
// expect per trade, what losing streak is coming, and what risk-% keeps the
// drawdown survivable. (Nick Radge's expectancy/losing-streak framework — the
// two spreadsheets from the "math of winning" material.) These are theory:
// fixed-risk, and they exclude commission, slippage and tax, which make real
// results worse. None of them touch the network or an account.

/** Expectancy from a win rate (%) and reward:risk ratio (rr = reward per 1 risked).
 *  Returns expectancy in R (per unit risked), the break-even win rate (1/(1+rr)),
 *  and — if a risk budget is given — $/% per-trade and over-`trades` projections
 *  (fixed-risk, no compounding). Pure. */
export function calcExpectancy({winRate, rrRatio, riskPct, riskAmount, balance, trades = 100} = {}) {
    const wr = requireFinite(winRate, 'winRate');
    const rr = requireFinite(rrRatio, 'rrRatio');
    if (wr < 0 || wr > 100) throw new Error('winRate is a percent 0–100');
    if (rr <= 0) throw new Error('rrRatio must be > 0');
    const p = wr / 100, q = 1 - p;
    const expectancyR = p * rr - q;                 // win p× of +rr, lose q× of -1, in R units
    const breakevenWinRate = 100 / (1 + rr);        // win% where expectancyR = 0
    const n = Math.max(1, Math.floor(requireFinite(trades, 'trades')));
    let edge = 'breakeven';
    if (expectancyR > 1e-9) edge = 'positive';
    else if (expectancyR < -1e-9) edge = 'negative';
    const result = {
        success: true,
        winRate: wr, rrRatio: rr,
        expectancyR: Number(expectancyR.toFixed(4)),
        breakevenWinRatePct: Number(breakevenWinRate.toFixed(2)),
        edge,
        marginOverBreakevenPct: Number((wr - breakevenWinRate).toFixed(2)),
        trades: n,
    };
    let riskDollars;
    if (riskAmount != null) riskDollars = requireFinite(riskAmount, 'riskAmount');
    else if (riskPct != null && balance != null) riskDollars = requireFinite(balance, 'balance') * requireFinite(riskPct, 'riskPct') / 100;
    if (riskDollars != null) {
        result.riskPerTrade = Number(riskDollars.toFixed(2));
        result.expectancyPerTrade = Number((expectancyR * riskDollars).toFixed(2));
        result.expectedPnlOverTrades = Number((expectancyR * riskDollars * n).toFixed(2)); // fixed-risk
    }
    if (riskPct != null) {
        result.riskPct = requireFinite(riskPct, 'riskPct');
        result.expectancyPctPerTrade = Number((expectancyR * result.riskPct).toFixed(4));
    }
    result.note = 'Theoretical, fixed risk per trade — excludes commission, slippage, tax and compounding (compounding skews returns up, costs skew them down).';
    return result;
}

/** Estimate the longest losing streak to expect over a sample size, for a given
 *  win rate — the probabilistic estimate maxStreak ≈ ln(N)/ln(1/lossRate). Returns
 *  a table across sample sizes; if riskPct is given, also the drawdown that streak
 *  implies (fixed and compounded). Pure — an expectation, never a guarantee. */
export function estimateLosingStreak({winRate, sampleSize = 1000, riskPct} = {}) {
    const wr = requireFinite(winRate, 'winRate');
    if (wr <= 0 || wr >= 100) throw new Error('winRate is a percent strictly between 0 and 100');
    const q = 1 - wr / 100;                          // loss probability
    const streakFor = (nn) => Math.max(1, Math.ceil(Math.log(nn) / Math.log(1 / q)));
    const sizes = [100, 1000, 10000, 100000, 1000000];
    const n = Math.max(1, Math.floor(requireFinite(sampleSize, 'sampleSize')));
    const maxLosingStreak = streakFor(n);
    const result = {
        success: true,
        winRate: wr, lossRatePct: Number((q * 100).toFixed(2)), sampleSize: n,
        maxLosingStreak,
        table: sizes.map((s) => ({sampleSize: s, maxLosingStreak: streakFor(s)})),
        note: "Probabilistic estimate (Nick Radge): the longest run of consecutive losses you can reasonably expect to hit at least once over the sample — a ballpark, not a guarantee. Trades are independent (gambler's fallacy): a losing streak never makes the next trade more likely to win.",
    };
    if (riskPct != null) {
        const r = requireFinite(riskPct, 'riskPct');
        result.riskPct = r;
        result.streakDrawdownPctFixed = Number((maxLosingStreak * r).toFixed(2));               // linear, constant $ risk
        result.streakDrawdownPctCompounded = Number(((1 - Math.pow(1 - r / 100, maxLosingStreak)) * 100).toFixed(2)); // % risk
    }
    return result;
}

/** One Monte Carlo run of `nTrades` random trades — returns the final balance,
 *  max drawdown %, worst losing streak and whether the ruin drawdown was hit. */
function simulateRun({startBal, nTrades, riskPct, rr, p, compounding, ruinDD, rng}) {
    let bal = startBal, peak = startBal, maxDD = 0, streak = 0, worstStreak = 0, hitRuin = false;
    for (let t = 0; t < nTrades; t++) {
        const risk = (compounding ? bal : startBal) * (riskPct / 100);
        const win = rng() < p;
        bal += win ? risk * rr : -risk;
        if (win) streak = 0; else {
            streak += 1;
            worstStreak = Math.max(worstStreak, streak);
        }
        peak = Math.max(peak, bal);
        const dd = peak > 0 ? (peak - bal) / peak * 100 : 100;
        maxDD = Math.max(maxDD, dd);
        if (maxDD >= ruinDD) hitRuin = true;
        if (bal <= 0) {
            bal = 0;
            hitRuin = true;
            break;
        }
    }
    return {bal, maxDD, worstStreak, hitRuin};
}

/** Monte Carlo equity simulation: run `runs` independent sequences of `trades`
 *  trades at the given win rate and reward:risk, risking riskPct of balance each
 *  (compounding by default), and aggregate final return, max drawdown, longest
 *  losing streak and ruin frequency across runs. The forward-looking "expectancy
 *  tab" of the framework. RNG is injectable via _deps.rng for deterministic tests.
 *  Pure (no network). */
export function simulateEquity({
                                   winRate, rrRatio, riskPct = 1, startBalance = 10000,
                                   trades = 1000, runs = 1000, compounding = true, ruinDrawdownPct = 50, _deps = {},
                               } = {}) {
    const wr = requireFinite(winRate, 'winRate');
    const rr = requireFinite(rrRatio, 'rrRatio');
    const r = requireFinite(riskPct, 'riskPct');
    if (wr < 0 || wr > 100) throw new Error('winRate is a percent 0–100');
    if (rr <= 0) throw new Error('rrRatio must be > 0');
    if (r <= 0) throw new Error('riskPct must be > 0');
    const startBal = requireFinite(startBalance, 'startBalance');
    const nTrades = Math.min(Math.max(1, Math.floor(requireFinite(trades, 'trades'))), 100000);
    const nRuns = Math.min(Math.max(1, Math.floor(requireFinite(runs, 'runs'))), 10000);
    const ruinDD = requireFinite(ruinDrawdownPct, 'ruinDrawdownPct');
    const rng = _deps.rng || Math.random;
    const p = wr / 100;
    const finals = [], maxDDs = [], streaks = [];
    let ruined = 0, profitable = 0;
    for (let run = 0; run < nRuns; run++) {
        const {bal, maxDD, worstStreak, hitRuin} = simulateRun({startBal, nTrades, riskPct: r, rr, p, compounding, ruinDD, rng});
        finals.push(bal);
        maxDDs.push(maxDD);
        streaks.push(worstStreak);
        if (hitRuin) ruined += 1;
        if (bal > startBal) profitable += 1;
    }
    const pctl = (arr, qq) => {
        const s = [...arr].sort((a, b) => a - b);
        return s[Math.min(s.length - 1, Math.max(0, Math.round(qq * (s.length - 1))))];
    };
    const ret = (b) => (b / startBal - 1) * 100;
    return {
        success: true,
        inputs: {winRate: wr, rrRatio: rr, riskPct: r, startBalance: startBal, trades: nTrades, runs: nRuns, compounding, ruinDrawdownPct: ruinDD},
        finalReturnPct: {
            median: Number(ret(pctl(finals, 0.5)).toFixed(1)),
            p10: Number(ret(pctl(finals, 0.1)).toFixed(1)),
            p90: Number(ret(pctl(finals, 0.9)).toFixed(1))
        },
        maxDrawdownPct: {median: Number(pctl(maxDDs, 0.5).toFixed(1)), p90: Number(pctl(maxDDs, 0.9).toFixed(1)), worst: Number(pctl(maxDDs, 1).toFixed(1))},
        longestLosingStreak: {median: pctl(streaks, 0.5), worst: pctl(streaks, 1)},
        profitableRunsPct: Number((profitable / nRuns * 100).toFixed(1)),
        ruinRunsPct: Number((ruined / nRuns * 100).toFixed(1)),
        note: `Monte Carlo: ${nRuns} runs × ${nTrades} trades. Ruin = peak-to-trough drawdown ≥ ${ruinDD}%. Theoretical — excludes commission, slippage and tax, so treat ruin % as a floor, not a ceiling.`,
    };
}

// ── Technical analysis (computed off klines) ─────────────────────────────────
// Pure indicator math over OHLCV arrays — no network, no chart, no CDP. These power
// getTechnicals (one symbol) and correlateSymbols (a candidate set), and the ATR figure
// feeds calcPositionSize's ATR-based stop. Every helper returns null when there aren't
// enough bars, so callers degrade gracefully instead of throwing. The TradingView side
// has its own indicators; this is the headless path for the exact Binance contract.
// (Distinct from compareSymbols above, which is a quick 24hr-stats leaderboard.)

/** Round a price-like value to a precision that suits its magnitude (big numbers → fewer dp). */
export function px(v) {
    if (v == null || !Number.isFinite(Number(v))) return null;
    const n = Number(v);
    const a = Math.abs(n);
    let dp = 8;
    if (a >= 1000) dp = 2;
    else if (a >= 1) dp = 4;
    else if (a >= 0.01) dp = 6;
    return Number(n.toFixed(dp));
}

/** Round to `dp` decimals, passing null/undefined through as null. */
function roundOrNull(v, dp) {
    if (v == null) return null;
    return Number(v.toFixed(dp));
}

/** `value` as a percentage of `price`, 2 dp (null when either is missing/zero). */
function pctOfPrice(value, price) {
    if (value == null || !price) return null;
    return Number((value / price * 100).toFixed(2));
}

/** Coerce an array-or-CSV-string input into an array (empty when neither). */
function splitList(value) {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string' && value) return value.split(',');
    return [];
}

/** Simple moving average of the last `period` values (null if too few). */
function sma(values, period) {
    if (!Array.isArray(values) || period < 1 || values.length < period) return null;
    let s = 0;
    for (let i = values.length - period; i < values.length; i++) s += values[i];
    return s / period;
}

/** EMA series aligned to `values` (entries are null until the SMA seed at index period-1). */
function emaSeries(values, period) {
    const out = new Array(values.length).fill(null);
    if (period < 1 || values.length < period) return out;
    const k = 2 / (period + 1);
    let seed = 0;
    for (let i = 0; i < period; i++) seed += values[i];
    let prev = seed / period;
    out[period - 1] = prev;
    for (let i = period; i < values.length; i++) {
        prev = values[i] * k + prev * (1 - k);
        out[i] = prev;
    }
    return out;
}

/** Last EMA value (null if too few bars). */
function ema(values, period) {
    const s = emaSeries(values, period);
    return s.at(-1);
}

/** Wilder RSI over `period` (null if too few bars). */
function rsi(closes, period = 14) {
    if (closes.length < period + 1) return null;
    let gain = 0, loss = 0;
    for (let i = 1; i <= period; i++) {
        const d = closes[i] - closes[i - 1];
        if (d >= 0) gain += d; else loss -= d;
    }
    let avgGain = gain / period, avgLoss = loss / period;
    for (let i = period + 1; i < closes.length; i++) {
        const d = closes[i] - closes[i - 1];
        avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
        avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
    }
    if (avgLoss === 0) return 100;
    return 100 - 100 / (1 + avgGain / avgLoss);
}

/** Wilder ATR over `period` from highs/lows/closes (null if too few bars). */
function atr(highs, lows, closes, period = 14) {
    const n = closes.length;
    if (n < period + 1) return null;
    const tr = [];
    for (let i = 1; i < n; i++) {
        const h = highs[i], l = lows[i], pc = closes[i - 1];
        tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    }
    let a = 0; // seed with SMA of the first `period` true ranges, then Wilder-smooth.
    for (let i = 0; i < period; i++) a += tr[i];
    a /= period;
    for (let i = period; i < tr.length; i++) a = (a * (period - 1) + tr[i]) / period;
    return a;
}

/** MACD line/signal/histogram (null if too few bars for the slow EMA + signal). */
function macd(closes, fast = 12, slow = 26, signalP = 9) {
    if (closes.length < slow + signalP) return null;
    const fastS = emaSeries(closes, fast);
    const slowS = emaSeries(closes, slow);
    const line = closes.map((_, i) => (fastS[i] != null && slowS[i] != null ? fastS[i] - slowS[i] : null));
    const defined = line.filter((v) => v != null);
    const signal = ema(defined, signalP);
    const macdLine = line.at(-1);
    if (macdLine == null || signal == null) return null;
    return {macd: macdLine, signal, hist: macdLine - signal};
}

/** Population standard deviation (null if fewer than 2 values). */
function stddev(values) {
    const n = values.length;
    if (n < 2) return null;
    const mean = values.reduce((s, v) => s + v, 0) / n;
    return Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / n);
}

/** Bollinger Bands (SMA middle ± mult·stddev) over `period` (null if too few bars). */
function bollinger(closes, period = 20, mult = 2) {
    if (closes.length < period) return null;
    const window = closes.slice(-period);
    const middle = window.reduce((s, v) => s + v, 0) / period;
    const sd = stddev(window);
    if (sd == null) return null;
    return {upper: middle + mult * sd, middle, lower: middle - mult * sd, width: middle ? (2 * mult * sd) / middle : 0};
}

/** Cumulative VWAP over the whole window (typical price × volume). */
function vwap(highs, lows, closes, volumes) {
    let pv = 0, vol = 0;
    for (let i = 0; i < closes.length; i++) {
        const v = volumes[i] || 0;
        pv += ((highs[i] + lows[i] + closes[i]) / 3) * v;
        vol += v;
    }
    return vol > 0 ? pv / vol : null;
}

/** Close-to-close simple returns. */
function simpleReturns(closes) {
    const out = [];
    for (let i = 1; i < closes.length; i++) out.push(closes[i] / closes[i - 1] - 1);
    return out;
}

/** Pearson correlation of two arrays (uses the common tail; null if degenerate). */
function pearson(a, b) {
    const n = Math.min(a.length, b.length);
    if (n < 2) return null;
    const xa = a.slice(-n), xb = b.slice(-n);
    const ma = xa.reduce((s, v) => s + v, 0) / n;
    const mb = xb.reduce((s, v) => s + v, 0) / n;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < n; i++) {
        const x = xa[i] - ma, y = xb[i] - mb;
        num += x * y;
        da += x * x;
        db += y * y;
    }
    const den = Math.sqrt(da * db);
    return den === 0 ? null : num / den;
}

/** Pull named numeric OHLCV arrays out of getKlines() candle objects (strings → numbers). */
function ohlcvArrays(candles) {
    const highs = [], lows = [], closes = [], volumes = [];
    for (const k of (candles || [])) {
        highs.push(Number(k.high));
        lows.push(Number(k.low));
        closes.push(Number(k.close));
        volumes.push(Number(k.volume));
    }
    return {highs, lows, closes, volumes};
}

/** Coarse trend tag from close vs a reference MA and the MACD histogram sign. */
function classifyTrend(lastClose, trendRef, m) {
    if (trendRef == null) return 'neutral';
    if (m) {
        if (lastClose > trendRef && m.hist > 0) return 'bullish';
        if (lastClose < trendRef && m.hist < 0) return 'bearish';
        return 'neutral';
    }
    if (lastClose > trendRef) return 'bullish';
    if (lastClose < trendRef) return 'bearish';
    return 'neutral';
}

/** Coarse momentum tag from the RSI value (neutral when RSI is unavailable). */
function classifyMomentum(rsiVal) {
    if (rsiVal == null) return 'neutral';
    if (rsiVal >= 70) return 'overbought';
    if (rsiVal <= 30) return 'oversold';
    return 'neutral';
}

/** {period: px(value)} for each period with enough bars (null when none have). */
function maPoints(closes, fn, periods) {
    const out = {};
    for (const p of periods) {
        const v = fn(closes, p);
        if (v != null) out[p] = px(v);
    }
    return Object.keys(out).length ? out : null;
}

/** +1 when a > b, -1 when a < b, else `eq` (0 for level factors, the prior position for crosses). */
function dirVs(a, b, eq = 0) {
    if (a > b) return 1;
    if (a < b) return -1;
    return eq;
}

/**
 * Compute technical indicators directly off Binance klines — RSI(14), ATR(14), MACD(12/26/9),
 * SMA(20/50/200), EMA(12/26/50), Bollinger(20,2) and window VWAP — plus a coarse trend/momentum
 * classification. Headless: pulls OHLCV for the exact contract and runs the math locally (the
 * TradingView side has its own indicators). The ATR figure also backs calcPositionSize's ATR
 * stop. Any indicator without enough bars comes back null rather than failing the whole call.
 */
export async function getTechnicals({market = 'futures', symbol, interval = '1h', limit = 300, _deps = {}} = {}) {
    if (!symbol) throw new Error('symbol is required');
    const lim = Math.max(30, Math.min(Number(limit) || 300, isFuturesLike(market) ? 1500 : 1000));
    const kl = await getKlines({market, symbol, interval, limit: lim, _deps});
    const {highs, lows, closes, volumes} = ohlcvArrays(kl.candles);
    const n = closes.length;
    if (n < 2) throw new Error(`not enough candles to analyze (${n})`);
    const lastClose = closes[n - 1];

    const atrVal = atr(highs, lows, closes, 14);
    const rsiVal = rsi(closes, 14);
    const macdVal = macd(closes);
    const bb = bollinger(closes, 20, 2);
    const vwapVal = vwap(highs, lows, closes, volumes);

    const trend = classifyTrend(lastClose, sma(closes, 50) ?? sma(closes, 20), macdVal);
    const momentum = classifyMomentum(rsiVal);

    return {
        success: true, market, symbol: String(symbol).toUpperCase(), interval, bars: n,
        lastClose: px(lastClose),
        rsi: roundOrNull(rsiVal, 2),
        atr: px(atrVal),
        atrPct: pctOfPrice(atrVal, lastClose),
        macd: macdVal ? {macd: px(macdVal.macd), signal: px(macdVal.signal), hist: px(macdVal.hist)} : null,
        sma: maPoints(closes, sma, [20, 50, 200]),
        ema: maPoints(closes, ema, [12, 26, 50]),
        bollinger: bb ? {upper: px(bb.upper), middle: px(bb.middle), lower: px(bb.lower), widthPct: Number((bb.width * 100).toFixed(2))} : null,
        vwap: px(vwapVal),
        classification: {trend, momentum},
    };
}

/**
 * Correlate and rank a candidate set of symbols on COMPUTED technicals: window return %, per-bar
 * volatility, a Sharpe-like ratio (mean/stddev of returns), ATR %, RSI and a trend tag — plus a
 * correlation matrix of their close-to-close returns and return/volatility rankings. Built for
 * portfolio-risk checks (don't stack correlated positions across accounts) and for ranking a
 * shortlist pulled from the 24hr screener. Fetches klines per symbol (one REST call each) — pass
 * a focused list, not the whole market. Capped at 10 symbols; per-symbol fetch errors are inline.
 * (Heavier, klines-based complement to compareSymbols, which only reads one 24hr ticker each.)
 */
export async function correlateSymbols({market = 'futures', symbols, interval = '1h', limit = 200, _deps = {}} = {}) {
    const list = splitList(symbols).map((s) => String(s).trim().toUpperCase()).filter(Boolean);
    if (list.length < 2) throw new Error('pass at least two symbols to correlate (array or CSV)');
    const capped = [...new Set(list)].slice(0, 10);
    const lim = Math.max(30, Math.min(Number(limit) || 200, isFuturesLike(market) ? 1500 : 1000));

    const per = await Promise.all(capped.map(async (sym) => {
        try {
            const kl = await getKlines({market, symbol: sym, interval, limit: lim, _deps});
            const {highs, lows, closes} = ohlcvArrays(kl.candles);
            const n = closes.length;
            if (n < 2) return {symbol: sym, error: 'not enough candles'};
            const rets = simpleReturns(closes);
            const sd = stddev(rets);
            const mean = rets.reduce((s, v) => s + v, 0) / rets.length;
            const atrVal = atr(highs, lows, closes, 14);
            const rsiVal = rsi(closes, 14);
            const lastClose = closes[n - 1];
            const trend = classifyTrend(lastClose, sma(closes, 50) ?? sma(closes, 20), macd(closes));
            return {
                symbol: sym, bars: n, lastClose: px(lastClose),
                returnPct: Number(((lastClose / closes[0] - 1) * 100).toFixed(2)),
                volatilityPct: sd == null ? null : Number((sd * 100).toFixed(3)),
                sharpe: sd ? Number((mean / sd).toFixed(3)) : null,
                atrPct: pctOfPrice(atrVal, lastClose),
                rsi: roundOrNull(rsiVal, 2),
                trend,
                _returns: rets,
            };
        } catch (err) {
            return {symbol: sym, error: err.message};
        }
    }));

    // Correlation matrix over the common tail length of the symbols that fetched cleanly.
    const ok = per.filter((p) => !p.error && p._returns);
    let correlation = null;
    if (ok.length >= 2) {
        const minLen = Math.min(...ok.map((p) => p._returns.length));
        const aligned = ok.map((p) => p._returns.slice(-minLen));
        const matrix = aligned.map((a, i) => aligned.map((b, j) => {
            if (i === j) return 1;
            const c = pearson(a, b);
            return c == null ? null : Number(c.toFixed(3));
        }));
        correlation = {symbols: ok.map((p) => p.symbol), bars: minLen, matrix};
    }

    const clean = per.map(({_returns, ...rest}) => rest);
    const ranked = clean.filter((p) => !p.error);
    return {
        success: true, market, interval, count: clean.length,
        ...(list.length > capped.length ? {note: `capped to first 10 of ${list.length} symbols`} : {}),
        symbols: clean,
        rankings: {
            byReturn: [...ranked].sort((a, b) => (b.returnPct ?? -Infinity) - (a.returnPct ?? -Infinity)).map((p) => p.symbol),
            byVolatility: [...ranked].sort((a, b) => (b.volatilityPct ?? -Infinity) - (a.volatilityPct ?? -Infinity)).map((p) => p.symbol),
        },
        correlation,
    };
}

// ── Indicator SERIES helpers (aligned arrays, for backtesting) ───────────────
// The helpers above return a single latest value; the backtester needs the WHOLE
// per-bar series (causal — entry index i only ever uses closes[0..i]). These mirror
// the point helpers' math but emit an array aligned to the input, null until warmed up.

/** SMA series (rolling); out[i] null until i >= period-1. */
function smaSeries(values, period) {
    const out = new Array(values.length).fill(null);
    if (period < 1) return out;
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
        sum += values[i];
        if (i >= period) sum -= values[i - period];
        if (i >= period - 1) out[i] = sum / period;
    }
    return out;
}

/** Wilder RSI series; out[i] null until i >= period. */
function rsiSeries(closes, period = 14) {
    const out = new Array(closes.length).fill(null);
    if (closes.length < period + 1) return out;
    let gain = 0, loss = 0;
    for (let i = 1; i <= period; i++) {
        const d = closes[i] - closes[i - 1];
        if (d >= 0) gain += d; else loss -= d;
    }
    let avgGain = gain / period, avgLoss = loss / period;
    out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    for (let i = period + 1; i < closes.length; i++) {
        const d = closes[i] - closes[i - 1];
        avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
        avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
        out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
    return out;
}

/** Wilder ATR series; out[i] null until i >= period (seeded with the mean of the first `period` TRs). */
function atrSeries(highs, lows, closes, period = 14) {
    const n = closes.length;
    const out = new Array(n).fill(null);
    if (n < period + 1) return out;
    const tr = new Array(n).fill(null);
    for (let i = 1; i < n; i++) {
        tr[i] = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
    }
    let a = 0;
    for (let i = 1; i <= period; i++) a += tr[i];
    a /= period;
    out[period] = a;
    for (let i = period + 1; i < n; i++) {
        a = (a * (period - 1) + tr[i]) / period;
        out[i] = a;
    }
    return out;
}

/** MACD series: {line, signal, hist} aligned to closes (entries null until warmed up). */
function macdSeries(closes, fast = 12, slow = 26, signalP = 9) {
    const fastS = emaSeries(closes, fast);
    const slowS = emaSeries(closes, slow);
    const line = closes.map((_, i) => (fastS[i] != null && slowS[i] != null ? fastS[i] - slowS[i] : null));
    const signal = new Array(closes.length).fill(null);
    const first = line.findIndex((v) => v != null);
    if (first >= 0) {
        const sig = emaSeries(line.slice(first).map((v) => v ?? 0), signalP);
        for (let i = 0; i < sig.length; i++) signal[first + i] = sig[i];
    }
    const hist = line.map((v, i) => (v != null && signal[i] != null ? v - signal[i] : null));
    return {line, signal, hist};
}

/** Bollinger series: {upper, middle, lower} aligned to closes. */
function bollingerSeries(closes, period = 20, mult = 2) {
    const middle = smaSeries(closes, period);
    const upper = new Array(closes.length).fill(null);
    const lower = new Array(closes.length).fill(null);
    for (let i = period - 1; i < closes.length; i++) {
        if (middle[i] == null) continue;
        const sd = stddev(closes.slice(i - period + 1, i + 1));
        if (sd == null) continue;
        upper[i] = middle[i] + mult * sd;
        lower[i] = middle[i] - mult * sd;
    }
    return {upper, middle, lower};
}

/** Supertrend final upper band: carry the previous band unless the new one tightens or price closed above it. */
function carryUpperBand(bu, prevUpper, prevClose) {
    return (bu < prevUpper || prevClose > prevUpper) ? bu : prevUpper;
}

/** Supertrend final lower band: carry the previous band unless the new one tightens or price closed below it. */
function carryLowerBand(bl, prevLower, prevClose) {
    return (bl > prevLower || prevClose < prevLower) ? bl : prevLower;
}

/** Next supertrend line value: flip between the bands when the close crosses the active one. */
function nextSupertrend(prevSt, prevUpper, close, up, lo) {
    if (prevSt === prevUpper) return close <= up ? up : lo;
    return close >= lo ? lo : up;
}

/** Supertrend direction series: dir[i] = +1 (price above the trend line) / -1 (below) / null until warmed up. */
function supertrendSeries(highs, lows, closes, period = 10, mult = 3) {
    const n = closes.length;
    const atrS = atrSeries(highs, lows, closes, period);
    const fUpper = new Array(n).fill(null), fLower = new Array(n).fill(null);
    const st = new Array(n).fill(null), dir = new Array(n).fill(null);
    const start = atrS.findIndex((v) => v != null);
    if (start < 0) return {dir};
    for (let i = start; i < n; i++) {
        const hl2 = (highs[i] + lows[i]) / 2;
        const bu = hl2 + mult * atrS[i], bl = hl2 - mult * atrS[i];
        if (i === start || fUpper[i - 1] == null) {
            fUpper[i] = bu;
            fLower[i] = bl;
            if (closes[i] <= bu) {
                st[i] = bu;
                dir[i] = -1;
            } else {
                st[i] = bl;
                dir[i] = 1;
            }
            continue;
        }
        fUpper[i] = carryUpperBand(bu, fUpper[i - 1], closes[i - 1]);
        fLower[i] = carryLowerBand(bl, fLower[i - 1], closes[i - 1]);
        st[i] = nextSupertrend(st[i - 1], fUpper[i - 1], closes[i], fUpper[i], fLower[i]);
        dir[i] = closes[i] > st[i] ? 1 : -1;
    }
    return {dir};
}

/** Pull opens/highs/lows/closes/volumes/openTimes (numbers) out of getKlines candle objects. */
function ohlcvFull(candles) {
    const opens = [], highs = [], lows = [], closes = [], volumes = [], openTimes = [];
    for (const k of (candles || [])) {
        opens.push(Number(k.open));
        highs.push(Number(k.high));
        lows.push(Number(k.low));
        closes.push(Number(k.close));
        volumes.push(Number(k.volume));
        openTimes.push(k.openTime);
    }
    return {opens, highs, lows, closes, volumes, openTimes};
}

// ── Backtesting engine (computed off klines, public — no chart, no orders) ───
// Headless strategy backtesting over the EXACT Binance contract's klines. Pure math:
// each strategy turns OHLCV into a per-bar desired position (+1 long / -1 short / 0 flat)
// decided at a bar's close and ENTERED AT THE NEXT BAR'S OPEN (no lookahead). The simulator
// marks the book close-to-close, charges commission+slippage on turnover, and reports
// institutional metrics (Sharpe, Calmar, max drawdown, profit factor, expectancy, vs buy&hold).
// Strategy set + metric ideas borrowed from atilaahmettaner/tradingview-mcp.

const INTERVAL_MS = {
    '1s': 1e3, '1m': 6e4, '3m': 18e4, '5m': 3e5, '15m': 9e5, '30m': 18e5,
    '1h': 36e5, '2h': 72e5, '4h': 144e5, '6h': 216e5, '8h': 288e5, '12h': 432e5,
    '1d': 864e5, '3d': 2592e5, '1w': 6048e5, '1M': 2592e6,
};

/** Log returns over consecutive positive closes. */
function logReturns(closes) {
    const rets = [];
    for (let i = 1; i < closes.length; i++) {
        if (closes[i - 1] > 0 && closes[i] > 0) rets.push(Math.log(closes[i] / closes[i - 1]));
    }
    return rets;
}

/** Annualize a per-bar volatility (stddev of returns) to % (null when inputs are missing). */
function annualizedVolPct(sd, bpy) {
    if (sd == null || !bpy) return null;
    return sd * Math.sqrt(bpy) * 100;
}

/** Parkinson (high/low range) annualized volatility % (null when not computable). */
function parkinsonVolPct(highs, lows, bpy) {
    if (!(highs.length > 1 && lows.length > 1 && bpy)) return null;
    let sum = 0, n = 0;
    for (let i = 0; i < highs.length; i++) {
        if (highs[i] > 0 && lows[i] > 0) {
            sum += Math.log(highs[i] / lows[i]) ** 2;
            n += 1;
        }
    }
    if (n <= 1) return null;
    return Math.sqrt((1 / (4 * n * Math.log(2))) * sum) * Math.sqrt(bpy) * 100;
}

/** One interval's realized-vol surface entry, computed off its klines. */
function volatilityRow(candles, iv) {
    const {highs, lows, closes} = ohlcvFull(candles);
    const rets = logReturns(closes);
    const up = rets.filter((x) => x > 0);
    const down = rets.filter((x) => x < 0).map((x) => Math.abs(x));
    const bpy = INTERVAL_MS[iv] ? (365.25 * 864e5) / INTERVAL_MS[iv] : null;
    const rv = annualizedVolPct(stddev(rets), bpy);
    const upRv = annualizedVolPct(stddev(up), bpy);
    const downRv = annualizedVolPct(stddev(down), bpy);
    const park = parkinsonVolPct(highs, lows, bpy);
    const atr14 = atr(highs, lows, closes, 14);
    const last = closes.length ? closes.at(-1) : null;
    const ratio = (downRv != null && upRv && upRv > 0) ? downRv / upRv : null;
    return {
        interval: iv,
        bars: closes.length,
        realizedVolPct: roundOrNull(rv, 2),
        downsideVolPct: roundOrNull(downRv, 2),
        upsideVolPct: roundOrNull(upRv, 2),
        downsideUpsideRatio: roundOrNull(ratio, 3),
        parkinsonVolPct: roundOrNull(park, 2),
        atrPct: pctOfPrice(atr14, last),
    };
}

/** Tag the volatility regime from the anchor interval's realized vol %. */
function classifyVolRegime(rv) {
    if (rv == null) return 'insufficient_data';
    if (rv >= 90) return 'extreme';
    if (rv >= 60) return 'high';
    if (rv >= 30) return 'moderate';
    return 'low';
}

/** Tag the downside/upside skew from the vol ratio. */
function classifySkew(skew) {
    if (skew == null) return 'unknown';
    if (skew >= 1.2) return 'left_tail_heavy';
    if (skew <= 0.85) return 'right_tail_heavy';
    return 'balanced';
}

/** Multi-timeframe realized-volatility + downside/upside skew proxy from klines. This is not
 *  options-implied vol, but provides a real-time tradable volatility regime read directly from
 *  Binance market data. */
export async function getVolatilityRegime({market = 'futures', symbol, intervals = ['5m', '15m', '1h', '4h'], limit = 300, _deps = {}} = {}) {
    if (!symbol) throw new Error('symbol is required');
    const lim = Math.max(30, Math.min(Math.trunc(requireFinite(limit, 'limit')), 1500));
    const list = Array.isArray(intervals)
        ? intervals
        : String(intervals || '').split(',').map((x) => x.trim()).filter(Boolean);
    const ivs = [...new Set((list.length ? list : ['5m', '15m', '1h', '4h']).map(String))];
    for (const iv of ivs) if (!KLINE_INTERVALS.includes(iv)) throw new Error(`interval must be one of: ${KLINE_INTERVALS.join(', ')}`);

    const surface = [];
    for (const iv of ivs) {
        const r = await getKlines({market, symbol, interval: iv, limit: lim, _deps});
        surface.push(volatilityRow(r.candles || [], iv));
    }

    const sorted = [...surface].sort((a, b) => (INTERVAL_MS[a.interval] || 0) - (INTERVAL_MS[b.interval] || 0));
    const first = sorted.find((x) => x.realizedVolPct != null);
    const last = [...sorted].reverse().find((x) => x.realizedVolPct != null);
    const slope = first && last ? Number((last.realizedVolPct - first.realizedVolPct).toFixed(2)) : null;
    const anchor = surface.find((x) => x.interval === '1h') || surface[0];
    const regime = classifyVolRegime(anchor?.realizedVolPct);
    const skewTag = classifySkew(anchor?.downsideUpsideRatio);

    return {
        success: true, market, symbol: String(symbol).toUpperCase(),
        intervals: ivs,
        limit: lim,
        regime,
        skewTag,
        termStructureSlope: slope,
        surface,
        note: 'Realized-volatility model from trades/klines (not options-implied volatility).',
    };
}

// Each strategy: (bundle) => desired[]  where desired[i] ∈ {1,-1,0} is the position to hold
// going INTO bar i+1, decided from indicators known at the close of bar i. `longOnly` strategies
// never emit shorts. Indicator series are precomputed once and shared (cheap compareStrategies).
const STRATEGIES = {
    rsi: {
        name: 'RSI mean-reversion', desc: 'long < 30, short > 70, exit back through 50',
        fn: ({closes, ind}) => {
            const r = ind.rsi14;
            const out = new Array(closes.length).fill(0);
            let cur = 0;
            for (let i = 0; i < closes.length; i++) {
                if (r[i] == null) {
                    out[i] = cur;
                    continue;
                }
                if (r[i] < 30) cur = 1; else if (r[i] > 70) cur = -1;
                else if (cur === 1 && r[i] >= 50) cur = 0; else if (cur === -1 && r[i] <= 50) cur = 0;
                out[i] = cur;
            }
            return out;
        },
    },
    bollinger: {
        name: 'Bollinger mean-reversion', desc: 'long below lower band, short above upper, exit at middle',
        fn: ({closes, ind}) => {
            const {upper, middle, lower} = ind.boll;
            const out = new Array(closes.length).fill(0);
            let cur = 0;
            for (let i = 0; i < closes.length; i++) {
                if (middle[i] == null) {
                    out[i] = cur;
                    continue;
                }
                if (closes[i] < lower[i]) cur = 1; else if (closes[i] > upper[i]) cur = -1;
                else if (cur === 1 && closes[i] >= middle[i]) cur = 0; else if (cur === -1 && closes[i] <= middle[i]) cur = 0;
                out[i] = cur;
            }
            return out;
        },
    },
    macd: {
        name: 'MACD cross', desc: 'long while MACD line > signal, short while below',
        fn: ({closes, ind}) => {
            const {line, signal} = ind.macd;
            const out = new Array(closes.length).fill(0);
            let cur = 0;
            for (let i = 0; i < closes.length; i++) {
                if (line[i] == null || signal[i] == null) {
                    out[i] = cur;
                    continue;
                }
                cur = dirVs(line[i], signal[i], cur);
                out[i] = cur;
            }
            return out;
        },
    },
    ema_cross: {
        name: 'EMA cross 20/50', desc: 'long while EMA20 > EMA50 (golden), short while below (death)',
        fn: ({closes, ind}) => {
            const a = ind.ema20, b = ind.ema50;
            const out = new Array(closes.length).fill(0);
            let cur = 0;
            for (let i = 0; i < closes.length; i++) {
                if (a[i] == null || b[i] == null) {
                    out[i] = cur;
                    continue;
                }
                cur = dirVs(a[i], b[i], cur);
                out[i] = cur;
            }
            return out;
        },
    },
    supertrend: {
        name: 'Supertrend (ATR)', desc: 'follow the ATR(10,3) trend direction',
        fn: ({ind}) => ind.superT.dir.map((d) => (d == null ? 0 : d)),
    },
    donchian: {
        name: 'Donchian breakout', desc: 'Turtle-style: long on 20-bar high break, short on 20-bar low break',
        fn: ({highs, lows, closes}) => {
            const p = 20;
            const out = new Array(closes.length).fill(0);
            let cur = 0;
            for (let i = 0; i < closes.length; i++) {
                if (i < p) {
                    out[i] = cur;
                    continue;
                }
                let hh = -Infinity, ll = Infinity;
                for (let j = i - p; j < i; j++) {
                    if (highs[j] > hh) hh = highs[j];
                    if (lows[j] < ll) ll = lows[j];
                }
                if (closes[i] > hh) cur = 1; else if (closes[i] < ll) cur = -1;
                out[i] = cur;
            }
            return out;
        },
    },
    rsi_pullback: {
        name: 'RSI pullback (long-only)', desc: 'buy dips (RSI<40) while price > SMA200; exit on RSI>60 or trend loss',
        longOnly: true,
        fn: ({closes, ind}) => {
            const r = ind.rsi14, s = ind.sma200;
            const out = new Array(closes.length).fill(0);
            let cur = 0;
            for (let i = 0; i < closes.length; i++) {
                if (r[i] == null || s[i] == null) {
                    out[i] = cur;
                    continue;
                }
                const up = closes[i] > s[i];
                if (cur === 0 && up && r[i] < 40) cur = 1; else if (cur === 1 && (r[i] > 60 || !up)) cur = 0;
                out[i] = cur;
            }
            return out;
        },
    },
    keltner: {
        name: 'Keltner breakout', desc: 'EMA20 ± 1.5·ATR(14) channel breakout',
        fn: ({closes, ind}) => {
            const e = ind.ema20, a = ind.atr14, m = 1.5;
            const out = new Array(closes.length).fill(0);
            let cur = 0;
            for (let i = 0; i < closes.length; i++) {
                if (e[i] == null || a[i] == null) {
                    out[i] = cur;
                    continue;
                }
                if (closes[i] > e[i] + m * a[i]) cur = 1; else if (closes[i] < e[i] - m * a[i]) cur = -1;
                out[i] = cur;
            }
            return out;
        },
    },
    triple_ema: {
        name: 'Triple EMA + SMA200 filter', desc: 'EMA20/50 cross gated by the SMA200 trend filter',
        fn: ({closes, ind}) => {
            const a = ind.ema20, b = ind.ema50, s = ind.sma200;
            const out = new Array(closes.length).fill(0);
            let cur = 0;
            for (let i = 0; i < closes.length; i++) {
                if (a[i] == null || b[i] == null || s[i] == null) {
                    out[i] = cur;
                    continue;
                }
                if (a[i] > b[i] && closes[i] > s[i]) cur = 1; else if (a[i] < b[i] && closes[i] < s[i]) cur = -1; else cur = 0;
                out[i] = cur;
            }
            return out;
        },
    },
};

/** Public list of backtestable strategy keys (drives the MCP enum + CLI help). */
export const STRATEGY_KEYS = Object.keys(STRATEGIES);

/** Precompute every indicator series the strategies might read — once per symbol. */
function indicatorBundle(highs, lows, closes) {
    return {
        rsi14: rsiSeries(closes, 14),
        ema20: emaSeries(closes, 20),
        ema50: emaSeries(closes, 50),
        sma200: smaSeries(closes, 200),
        macd: macdSeries(closes),
        boll: bollingerSeries(closes, 20, 2),
        atr14: atrSeries(highs, lows, closes, 14),
        superT: supertrendSeries(highs, lows, closes, 10, 3),
    };
}

/** Sharpe + annualized return from the per-bar return series (nulls when not computable). */
function riskAdjustedStats(barRets, equity, interval) {
    const mean = barRets.length ? barRets.reduce((s, v) => s + v, 0) / barRets.length : 0;
    const sd = stddev(barRets);
    const bpy = INTERVAL_MS[interval] ? (365.25 * 864e5) / INTERVAL_MS[interval] : null;
    const sharpe = sd && bpy ? (mean / sd) * Math.sqrt(bpy) : null;
    const years = bpy ? barRets.length / bpy : null;
    const annReturn = years && years > 0 && equity > 0 ? Math.pow(equity, 1 / years) - 1 : null;
    return {sharpe, annReturn};
}

/** Most extreme trade by returnPct under `better` (strictly better wins; null when no trades). */
function extremeTrade(trades, better) {
    let m = null;
    for (const t of trades) {
        if (!m || better(t.returnPct, m.returnPct)) m = t;
    }
    return m;
}

/** Win/loss/risk metrics from a realized per-bar return series + the trade list (pure). */
function computeMetrics({barRets, equity, maxDD, trades, closes, interval}) {
    const totalReturnPct = (equity - 1) * 100;
    const wins = trades.filter((t) => t.returnPct > 0);
    const losses = trades.filter((t) => t.returnPct < 0);
    const grossWin = wins.reduce((s, t) => s + t.returnPct, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.returnPct, 0));
    const {sharpe, annReturn} = riskAdjustedStats(barRets, equity, interval);
    const calmar = annReturn != null && maxDD < 0 ? annReturn / Math.abs(maxDD) : null;
    const buyHold = closes.length > 1 ? (closes.at(-1) / closes[0] - 1) * 100 : 0;
    const best = extremeTrade(trades, (a, b) => a > b);
    const worst = extremeTrade(trades, (a, b) => a < b);
    const pf = grossLoss > 0 ? grossWin / grossLoss : null;
    const annReturnPct = annReturn == null ? null : annReturn * 100;
    return {
        totalReturnPct: Number(totalReturnPct.toFixed(2)),
        buyHoldReturnPct: Number(buyHold.toFixed(2)),
        vsBuyHoldPct: Number((totalReturnPct - buyHold).toFixed(2)),
        annualizedReturnPct: roundOrNull(annReturnPct, 2),
        tradeCount: trades.length,
        winRatePct: trades.length ? Number(((wins.length / trades.length) * 100).toFixed(1)) : 0,
        profitFactor: roundOrNull(pf, 2),
        expectancyPct: trades.length ? Number((trades.reduce((s, t) => s + t.returnPct, 0) / trades.length).toFixed(3)) : 0,
        avgWinPct: wins.length ? Number((grossWin / wins.length).toFixed(3)) : null,
        avgLossPct: losses.length ? Number((-grossLoss / losses.length).toFixed(3)) : null,
        maxDrawdownPct: Number((maxDD * 100).toFixed(2)),
        sharpe: roundOrNull(sharpe, 2),
        calmar: roundOrNull(calmar, 2),
        bestTradePct: best ? best.returnPct : null,
        worstTradePct: worst ? worst.returnPct : null,
    };
}

/** One trade record for a position run over bars [start..end] (pure formatting + net return). */
function tradeRecord({side, start, end, n, opens, closes, openTimes, cost}) {
    const exitIdx = Math.min(end + 1, n - 1);
    const entryPrice = opens[start];
    const exitPrice = end + 1 < n ? opens[end + 1] : closes[end];
    const net = side * (exitPrice / entryPrice - 1) - 2 * cost;
    return {
        side: side > 0 ? 'LONG' : 'SHORT',
        entryTime: openTimes[start], exitTime: openTimes[exitIdx],
        entryPrice: px(entryPrice), exitPrice: px(exitPrice),
        bars: exitIdx - start,
        returnPct: Number((net * 100).toFixed(3)),
    };
}

/** Trades = maximal runs of a constant nonzero position; enter at the run's first open,
 *  exit at the open of the bar after it ends (or the final close if it runs to the edge). */
function extractTrades({pos, opens, closes, openTimes, cost}) {
    const n = closes.length;
    const trades = [];
    let i = 1;
    while (i < n) {
        if (pos[i] !== 0) {
            const side = pos[i], start = i;
            while (i + 1 < n && pos[i + 1] === side) i++;
            trades.push(tradeRecord({side, start, end: i, n, opens, closes, openTimes, cost}));
        }
        i++;
    }
    return trades;
}

/** Simulate a desired-position series over OHLCV: enter at next bar's open, mark close-to-close,
 *  charge (commission+slippage) on each unit of turnover. Returns metrics + trades + equity curve. */
function runBacktest(data, desired, {commission = 0.0004, slippage = 0.0005, interval = '1h'} = {}) {
    const {opens, closes, openTimes} = data;
    const n = closes.length;
    const cost = (Number(commission) || 0) + (Number(slippage) || 0);

    // pos[i] = position held DURING bar i (decided at the close of bar i-1).
    const pos = new Array(n).fill(0);
    for (let i = 1; i < n; i++) pos[i] = desired[i - 1] ?? 0;

    let equity = 1, peak = 1, maxDD = 0;
    const barRets = [];
    const curve = [{time: openTimes[0], equity: 1}];
    for (let i = 1; i < n; i++) {
        let r = pos[i] * (closes[i] / closes[i - 1] - 1);
        const turnover = Math.abs(pos[i] - pos[i - 1]);
        if (turnover) r -= turnover * cost;
        equity *= 1 + r;
        barRets.push(r);
        peak = Math.max(peak, equity);
        const dd = equity / peak - 1;
        maxDD = Math.min(maxDD, dd);
        curve.push({time: openTimes[i], equity: Number(equity.toFixed(6))});
    }

    const trades = extractTrades({pos, opens, closes, openTimes, cost});

    return {metrics: computeMetrics({barRets, equity, maxDD, trades, closes, interval}), trades, curve, barRets, pos};
}

function resolveStrategy(strategy) {
    const key = String(strategy || '').toLowerCase();
    if (!STRATEGIES[key]) throw new Error(`unknown strategy "${strategy}". Available: ${STRATEGY_KEYS.join(', ')}`);
    return {key, strat: STRATEGIES[key]};
}

function desiredFor(strat, bundle, allowShort) {
    let desired = strat.fn(bundle);
    if (strat.longOnly || !allowShort) desired = desired.map((d) => Math.max(0, d ?? 0));
    return desired;
}

/**
 * Backtest one strategy over a symbol's klines and return institutional metrics: total &
 * annualized return, Sharpe, Calmar, max drawdown, win rate, profit factor, expectancy,
 * avg win/loss, best/worst trade — plus a buy-&-hold benchmark. Enters at the next bar's open
 * (no lookahead) and charges commission+slippage on turnover. `includeTrades`/`includeEquityCurve`
 * attach the full trade log / equity path (off by default — they can be large). Strategies:
 * rsi, bollinger, macd, ema_cross, supertrend, donchian, rsi_pullback, keltner, triple_ema.
 */
export async function backtestStrategy({
                                           market = 'futures',
                                           symbol,
                                           interval = '1h',
                                           strategy = 'ema_cross',
                                           limit = 500,
                                           commission = 0.0004,
                                           slippage = 0.0005,
                                           allowShort = true,
                                           includeTrades = false,
                                           includeEquityCurve = false,
                                           _deps = {}
                                       } = {}) {
    if (!symbol) throw new Error('symbol is required');
    const {key, strat} = resolveStrategy(strategy);
    const lim = Math.max(60, Math.min(Number(limit) || 500, isFuturesLike(market) ? 1500 : 1000));
    const kl = await getKlines({market, symbol, interval, limit: lim, _deps});
    const data = ohlcvFull(kl.candles);
    const n = data.closes.length;
    if (n < 60) throw new Error(`not enough candles to backtest (${n}); need at least 60`);
    const bundle = {...data, ind: indicatorBundle(data.highs, data.lows, data.closes)};
    const desired = desiredFor(strat, bundle, allowShort);
    const {metrics, trades, curve} = runBacktest(data, desired, {commission, slippage, interval});
    return {
        success: true, market, symbol: String(symbol).toUpperCase(), interval,
        strategy: key, strategyName: strat.name, bars: n,
        longOnly: !!strat.longOnly || !allowShort,
        commission: Number(commission), slippage: Number(slippage),
        ...metrics,
        ...(includeTrades ? {trades} : {}),
        ...(includeEquityCurve ? {equityCurve: curve} : {}),
    };
}

/**
 * Run ALL strategies on one symbol (one klines fetch, indicators computed once) and return a
 * ranked table sorted by `sortBy` (totalReturnPct default / sharpe / calmar / winRatePct /
 * profitFactor / maxDrawdownPct). Quick way to see which approach fits the current regime.
 */
export async function compareStrategies({
                                            market = 'futures',
                                            symbol,
                                            interval = '1h',
                                            limit = 500,
                                            commission = 0.0004,
                                            slippage = 0.0005,
                                            allowShort = true,
                                            sortBy = 'totalReturnPct',
                                            _deps = {}
                                        } = {}) {
    if (!symbol) throw new Error('symbol is required');
    const lim = Math.max(60, Math.min(Number(limit) || 500, isFuturesLike(market) ? 1500 : 1000));
    const kl = await getKlines({market, symbol, interval, limit: lim, _deps});
    const data = ohlcvFull(kl.candles);
    const n = data.closes.length;
    if (n < 60) throw new Error(`not enough candles to backtest (${n}); need at least 60`);
    const bundle = {...data, ind: indicatorBundle(data.highs, data.lows, data.closes)};
    const valid = ['totalReturnPct', 'annualizedReturnPct', 'sharpe', 'calmar', 'winRatePct', 'profitFactor', 'maxDrawdownPct', 'expectancyPct'];
    const key = valid.includes(sortBy) ? sortBy : 'totalReturnPct';

    const results = STRATEGY_KEYS.map((sk) => {
        const strat = STRATEGIES[sk];
        const desired = desiredFor(strat, bundle, allowShort);
        const {metrics} = runBacktest(data, desired, {commission, slippage, interval});
        return {strategy: sk, strategyName: strat.name, ...metrics};
    });
    // maxDrawdownPct is negative → "best" is closest to 0 (descending already does that); all others descending.
    const ranked = [...results].sort((a, b) => (b[key] ?? -Infinity) - (a[key] ?? -Infinity));
    return {
        success: true, market, symbol: String(symbol).toUpperCase(), interval, bars: n, sortBy: key,
        buyHoldReturnPct: results[0]?.buyHoldReturnPct ?? null,
        best: ranked[0]?.strategy ?? null,
        ranked,
    };
}

/**
 * Out-of-sample consistency check (train/test split). Backtests the strategy over the full series
 * once, then scores the in-sample (first `trainRatio`) and out-of-sample (the rest) windows
 * separately and emits an overfitting verdict from the OOS-vs-IS annualized-return ratio:
 * ROBUST / MODERATE / WEAK / OVERFITTED / UNPROFITABLE. NOTE: parameters are fixed (no grid
 * optimization), so this measures temporal robustness, not parameter-search overfitting.
 */
export async function walkForwardBacktest({
                                              market = 'futures',
                                              symbol,
                                              interval = '1h',
                                              strategy = 'ema_cross',
                                              limit = 1000,
                                              trainRatio = 0.7,
                                              commission = 0.0004,
                                              slippage = 0.0005,
                                              allowShort = true,
                                              _deps = {}
                                          } = {}) {
    if (!symbol) throw new Error('symbol is required');
    const {key, strat} = resolveStrategy(strategy);
    const ratio = Number(trainRatio);
    if (!(ratio > 0.1 && ratio < 0.95)) throw new Error('trainRatio must be between 0.1 and 0.95');
    const lim = Math.max(120, Math.min(Number(limit) || 1000, isFuturesLike(market) ? 1500 : 1000));
    const kl = await getKlines({market, symbol, interval, limit: lim, _deps});
    const data = ohlcvFull(kl.candles);
    const n = data.closes.length;
    if (n < 120) throw new Error(`not enough candles for walk-forward (${n}); need at least 120`);
    const bundle = {...data, ind: indicatorBundle(data.highs, data.lows, data.closes)};
    const desired = desiredFor(strat, bundle, allowShort);
    const {barRets, trades} = runBacktest(data, desired, {commission, slippage, interval});

    const splitBar = Math.floor(n * ratio);          // index into closes/openTimes
    const splitTime = data.openTimes[splitBar];
    // barRets[k] is the return realized on bar k+1, so it aligns to closes index k+1.
    const window = (lo, hi) => {
        const rets = barRets.slice(Math.max(0, lo - 1), hi - 1);
        const eq = rets.reduce((e, r) => e * (1 + r), 1);
        let peak = 1, mdd = 0;
        let cur = 1;
        for (const r of rets) {
            cur *= 1 + r;
            if (cur > peak) peak = cur;
            const dd = cur / peak - 1;
            if (dd < mdd) mdd = dd;
        }
        const tr = trades.filter((t) => t.entryTime >= data.openTimes[lo] && t.entryTime < (hi < n ? data.openTimes[hi] : Infinity));
        return computeMetrics({barRets: rets, equity: eq, maxDD: mdd, trades: tr, closes: data.closes.slice(lo, hi), interval});
    };
    const train = window(1, splitBar);
    const test = window(splitBar, n);

    const tr = train.annualizedReturnPct, te = test.annualizedReturnPct;
    let verdict;
    if (tr == null || te == null) verdict = 'INSUFFICIENT_DATA';
    else if (te <= 0 && tr > 0) verdict = 'OVERFITTED';
    else if (te <= 0) verdict = 'UNPROFITABLE';
    else if (tr <= 0) verdict = 'INCONCLUSIVE';            // test profitable, train wasn't
    else if (te >= 0.5 * tr) verdict = 'ROBUST';
    else if (te >= 0.2 * tr) verdict = 'MODERATE';
    else verdict = 'WEAK';

    return {
        success: true, market, symbol: String(symbol).toUpperCase(), interval,
        strategy: key, strategyName: strat.name, bars: n, trainRatio: ratio,
        splitTime, verdict,
        train, test,
        note: 'Fixed-parameter train/test consistency check — measures temporal robustness, not parameter-search overfitting.',
    };
}

// ── Multi-timeframe alignment ────────────────────────────────────────────────

/**
 * Fan getTechnicals across several timeframes and report trend/momentum confluence — do the
 * higher and lower timeframes agree? Returns each timeframe's trend/momentum/RSI plus a
 * confluence summary (bullish/bearish/neutral counts, a -1..1 score, a bias tag and an
 * `aligned` flag when every timeframe points the same way). Per-timeframe errors are inline.
 */
export async function getMultiTimeframe({market = 'futures', symbol, intervals, _deps = {}} = {}) {
    if (!symbol) throw new Error('symbol is required');
    const fromInput = splitList(intervals);
    const ivs = (fromInput.length ? fromInput : ['15m', '1h', '4h', '1d'])
        .map((s) => String(s).trim()).filter(Boolean);
    const per = await Promise.all(ivs.map(async (iv) => {
        try {
            const t = await getTechnicals({market, symbol, interval: iv, _deps});
            return {interval: iv, trend: t.classification.trend, momentum: t.classification.momentum, rsi: t.rsi, lastClose: t.lastClose};
        } catch (err) {
            return {interval: iv, error: err.message};
        }
    }));
    const ok = per.filter((p) => !p.error);
    const bull = ok.filter((p) => p.trend === 'bullish').length;
    const bear = ok.filter((p) => p.trend === 'bearish').length;
    const score = ok.length ? Number(((bull - bear) / ok.length).toFixed(2)) : 0;
    let bias = 'mixed';
    if (score >= 0.34) bias = 'bullish';
    else if (score <= -0.34) bias = 'bearish';
    return {
        success: true, market, symbol: String(symbol).toUpperCase(),
        timeframes: per,
        confluence: {
            bullish: bull,
            bearish: bear,
            neutral: ok.length - bull - bear,
            score,
            bias,
            aligned: ok.length > 1 && (bull === ok.length || bear === ok.length)
        },
    };
}

// ── Signal scanner ───────────────────────────────────────────────────────────

const SCAN_SIGNALS = {
    oversold: (t) => t.rsi != null && t.rsi <= 30,
    overbought: (t) => t.rsi != null && t.rsi >= 70,
    bullish: (t) => t.classification.trend === 'bullish',
    bearish: (t) => t.classification.trend === 'bearish',
    breakout: (t) => t.bollinger && t.lastClose != null && t.lastClose > t.bollinger.upper,
    breakdown: (t) => t.bollinger && t.lastClose != null && t.lastClose < t.bollinger.lower,
};

/** Public list of scanner signals (drives the MCP enum + CLI help). */
export const SCAN_SIGNAL_KEYS = Object.keys(SCAN_SIGNALS);

/**
 * Scan a candidate list of symbols for a technical signal — oversold / overbought (RSI≤30 / ≥70),
 * bullish / bearish (trend classification), or breakout / breakdown (close beyond a Bollinger band).
 * One klines call per symbol (capped at 20 — pass a focused list). Returns the matching symbols
 * with their RSI/trend/lastClose, plus the scanned count and any per-symbol errors.
 */
export async function scanSignals({market = 'futures', symbols, signal = 'oversold', interval = '1h', _deps = {}} = {}) {
    const sig = String(signal || '').toLowerCase();
    if (!SCAN_SIGNALS[sig]) throw new Error(`unknown signal "${signal}". Available: ${SCAN_SIGNAL_KEYS.join(', ')}`);
    const list = splitList(symbols).map((s) => String(s).trim().toUpperCase()).filter(Boolean);
    if (!list.length) throw new Error('pass at least one symbol to scan (array or CSV)');
    const capped = [...new Set(list)].slice(0, 20);
    const test = SCAN_SIGNALS[sig];

    const per = await Promise.all(capped.map(async (sym) => {
        try {
            const t = await getTechnicals({market, symbol: sym, interval, _deps});
            return {symbol: sym, match: !!test(t), rsi: t.rsi, trend: t.classification.trend, momentum: t.classification.momentum, lastClose: t.lastClose};
        } catch (err) {
            return {symbol: sym, error: err.message};
        }
    }));
    const matches = per.filter((p) => !p.error && p.match).map(({match, ...rest}) => rest);
    const errors = per.filter((p) => p.error).map(({symbol, error}) => ({symbol, error}));
    return {
        success: true, market, interval, signal: sig,
        ...(list.length > capped.length ? {note: `capped to first 20 of ${list.length} symbols`} : {}),
        scanned: capped.length, matchCount: matches.length, matches,
        ...(errors.length ? {errors} : {}),
    };
}

// ── Candlestick pattern detection ────────────────────────────────────────────
// Pure single-/multi-bar pattern recognition off klines. Each detector reads only the bar at
// index i and a few before it (causal). Tolerances are fractions of the bar's range so they
// scale across price magnitudes. Returns the bias (bullish/bearish/neutral) of each pattern.

/** Single-bar patterns: doji, marubozu, spinning top, hammer and shooting-star families. */
function singleBarPatterns({body, range, upper, lower, bull, downCtx, upCtx}) {
    const out = [];
    const small = body <= 0.3 * range;
    const marubozuBias = bull ? 'bullish' : 'bearish';

    if (body <= 0.1 * range) out.push({pattern: 'doji', bias: 'neutral'});
    if (upper + lower <= 0.06 * range) out.push({pattern: `${marubozuBias}_marubozu`, bias: marubozuBias});
    if (small && upper > body && lower > body) out.push({pattern: 'spinning_top', bias: 'neutral'});

    // Hammer family (long lower wick, small upper)
    if (lower >= 2 * body && upper <= body && body > 0) {
        out.push(downCtx ? {pattern: 'hammer', bias: 'bullish'} : {pattern: 'hanging_man', bias: 'bearish'});
    }
    // Shooting-star family (long upper wick, small lower)
    if (upper >= 2 * body && lower <= body && body > 0) {
        out.push(upCtx ? {pattern: 'shooting_star', bias: 'bearish'} : {pattern: 'inverted_hammer', bias: 'bullish'});
    }
    return out;
}

/** Two-bar body patterns at bar `i`: engulfing and harami. */
function twoBarBodyPatterns(o, c, i, {body, bull, bear}) {
    const out = [];
    const pb = Math.abs(c[i - 1] - o[i - 1]);
    const pBull = c[i - 1] > o[i - 1], pBear = c[i - 1] < o[i - 1];
    // Engulfing
    if (pBear && bull && c[i] >= o[i - 1] && o[i] <= c[i - 1] && body > pb) out.push({pattern: 'bullish_engulfing', bias: 'bullish'});
    if (pBull && bear && o[i] >= c[i - 1] && c[i] <= o[i - 1] && body > pb) out.push({pattern: 'bearish_engulfing', bias: 'bearish'});
    // Harami (small body inside the prior big body)
    if (pBear && bull && body < pb && Math.max(o[i], c[i]) <= o[i - 1] && Math.min(o[i], c[i]) >= c[i - 1]) out.push({
        pattern: 'bullish_harami',
        bias: 'bullish'
    });
    if (pBull && bear && body < pb && Math.max(o[i], c[i]) <= c[i - 1] && Math.min(o[i], c[i]) >= o[i - 1]) out.push({
        pattern: 'bearish_harami',
        bias: 'bearish'
    });
    return out;
}

/** Two-bar reversal patterns at bar `i`: piercing line / dark cloud cover and tweezers. */
function twoBarReversalPatterns(o, h, l, c, i, {bull, bear}) {
    const out = [];
    const pBull = c[i - 1] > o[i - 1], pBear = c[i - 1] < o[i - 1];
    // Piercing line / dark cloud cover
    const pMid = (o[i - 1] + c[i - 1]) / 2;
    if (pBear && bull && o[i] < c[i - 1] && c[i] > pMid && c[i] < o[i - 1]) out.push({pattern: 'piercing_line', bias: 'bullish'});
    if (pBull && bear && o[i] > c[i - 1] && c[i] < pMid && c[i] > o[i - 1]) out.push({pattern: 'dark_cloud_cover', bias: 'bearish'});
    // Tweezers (near-equal extremes, color flip)
    const eps = 0.001 * c[i];
    if (Math.abs(l[i] - l[i - 1]) <= eps && pBear && bull) out.push({pattern: 'tweezer_bottom', bias: 'bullish'});
    if (Math.abs(h[i] - h[i - 1]) <= eps && pBull && bear) out.push({pattern: 'tweezer_top', bias: 'bearish'});
    return out;
}

/** Three-bar patterns at bar `i`: morning/evening star and three soldiers/crows. */
function threeBarPatterns(o, c, i, {bull, bear}) {
    const out = [];
    const b1Bull = c[i - 2] > o[i - 2], b1Bear = c[i - 2] < o[i - 2];
    const b2Body = Math.abs(c[i - 1] - o[i - 1]);
    const b1Body = Math.abs(c[i - 2] - o[i - 2]);
    const b1Mid = (o[i - 2] + c[i - 2]) / 2;
    // Morning / evening star (big, small, big-opposite closing past the midpoint)
    if (b1Bear && b2Body < b1Body * 0.5 && bull && c[i] > b1Mid) out.push({pattern: 'morning_star', bias: 'bullish'});
    if (b1Bull && b2Body < b1Body * 0.5 && bear && c[i] < b1Mid) out.push({pattern: 'evening_star', bias: 'bearish'});
    // Three white soldiers / black crows
    const allBull = bull && pBullAt(o, c, i - 1) && pBullAt(o, c, i - 2);
    const allBear = bear && pBearAt(o, c, i - 1) && pBearAt(o, c, i - 2);
    if (allBull && c[i] > c[i - 1] && c[i - 1] > c[i - 2]) out.push({pattern: 'three_white_soldiers', bias: 'bullish'});
    if (allBear && c[i] < c[i - 1] && c[i - 1] < c[i - 2]) out.push({pattern: 'three_black_crows', bias: 'bearish'});
    return out;
}

/** Detect candlestick patterns terminating at bar `i` (needs i ≥ 2 for the 3-bar patterns). */
function detectCandlestick(o, h, l, c, i) {
    const out = [];
    if (i < 0 || i >= c.length) return out;
    const body = Math.abs(c[i] - o[i]);
    const range = h[i] - l[i];
    if (range <= 0) return out;
    const upper = h[i] - Math.max(o[i], c[i]);
    const lower = Math.min(o[i], c[i]) - l[i];
    const bull = c[i] > o[i], bear = c[i] < o[i];
    // short-term context: are we coming off a down- or up-leg?
    const downCtx = i >= 3 && c[i] < c[i - 3];
    const upCtx = i >= 3 && c[i] > c[i - 3];
    const ctx = {body, range, upper, lower, bull, bear, downCtx, upCtx};

    out.push(...singleBarPatterns(ctx));
    if (i >= 1) out.push(...twoBarBodyPatterns(o, c, i, ctx), ...twoBarReversalPatterns(o, h, l, c, i, ctx));
    if (i >= 2) out.push(...threeBarPatterns(o, c, i, ctx));
    return out;
}

const pBullAt = (o, c, i) => c[i] > o[i];
const pBearAt = (o, c, i) => c[i] < o[i];

/**
 * Detect candlestick patterns off a symbol's recent klines (no chart). Returns the patterns on
 * the latest completed bar plus any that fired over the last `lookback` bars, each tagged
 * bullish/bearish/neutral. Recognizes doji, hammer/hanging-man, shooting-star/inverted-hammer,
 * marubozu, spinning-top, engulfing, harami, piercing-line/dark-cloud, tweezers, morning/evening
 * star, and three-soldiers/crows.
 */
export async function detectCandlestickPatterns({market = 'futures', symbol, interval = '1h', limit = 100, lookback = 5, _deps = {}} = {}) {
    if (!symbol) throw new Error('symbol is required');
    const lim = Math.max(10, Math.min(Number(limit) || 100, isFuturesLike(market) ? 1500 : 1000));
    const kl = await getKlines({market, symbol, interval, limit: lim, _deps});
    const {opens, highs, lows, closes, openTimes} = ohlcvFull(kl.candles);
    const n = closes.length;
    if (n < 3) throw new Error(`need at least 3 candles to detect patterns (${n})`);
    const back = Math.max(1, Math.min(Number(lookback) || 5, n - 2));
    const recent = [];
    for (let i = n - back; i < n; i++) {
        const p = detectCandlestick(opens, highs, lows, closes, i);
        if (p.length) recent.push({time: openTimes[i], bar: {open: px(opens[i]), high: px(highs[i]), low: px(lows[i]), close: px(closes[i])}, patterns: p});
    }
    return {
        success: true, market, symbol: String(symbol).toUpperCase(), interval, bars: n,
        lastBar: {time: openTimes[n - 1], patterns: detectCandlestick(opens, highs, lows, closes, n - 1)},
        recent,
    };
}

// ── Composite decision signal ────────────────────────────────────────────────
// Aggregate the indicators getTechnicals already computes into ONE weighted BUY/SELL/HOLD
// verdict with a -1..1 score, a confidence read, and human-readable reasons — no new data, no
// orders. Factors are framed as trend-following (price vs MAs, MACD, momentum) so they don't
// contradict each other; RSI extremes are surfaced as cautions that dampen confidence rather
// than flipping the score. `mtf:true` folds in getMultiTimeframe's cross-timeframe confluence.
// (Decision-engine idea borrowed from atilaahmettaner/tradingview-mcp's combined_analysis,
// minus its sentiment/news inputs.)

const clamp1 = (x) => Math.max(-1, Math.min(1, x));

// -1/0/+1 comparison sign (above / equal / below).
const cmpSign = (a, b) => {
    if (a > b) return 1;
    if (a < b) return -1;
    return 0;
};

// Pick the bullish or bearish wording by the sign of a score (>= 0 → bullish wording).
const pickBySign = (s, positive, negative) => (s >= 0 ? positive : negative);

// Append a factor, skipping unavailable (null/non-finite) scores.
const addFactor = (factors, name, score, weight, label) => {
    if (score == null || !Number.isFinite(score)) return;
    factors.push({name, score: clamp1(score), weight, label});
};

// Build the weighted trend-following factor set off a getTechnicals result (all factors share
// the same +bullish / -bearish convention so they don't contradict each other).
function collectSignalFactors(tech) {
    const c = tech.lastClose;
    const factors = [];
    if (tech.sma?.['200'] != null && c != null) {
        const s = cmpSign(c, tech.sma['200']);
        addFactor(factors, 'trend_sma200', s, 1, `price ${pickBySign(s, 'above', 'below')} SMA200 — ${pickBySign(s, 'bullish', 'bearish')} long-term trend`);
    }
    if (tech.ema?.['50'] != null && c != null) {
        const s = cmpSign(c, tech.ema['50']);
        addFactor(factors, 'trend_ema50', s, 0.7, `price ${pickBySign(s, 'above', 'below')} EMA50 — ${pickBySign(s, 'bullish', 'bearish')} mid-term trend`);
    }
    if (tech.macd?.hist != null) {
        const s = cmpSign(tech.macd.hist, 0);
        addFactor(factors, 'macd_hist', s, 0.8, `MACD histogram ${pickBySign(s, 'positive', 'negative')} — momentum ${pickBySign(s, 'up', 'down')}`);
    }
    if (tech.rsi != null) {
        addFactor(factors, 'rsi_momentum', clamp1((tech.rsi - 50) / 20), 0.6, `RSI ${tech.rsi} — momentum ${pickBySign(tech.rsi - 50, 'up', 'down')}`);
    }
    if (tech.vwap != null && c != null) {
        const s = cmpSign(c, tech.vwap);
        addFactor(factors, 'vs_vwap', s, 0.5, `price ${pickBySign(s, 'above', 'below')} VWAP`);
    }
    if (tech.bollinger?.upper != null && tech.bollinger.lower != null && c != null) {
        const span = tech.bollinger.upper - tech.bollinger.lower;
        if (span > 0) {
            const pctB = (c - tech.bollinger.lower) / span; // 0 = lower band, 1 = upper band
            addFactor(factors, 'bollinger_pctb', clamp1((pctB - 0.5) * 2), 0.4, `Bollinger %B ${(pctB * 100).toFixed(0)}% — ${pickBySign(pctB - 0.5, 'upper', 'lower')} half of the band`);
        }
    }
    return factors;
}

// Cautions dampen confidence but never flip the verdict.
function buildSignalCautions(tech, factors) {
    const cautions = [];
    if (tech.rsi != null && tech.rsi >= 70) cautions.push(`RSI ${tech.rsi} overbought — pullback risk on longs`);
    if (tech.rsi != null && tech.rsi <= 30) cautions.push(`RSI ${tech.rsi} oversold — bounce risk on shorts`);
    if (tech.bollinger?.widthPct != null && tech.bollinger.widthPct < 2) cautions.push(`Bollinger bands narrow (${tech.bollinger.widthPct}%) — low volatility, breakout pending`);
    if (factors.length < 4) cautions.push(`only ${factors.length} indicators available (too few bars?) — signal is low-confidence`);
    return cautions;
}

// Map the weighted score + factor agreement (+ any cautions) onto signal/strength/confidence.
function signalVerdict(score, agreement, cautions) {
    const abs = Math.abs(score);
    let signal = 'HOLD';
    if (score >= 0.3) signal = 'BUY';
    if (score <= -0.3) signal = 'SELL';
    let strength = 'weak';
    if (abs >= 0.6) strength = 'strong';
    else if (abs >= 0.3) strength = 'moderate';
    // Confidence blends magnitude + agreement, knocked down a notch when a caution is in play.
    let confidence = 'low';
    if (abs >= 0.5 && agreement >= 0.7) confidence = 'high';
    else if (abs >= 0.3 && agreement >= 0.55) confidence = 'moderate';
    if (confidence === 'high' && cautions.length) confidence = 'moderate';
    return {signal, strength, confidence};
}

// Compact echo of the headline technicals behind a signal.
const signalTechnicals = (tech) => ({
    rsi: tech.rsi,
    macdHist: tech.macd?.hist ?? null,
    sma200: tech.sma?.['200'] ?? null,
    ema50: tech.ema?.['50'] ?? null,
    vwap: tech.vwap,
    trend: tech.classification.trend,
    momentum: tech.classification.momentum
});

/**
 * Composite BUY/SELL/HOLD signal for a symbol, scored off getTechnicals: price vs SMA200 (long
 * trend) and EMA50 (mid trend), MACD histogram, RSI momentum, price vs VWAP, and Bollinger %B —
 * each a weighted -1..1 factor, combined into an overall score, a signal, a confidence read and a
 * `reasons` list. RSI overbought/oversold and a wide/narrow band are flagged as `cautions` (they
 * lower confidence, never flip the call). `mtf:true` also pulls getMultiTimeframe and folds its
 * confluence score in as an extra factor (costs a few more klines calls). Pure aggregation — no
 * orders, no new data sources.
 */
export async function getSignal({market = 'futures', symbol, interval = '1h', limit, mtf = false, _deps = {}} = {}) {
    if (!symbol) throw new Error('symbol is required');
    const tech = await getTechnicals({market, symbol, interval, ...(limit == null ? {} : {limit}), _deps});
    const c = tech.lastClose;
    // Trend-following factor set (all share the same +bullish / -bearish convention).
    const factors = collectSignalFactors(tech);

    let mtfSummary = null;
    if (mtf) {
        try {
            const m = await getMultiTimeframe({market, symbol, _deps});
            mtfSummary = {...m.confluence, timeframes: m.timeframes.map((t) => ({interval: t.interval, trend: t.trend}))};
            addFactor(factors, 'mtf_confluence', m.confluence.score, 1, `multi-timeframe ${m.confluence.bias} (${m.confluence.bullish}↑/${m.confluence.bearish}↓ of ${m.timeframes.length})`);
        } catch (err) {
            mtfSummary = {error: err.message};
        }
    }

    // Weighted, normalized score over the factors that were available.
    const totalW = factors.reduce((s, f) => s + f.weight, 0);
    const score = totalW > 0 ? factors.reduce((s, f) => s + f.score * f.weight, 0) / totalW : 0;
    const sign = cmpSign(score, 0);

    // Agreement: share of (weighted, non-flat) factors pointing the same way as the verdict.
    const active = factors.filter((f) => f.score !== 0);
    const activeW = active.reduce((s, f) => s + f.weight, 0);
    const agreeW = active.filter((f) => Math.sign(f.score) === sign).reduce((s, f) => s + f.weight, 0);
    const agreement = activeW > 0 ? agreeW / activeW : 0;

    const cautions = buildSignalCautions(tech, factors);
    const {signal, strength, confidence} = signalVerdict(score, agreement, cautions);

    const reasons = factors
        .filter((f) => f.score !== 0)
        .sort((a, b) => Math.abs(b.score * b.weight) - Math.abs(a.score * a.weight))
        .map((f) => f.label);

    return {
        success: true, market, symbol: String(symbol).toUpperCase(), interval,
        lastClose: c,
        signal, score: Number(score.toFixed(3)), strength, confidence,
        agreement: Number(agreement.toFixed(2)),
        bullishFactors: factors.filter((f) => f.score > 0).length,
        bearishFactors: factors.filter((f) => f.score < 0).length,
        reasons,
        ...(cautions.length ? {cautions} : {}),
        technicals: signalTechnicals(tech),
        ...(mtfSummary ? {multiTimeframe: mtfSummary} : {}),
    };
}
