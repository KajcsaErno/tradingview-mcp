import {z} from 'zod';
import {registerTool} from './_format.js';
import * as core from '../core/binance.js';

const market = z.enum(['spot', 'futures', 'coinm', 'spot-testnet', 'futures-testnet', 'coinm-testnet'])
  .default('futures').describe('Binance market. futures = USD-M; coinm = COIN-M (quantity is in CONTRACTS). Mainnet = REAL funds; *-testnet = paper.');
const symbol = z.string().describe('Trading symbol, e.g. "BTCUSDT" or "BTCUSDC"');
const account = z.string().default('1').describe('Which API key set to use: "1" (primary, BINANCE_API_KEY) or "2"/"3"… (BINANCE_API_KEY_2…). For trade mirroring.');
const accounts = z.array(z.string()).default(['1', '2']).describe('Account ids to mirror across; the first is the base/source-of-truth that drives sizing. Default ["1","2"].');
const marginAsset = z.string().default('USDT').describe('Asset whose balance ratio scales the mirrored quantity (default USDT).');

export function registerBinanceTools(server) {
  // ---- Reads ----
    registerTool(server, 'binance_get_balance', 'Get Binance account balances (non-zero assets)', {
    market, account,
    }, core.getBalance);

    registerTool(server, 'binance_get_positions', 'Get open futures positions (futures only)', {
    market, symbol: symbol.optional(), account,
    }, core.getPositions);

    registerTool(server, 'binance_get_account_summary', 'One-call futures account health: wallet/margin balance, unrealized PnL, available margin, margin ratio (futures only)', {
    market, account,
    }, core.getAccountSummary);

    registerTool(server, 'binance_get_account_snapshot', 'Compact monitoring snapshot: margin ratio, available, unrealized PnL, open-order counts, and per-position side/qty/entry/mark/uPnl (futures only)', {
    market, symbol: symbol.optional(), account,
    }, core.getAccountSnapshot);

    registerTool(server, 'binance_calc_position_size', 'Risk-based position sizing: from entry, a stop (explicit price OR derived from ATR) and a risk budget (riskAmount $ or riskPct of balance) compute quantity, notional and required margin at leverage. Warns if it breaches the 3x rule or available margin.', {
    market, symbol: symbol.optional(),
    entry: z.coerce.number().describe('Entry price'),
    stop: z.coerce.number().optional().describe('Stop-loss price. Omit to derive it from ATR (pass side + atrMult).'),
    side: z.enum(['BUY', 'SELL', 'LONG', 'SHORT']).optional().describe('Position direction — required for an ATR-derived stop (which side the stop sits on).'),
    atrMult: z.coerce.number().optional().describe('Derive the stop as entry ∓ atrMult·ATR (needs symbol + side). ATR(14) is pulled off klines at `interval`.'),
    interval: z.string().default('1h').describe('Kline interval for the ATR-derived stop (default 1h).'),
    leverage: z.coerce.number().default(3).describe('Leverage (default 3)'),
    riskAmount: z.coerce.number().optional().describe('Risk budget in quote currency ($)'),
    riskPct: z.coerce.number().optional().describe('Risk budget as % of balance (e.g. 1 = 1%)'),
    balance: z.coerce.number().optional().describe('Balance to size against (fetched from the account if omitted)'),
    round: z.boolean().default(true),
    account,
    }, core.calcPositionSize);

    registerTool(server, 'binance_get_risk_report', 'Portfolio risk report: per-position notional, liquidation price + distance-to-liq %, % of equity, plus gross exposure, exposure/equity and margin ratio (futures only)', {
    market, account,
    }, core.getRiskReport);

    registerTool(server, 'binance_plan_grid', 'Plan (never place) a grid: N price levels evenly spaced across [lower, upper], per-level qty from totalNotional or totalQuantity, each level classified BUY/SELL around the current price, with grid economics (spacing %, profit per completed grid cycle net of 2× maker fee) and a 3x-rule check. Pure planner — no confirm parameter exists; execute levels post-only via binance_place_ladder / binance_place_order (binance-grid-trader skill).', {
        market, symbol,
        lower: z.coerce.number().describe('Bottom of the grid range'),
        upper: z.coerce.number().describe('Top of the grid range'),
        count: z.coerce.number().default(10).describe('Number of grid LEVELS (N levels = N−1 grid steps). Derive from spacing for BTCUSDC: 100/50/25 USD by range width.'),
        totalNotional: z.coerce.number().optional().describe('Total $ across all levels (pass exactly one of totalNotional / totalQuantity)'),
        totalQuantity: z.coerce.number().optional().describe('Total base quantity across all levels'),
        mode: z.enum(['long', 'short', 'neutral']).default('long').describe('long: BUYs open/add, SELLs reduce. short: inverse. neutral: BUYs open LONG + SELLs open SHORT (Hedge Mode, futures only).'),
        feePct: z.coerce.number().default(0).describe('Maker fee % per side (post-only default = 0)'),
        leverage: z.coerce.number().default(3).describe('Leverage for the margin estimate (default 3)'),
        round: z.boolean().default(true),
        account,
    }, core.planGrid);

  // ---- Trade-math planners (pure, no network, no account) ----
    registerTool(server, 'binance_calc_expectancy', 'Forward-looking expectancy from a win rate (%) and reward:risk ratio: expectancy in R (per unit risked), the break-even win rate (1/(1+rr), e.g. 33% for 2:1), and — if a risk budget is given — $/% per trade and the projected PnL over N trades (fixed-risk). Theory only: excludes commission/slippage/tax/compounding. Pure calc.', {
    winRate: z.coerce.number().describe('Win rate as a percent (e.g. 50 = 50%)'),
    rrRatio: z.coerce.number().describe('Reward:risk ratio — reward won per 1 unit risked (e.g. 2 = 2:1)'),
    riskPct: z.coerce.number().optional().describe('Risk per trade as % of account (for the %-per-trade projection)'),
    riskAmount: z.coerce.number().optional().describe('Risk per trade in quote currency ($) (for the $-per-trade projection)'),
    balance: z.coerce.number().optional().describe('Account balance, to turn riskPct into a $ figure'),
    trades: z.coerce.number().default(100).describe('Sample size for the PnL projection (default 100)'),
    }, core.calcExpectancy);

    registerTool(server, 'binance_estimate_losing_streak', 'Estimate the longest losing streak to expect over a sample size for a given win rate (probabilistic ln(N)/ln(1/lossRate) — e.g. 90% win rate still loses ~3 in a row over 1000 trades, 60% loses ~8). Returns a table across sample sizes; if riskPct is given, the drawdown that streak implies. Plan risk-% around this. Pure calc.', {
    winRate: z.coerce.number().describe('Win rate as a percent, strictly 0–100'),
    sampleSize: z.coerce.number().default(1000).describe('Number of trades to plan over (default 1000)'),
    riskPct: z.coerce.number().optional().describe('Risk per trade as % — adds the worst-streak drawdown (fixed + compounded)'),
    }, core.estimateLosingStreak);

    registerTool(server, 'binance_simulate_equity', 'Monte Carlo equity simulation: runs many random trade sequences at a win rate + reward:risk, risking riskPct each (compounding by default), and reports final-return percentiles, max-drawdown percentiles, longest losing streak, % of runs profitable and % that hit ruin. The forward-looking "what risk-% can I survive?" tool. Pure calc (no network).', {
    winRate: z.coerce.number().describe('Win rate as a percent 0–100'),
    rrRatio: z.coerce.number().describe('Reward:risk ratio (e.g. 2 = 2:1)'),
    riskPct: z.coerce.number().default(1).describe('Risk per trade as % of balance (default 1)'),
    startBalance: z.coerce.number().default(10000).describe('Starting balance (default 10000)'),
    trades: z.coerce.number().default(1000).describe('Trades per run (default 1000, max 100000)'),
    runs: z.coerce.number().default(1000).describe('Independent runs to simulate (default 1000, max 10000)'),
    compounding: z.boolean().default(true).describe('Risk a % of current balance (true) vs fixed % of starting balance (false)'),
    ruinDrawdownPct: z.coerce.number().default(50).describe('Drawdown % that counts a run as "ruined" (default 50)'),
    }, core.simulateEquity);

    registerTool(server, 'binance_get_open_orders', 'List open orders, optionally filtered by symbol', {
    market, symbol: symbol.optional(), account,
    }, core.getOpenOrders);

    registerTool(server, 'binance_get_order', 'Get a single order by orderId or origClientOrderId', {
    market, symbol,
    orderId: z.union([z.string(), z.number()]).optional(),
    origClientOrderId: z.string().optional(),
    account,
    }, core.getOrder);

    registerTool(server, 'binance_get_ticker', 'Latest price for a symbol (public)', {
    market, symbol,
    }, core.getTicker);

    registerTool(server, 'binance_get_klines', 'Candlesticks (OHLCV) for a symbol (public) — pulls candles for the exact Binance contract, independent of any TradingView chart', {
    market, symbol,
    interval: z.enum(['1s', '1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '3d', '1w', '1M']).default('1h'),
    startTime: z.coerce.number().optional().describe('Start time (ms epoch)'),
    endTime: z.coerce.number().optional().describe('End time (ms epoch)'),
    limit: z.coerce.number().optional().describe('Bars to return (spot max 1000, futures max 1500; default 500)'),
    extended: z.boolean().default(false).describe('Also include order-flow fields per bar (quoteVolume, trades, takerBuyVolume, takerBuyQuoteVolume). Off by default for compact output.'),
    }, core.getKlines);

    registerTool(server, 'binance_get_24hr_ticker', '24-hour price-change stats (public). One symbol, or all:true for every symbol on the market (optionally narrowed to a quote asset, e.g. "USDC") — a one-call screener.', {
    market, symbol: symbol.optional(),
    all: z.boolean().default(false).describe('Return every symbol on the market instead of one'),
    quote: z.string().optional().describe('With all:true, keep only symbols in this quote asset, e.g. "USDC"'),
    }, core.get24hrTicker);

    registerTool(server, 'binance_get_book_ticker', 'Best bid/ask + spread (public). One symbol, or all:true for every symbol on the market (optionally narrowed to a quote asset).', {
    market, symbol: symbol.optional(),
    all: z.boolean().default(false).describe('Return every symbol on the market instead of one'),
    quote: z.string().optional().describe('With all:true, keep only symbols in this quote asset, e.g. "USDC"'),
    }, core.getBookTicker);

    registerTool(server, 'binance_get_ui_klines', 'UI-optimized candlesticks (spot-only /uiKlines) — same shape as klines but tuned by Binance for chart presentation', {
    market: market.default('spot'), symbol,
    interval: z.enum(['1s', '1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '3d', '1w', '1M']).default('1h'),
    startTime: z.coerce.number().optional().describe('Start time (ms epoch)'),
    endTime: z.coerce.number().optional().describe('End time (ms epoch)'),
    limit: z.coerce.number().optional().describe('Bars to return (max 1000; default 500)'),
    extended: z.boolean().default(false).describe('Also include order-flow fields per bar (quoteVolume, trades, takerBuyVolume, takerBuyQuoteVolume). Off by default for compact output.'),
    }, core.getUiKlines);

    registerTool(server, 'binance_get_trading_day_ticker', 'Trading-day price-change stats (spot-only) anchored to the exchange trading day in timeZone. One symbol, or a symbols list to scan several.', {
    market: market.default('spot'),
    symbol: symbol.optional(),
    symbols: z.array(z.string()).optional().describe('List of symbols to scan at once'),
    timeZone: z.string().optional().describe('Trading-day offset, e.g. "0" (UTC, default) or "8"'),
    }, core.getTradingDayTicker);

    registerTool(server, 'binance_get_avg_price', 'Current average price over a short window (spot-only; ~5-min avg)', {
    market, symbol,
    }, core.getAvgPrice);

    registerTool(server, 'binance_get_funding_rate', 'Perpetual funding rate (public): current premium-index snapshot, or history:true for recent funding payments', {
    market, symbol,
    history: z.boolean().default(false).describe('true = recent funding-rate history instead of the current snapshot'),
    limit: z.coerce.number().optional().describe('History rows (default 10, max 1000)'),
    }, core.getFundingRate);

  // ---- Open interest & positioning statistics (public, futures) ----
  const oiPeriod = z.enum(['5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d']).default('1h').describe('Statistics bucket period');
  const oiLimit = z.coerce.number().optional().describe('History rows (default 30, max 500; Binance keeps ~30 days)');

    registerTool(server, 'binance_get_open_interest', 'Current open interest (outstanding contracts) for a futures symbol — a snapshot of total market positioning (public, USD-M or COIN-M)', {
    market, symbol,
    }, core.getOpenInterest);

    registerTool(server, 'binance_get_open_interest_hist', 'Historical open interest per period bucket with the % change over the window (public, USD-M only, ~30 days of history). Rising OI = new money entering; falling OI = positions closing. USDC pairs are often not covered — the USDT twin is the standard proxy.', {
    market, symbol, period: oiPeriod, limit: oiLimit,
    }, core.getOpenInterestHist);

    registerTool(server, 'binance_get_long_short_ratio', 'Long/short ratio time series (public, USD-M only). kind: global = all accounts (retail sentiment), topAccount = top 20% traders by account count, topPosition = top 20% by position size (smart money). Ratio > 1 = more longs.', {
    market, symbol, period: oiPeriod, limit: oiLimit,
    kind: z.enum(['global', 'topAccount', 'topPosition']).default('global').describe('Which cut of the market to read'),
    }, core.getLongShortRatio);

    registerTool(server, 'binance_get_taker_buy_sell_ratio', 'Taker buy/sell volume ratio time series (public, USD-M only). Ratio > 1 = aggressive market buyers dominating the tape; < 1 = aggressive sellers.', {
    market, symbol, period: oiPeriod, limit: oiLimit,
    }, core.getTakerBuySellRatio);

    registerTool(server, 'binance_get_positioning', 'Composite positioning read: open-interest change vs price change (the four-quadrant "who is driving the move" read — new longs / short covering / new shorts / long unwind), long/short ratios (global + top traders by size) and taker buy/sell flow. Public USD-M statistics, no account. USDC symbols auto-fall back to the USDT twin (tagged proxySymbol). The "is this move new money or position closing?" complement to binance_get_signal\'s price-derived factors.', {
    market, symbol, period: oiPeriod,
    limit: z.coerce.number().optional().describe('Window length in period buckets (default 30)'),
    }, core.getPositioning);

    registerTool(server, 'binance_get_rolling_window_ticker', 'Rolling-window price-change stats (spot-only). One symbol, or a symbols list to scan a set (Binance has no bare "all" for this endpoint).', {
    market, symbol: symbol.optional(),
    symbols: z.array(z.string()).optional().describe('List of symbols to scan at once'),
    windowSize: z.string().default('1d').describe('Window, e.g. "1m"-"59m", "1h"-"23h", "1d"-"7d"'),
    }, core.getRollingWindowTicker);

    registerTool(server, 'binance_compare_symbols', 'Compare several symbols side-by-side on 24h stats, ranked by a chosen metric (public). Returns a sorted, ranked table + leader/laggard. Works on spot/futures/coinm.', {
    market,
    symbols: z.array(z.string()).describe('Symbols to compare, e.g. ["BTCUSDC","ETHUSDC","SOLUSDC"]'),
    sortBy: z.enum(['priceChangePercent', 'priceChange', 'quoteVolume', 'volume', 'lastPrice']).default('priceChangePercent').describe('Metric to rank by (descending)'),
    }, core.compareSymbols);

  // ---- Technical analysis (computed off klines, public) ----
    registerTool(server, 'binance_get_technicals', 'Technical indicators computed off klines for the exact Binance contract (no chart): RSI(14), ATR(14), MACD(12/26/9), SMA(20/50/200), EMA(12/26/50), Bollinger(20,2), window VWAP, plus a trend/momentum classification. The ATR also feeds binance_calc_position_size. Indicators with too few bars come back null.', {
    market, symbol,
    interval: z.enum(['1s', '1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '3d', '1w', '1M']).default('1h'),
    limit: z.coerce.number().optional().describe('Bars to analyze (min 30; default 300; spot max 1000, futures max 1500)'),
    }, core.getTechnicals);

    registerTool(server, 'binance_correlate_symbols', 'Deep multi-symbol analysis off klines: per-symbol window return %, per-bar volatility, Sharpe-like ratio, ATR %, RSI and trend tag, plus a correlation matrix of close-to-close returns and return/volatility rankings. For portfolio-risk checks (avoid stacking correlated positions) and ranking a shortlist. One klines call per symbol — pass a focused list (capped at 10). The heavier complement to binance_compare_symbols.', {
    market,
    symbols: z.array(z.string()).describe('Symbols to correlate/rank, e.g. ["BTCUSDC","ETHUSDC","SOLUSDC"]'),
    interval: z.enum(['1s', '1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '3d', '1w', '1M']).default('1h'),
    limit: z.coerce.number().optional().describe('Bars per symbol (min 30; default 200)'),
    }, core.correlateSymbols);

  // ---- Backtesting & extended TA (computed off klines, public — no chart, no orders) ----
  const interval = z.enum(['1s', '1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '3d', '1w', '1M']).default('1h');
  const strategy = z.enum(['rsi', 'bollinger', 'macd', 'ema_cross', 'supertrend', 'donchian', 'rsi_pullback', 'keltner', 'triple_ema']);

    registerTool(server, 'binance_backtest_strategy', 'Backtest one strategy over a symbol\'s klines (no chart, no orders). Enters at the next bar\'s open (no lookahead), charges commission+slippage on turnover, and returns institutional metrics: total/annualized return, Sharpe, Calmar, max drawdown, win rate, profit factor, expectancy, avg win/loss, best/worst trade, vs buy-&-hold. Strategies: rsi, bollinger, macd, ema_cross, supertrend, donchian, rsi_pullback, keltner, triple_ema.', {
    market, symbol, interval,
    strategy: strategy.default('ema_cross'),
    limit: z.coerce.number().optional().describe('Bars to backtest (min 60; default 500; spot max 1000, futures max 1500)'),
    commission: z.coerce.number().optional().describe('Per-side commission as a fraction (default 0.0004 = 0.04%)'),
    slippage: z.coerce.number().optional().describe('Per-side slippage as a fraction (default 0.0005 = 0.05%)'),
    allowShort: z.boolean().default(true).describe('Allow short positions (set false for spot/long-only)'),
    includeTrades: z.boolean().default(false).describe('Attach the full trade log (can be large)'),
    includeEquityCurve: z.boolean().default(false).describe('Attach the per-bar equity curve (can be large)'),
    }, core.backtestStrategy);

    registerTool(server, 'binance_compare_strategies', 'Run ALL 9 strategies on one symbol (one klines fetch) and return a ranked table sorted by a chosen metric. Quick read on which approach fits the current regime.', {
    market, symbol, interval,
    limit: z.coerce.number().optional().describe('Bars to backtest (min 60; default 500)'),
    commission: z.coerce.number().optional(),
    slippage: z.coerce.number().optional(),
    allowShort: z.boolean().default(true),
    sortBy: z.enum(['totalReturnPct', 'annualizedReturnPct', 'sharpe', 'calmar', 'winRatePct', 'profitFactor', 'maxDrawdownPct', 'expectancyPct']).default('totalReturnPct'),
    }, core.compareStrategies);

    registerTool(server, 'binance_walk_forward_backtest', 'Out-of-sample consistency check: backtest the strategy, then score the in-sample (first trainRatio) and out-of-sample windows separately and emit an overfitting verdict (ROBUST/MODERATE/WEAK/OVERFITTED/UNPROFITABLE). NOTE: fixed parameters (no grid optimization) — measures temporal robustness, not parameter-search overfitting.', {
    market, symbol, interval,
    strategy: strategy.default('ema_cross'),
    limit: z.coerce.number().optional().describe('Bars (min 120; default 1000)'),
    trainRatio: z.coerce.number().optional().describe('In-sample fraction, 0.1–0.95 (default 0.7)'),
    commission: z.coerce.number().optional(),
    slippage: z.coerce.number().optional(),
    allowShort: z.boolean().default(true),
    }, core.walkForwardBacktest);

    registerTool(server, 'binance_optimize_strategy', 'Grid-sweep one strategy\'s parameters: rank every combo on the TRAIN window by sortBy, judge the winner on the held-out TEST window (selection never sees test data). Returns winner + default-parameter result, selectionEdgePct (what optimization added out-of-sample — negative means keep the defaults), an overfitting verdict and a leaderboard. The parameter-search companion to binance_walk_forward_backtest. Read-only, no orders.', {
    market, symbol, interval,
    strategy: strategy.default('ema_cross'),
    limit: z.coerce.number().optional().describe('Bars (min 240; default 1000)'),
    trainRatio: z.coerce.number().optional().describe('In-sample fraction, 0.1–0.95 (default 0.7)'),
    sortBy: z.enum(['sharpe', 'calmar', 'totalReturnPct', 'annualizedReturnPct', 'winRatePct', 'profitFactor', 'maxDrawdownPct', 'expectancyPct']).default('sharpe').describe('Train-window metric the sweep ranks by'),
    commission: z.coerce.number().optional(),
    slippage: z.coerce.number().optional(),
    allowShort: z.boolean().default(true),
    top: z.coerce.number().optional().describe('Leaderboard rows (default 10)'),
    }, core.optimizeStrategy);

    registerTool(server, 'binance_get_multi_timeframe', 'Trend/momentum confluence across several timeframes: runs the technicals on each interval and reports whether they agree (bullish/bearish/neutral counts, a -1..1 score, a bias tag, and an aligned flag). Default timeframes 15m/1h/4h/1d.', {
    market, symbol,
    intervals: z.array(z.string()).optional().describe('Timeframes to check, e.g. ["15m","1h","4h","1d"] (default that set)'),
    }, core.getMultiTimeframe);

    registerTool(server, 'binance_scan_signals', 'Scan a candidate symbol list for a technical signal — oversold/overbought (RSI≤30/≥70), bullish/bearish (trend), or breakout/breakdown (close beyond a Bollinger band). One klines call per symbol (capped at 20). Returns matching symbols with RSI/trend/lastClose.', {
    market,
    symbols: z.array(z.string()).describe('Symbols to scan, e.g. ["BTCUSDC","ETHUSDC","SOLUSDC"]'),
    signal: z.enum(['oversold', 'overbought', 'bullish', 'bearish', 'breakout', 'breakdown']).default('oversold'),
    interval,
    }, core.scanSignals);

    registerTool(server, 'binance_detect_candlestick_patterns', 'Detect candlestick patterns off a symbol\'s recent klines (no chart): patterns on the latest bar plus any over the last `lookback` bars, each tagged bullish/bearish/neutral. Recognizes doji, hammer/hanging-man, shooting-star/inverted-hammer, marubozu, spinning-top, engulfing, harami, piercing-line/dark-cloud, tweezers, morning/evening star, three-soldiers/crows.', {
    market, symbol, interval,
    limit: z.coerce.number().optional().describe('Bars to pull (min 10; default 100)'),
    lookback: z.coerce.number().optional().describe('How many recent bars to scan for patterns (default 5)'),
    }, core.detectCandlestickPatterns);

    registerTool(server, 'binance_get_signal', 'Composite BUY/SELL/HOLD decision for a symbol, scored off the technicals (price vs SMA200/EMA50, MACD histogram, RSI momentum, price vs VWAP, Bollinger %B) into one weighted -1..1 score with a confidence read and human-readable reasons. RSI extremes / narrow bands are surfaced as cautions (they lower confidence, never flip the call). mtf:true folds in multi-timeframe confluence (a few more klines calls). Pure aggregation — no orders.', {
    market, symbol, interval,
    limit: z.coerce.number().optional().describe('Bars to analyze (min 30; default 300)'),
    mtf: z.boolean().default(false).describe('Also fold in 15m/1h/4h/1d trend confluence as an extra factor'),
    positioning: z.boolean().default(false).describe('Also fold in the open-interest positioning read (OI vs price quadrant) as an extra factor; crowding extremes become cautions'),
    events: z.boolean().default(false).describe('Flag imminent scheduled macro events (FOMC/CPI within 2 days) as cautions — they dampen confidence, never flip the call'),
    }, core.getSignal);

  // ---- Equity-curve persistence (actual vs expected drawdown) ----
    registerTool(server, 'binance_equity_log_append', 'Sample current equity (margin balance incl. unrealized PnL) across accounts and append one JSONL line to the equity log (default strategies/equity-log.jsonl). Run on a schedule to record the ACTUAL equity curve — the counterpart to binance_simulate_equity\'s expected one. Signed read; writes only the local log file.', {
    market,
    accounts: z.array(z.string()).default(['1']).describe('Account ids to sample, e.g. ["1","2"]'),
    file: z.string().optional().describe('Log path (default strategies/equity-log.jsonl, relative to the project root)'),
    }, core.appendEquityLog);

    registerTool(server, 'binance_equity_log_report', 'Analyze the recorded equity log: total return, max & current drawdown, longest declining streak, per-account returns. Pass expectedMaxDrawdownPct (e.g. the binance_simulate_equity p90 max drawdown) for an actual-vs-expected verdict (WITHIN_EXPECTATION / EXCEEDS_EXPECTATION). Pure math over the local log file.', {
    file: z.string().optional().describe('Log path (default strategies/equity-log.jsonl)'),
    expectedMaxDrawdownPct: z.coerce.number().optional().describe('Expected max drawdown % to compare against (sign ignored)'),
    }, core.analyzeEquityLog);

  // ---- Sentiment & scheduled events ----
    registerTool(server, 'binance_get_fear_greed', 'Crypto Fear & Greed index (alternative.me, free/keyless — market-wide, BTC-weighted). 0 = extreme fear, 100 = extreme greed; classically read contrarian at the extremes. limit > 1 returns recent daily history.', {
    limit: z.coerce.number().optional().describe('Days of history (default 1, max 90)'),
    }, core.getFearGreed);

    registerTool(server, 'binance_get_market_events', 'Upcoming scheduled US macro events that reliably move crypto on the clock: FOMC rate decisions (14:00 ET; dot-plot meetings tagged) and CPI releases (08:30 ET). Static verified 2026 calendar, pure/no network. Check before positioning into a volatility squeeze — compressions often resolve on these releases.', {
    daysAhead: z.coerce.number().optional().describe('Look-ahead window in days (default 14, max 365)'),
    }, core.getMarketEvents);

  // ---- User-data stream (real-time push of fills/positions/balance) ----
    registerTool(server, 'binance_start_user_stream', 'Open a user-data stream: returns a listenKey + wsUrl for real-time PUSH of order fills, position and balance changes. Connect a WebSocket to wsUrl; refresh with keepalive every ~30 min. (For a ready-made live feed, run the `tv binance user-stream` CLI.)', {
    market, account,
    }, core.startUserStream);

    registerTool(server, 'binance_keepalive_user_stream', 'Refresh a user-data stream\'s 60-min expiry (call ~every 30 min). Spot requires the listenKey; futures key off the account.', {
    market, account, listenKey: z.string().optional().describe('Required for spot; ignored for futures'),
    }, core.keepAliveUserStream);

    registerTool(server, 'binance_close_user_stream', 'Close a user-data stream (cleanup).', {
    market, account, listenKey: z.string().optional(),
    }, core.closeUserStream);

    registerTool(server, 'binance_get_order_book', 'Order book depth (public)', {
    market, symbol, limit: z.coerce.number().optional().describe('Levels per side (default 20, max 1000)'),
    }, core.getOrderBook);

    registerTool(server, 'binance_get_symbol_info', 'Trading filters: tickSize, stepSize, minNotional, precision — use to round price/qty so orders are not rejected', {
    market, symbol,
    }, core.getSymbolInfo);

    registerTool(server, 'binance_get_position_mode', 'Whether the futures account is in Hedge Mode (positionSide required on orders) or one-way', {
    market, account,
    }, core.getPositionMode);

    registerTool(server, 'binance_set_position_mode', 'Switch the futures account between Hedge Mode (hedgeMode:true) and one-way (false). Idempotent.', {
    market, hedgeMode: z.boolean().describe('true = Hedge Mode (LONG/SHORT positions), false = one-way'), account,
    }, core.setPositionMode);

    registerTool(server, 'binance_get_commission_rate', 'Maker/taker commission rate for a symbol — confirms a 0 maker-fee pair', {
    market, symbol, account,
    }, core.getCommissionRate);

    registerTool(server, 'binance_get_server_time', 'Local-vs-Binance clock offset (signed requests auto-correct on -1021 skew errors)', {
    market,
    }, core.getServerTime);

    registerTool(server, 'binance_get_recent_trades', 'Recent public trades for a symbol', {
    market, symbol, limit: z.coerce.number().optional(),
    }, core.getRecentTrades);

    registerTool(server, 'binance_watch_price', 'Watch a symbol\'s live trades over a public WebSocket for a bounded window (durationSec, 1-60s, default 10), then return a compact summary: open/high/low/close + change, VWAP, volume, tick count. Bounded request/response counterpart to the unbounded `tv binance stream` loop — use it to answer "what is price doing right now?"', {
    market, symbol,
    durationSec: z.coerce.number().min(1).max(60).default(10).describe('How long to watch, in seconds (1-60, default 10)'),
    }, core.watchPrice);

    registerTool(server, 'binance_watch_order_flow', 'Watch real-time order flow over a bounded WebSocket window and return a microstructure read: aggressive buy/sell delta (aggTrades), spread/top-of-book, and depth imbalance from a partial order book stream. Practical Binance-native "heatmap/footprint" proxy.', {
    market, symbol,
    durationSec: z.coerce.number().min(1).max(60).default(10).describe('How long to watch, in seconds (1-60, default 10)'),
    levels: z.coerce.number().default(20).describe('Partial depth levels to track (Binance stream supports 5, 10, 20; values are snapped to the nearest supported level).'),
    }, core.watchOrderFlow);

    registerTool(server, 'binance_get_footprint_bars', 'Footprint-style per-candle aggression from Binance klines: estimates aggressive buy/sell quote flow using takerBuyQuoteVolume vs quoteVolume, with per-bar delta and flow tags (buyers/sellers in control).', {
    market, symbol,
    interval: z.enum(['1s', '1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '3d', '1w', '1M']).default('1m'),
    limit: z.coerce.number().default(100).describe('Bars to analyze (default 100, max 500)'),
    }, core.getFootprintBars);

    registerTool(server, 'binance_get_volatility_regime', 'Multi-timeframe realized-volatility model from Binance klines: annualized realized vol, Parkinson vol, ATR%, and downside/upside volatility skew proxy across intervals (default 5m/15m/1h/4h). Returns regime + skew tags. NOTE: realized-vol model, not options-implied IV.', {
    market, symbol,
    intervals: z.array(z.string()).optional().describe('Intervals to model, e.g. ["5m","15m","1h","4h"] (default that set).'),
    limit: z.coerce.number().default(300).describe('Bars per interval (default 300, min 30, max 1500)'),
    }, core.getVolatilityRegime);

    registerTool(server, 'binance_get_options_surface', 'Binance Options implied-volatility surface + skew snapshot (public EAPI): per-contract markIV/bidIV/askIV/greeks, per-expiry average IV term structure, and ATM call-vs-put skew. This is the options-implied complement to binance_get_volatility_regime.', {
    underlying: z.string().default('BTCUSDT').describe('Underlying pair, e.g. BTCUSDT or ETHUSDT'),
    expirations: z.array(z.string()).optional().describe('Optional expiry filter list in YYYYMMDD format, e.g. ["20260626","20260925"]'),
    full: z.boolean().default(false).describe('Include the full per-contract chain (every strike × side with greeks). Off by default — can be 200KB+. The summary returns per-expiry avg IV + ATM skew only.'),
    }, core.getOptionsSurface);

    registerTool(server, 'binance_get_account_trades', "User's account trades for a symbol (signed)", {
    market, symbol, fromId: z.union([z.string(), z.number()]).optional(), limit: z.coerce.number().optional(), account,
    }, core.getAccountTrades);

    registerTool(server, 'binance_get_order_history', 'All orders for a symbol — open, filled, and cancelled (signed)', {
    market, symbol,
    orderId: z.union([z.string(), z.number()]).optional(),
    startTime: z.coerce.number().optional(), endTime: z.coerce.number().optional(),
    limit: z.coerce.number().optional().describe('Max orders (default 500, max 1000)'),
    account,
    }, core.getOrderHistory);

    registerTool(server, 'binance_get_income', 'Futures income history (signed): realized PnL, funding fees, commissions, etc., with a per-type summary', {
    market, symbol: symbol.optional(),
    incomeType: z.string().optional().describe('Filter: REALIZED_PNL, FUNDING_FEE, COMMISSION, TRANSFER, …'),
    startTime: z.coerce.number().optional(), endTime: z.coerce.number().optional(),
    limit: z.coerce.number().optional().describe('Max rows (default 100, max 1000)'),
    account,
    }, core.getIncome);

    registerTool(server, 'binance_get_liquidation_history', "Forced-liquidation / ADL history (signed, futures only): the user's own positions that Binance force-closed. Backward-looking complement to binance_get_risk_report.", {
    market, symbol: symbol.optional(),
    autoCloseType: z.enum(['LIQUIDATION', 'ADL']).optional().describe('Filter: LIQUIDATION or ADL (auto-deleverage). Omit for both.'),
    startTime: z.coerce.number().optional(), endTime: z.coerce.number().optional(),
    limit: z.coerce.number().optional().describe('Max rows (default 50, max 100)'),
    account,
    }, core.getLiquidationHistory);

  // ---- Config (futures) ----
    registerTool(server, 'binance_set_leverage', 'Set leverage for a futures symbol (1-125)', {
    market, symbol, leverage: z.coerce.number().describe('Integer leverage 1-125'), account,
    }, core.setLeverage);

    registerTool(server, 'binance_set_margin_type', 'Set margin type ISOLATED or CROSSED for a futures symbol', {
    market, symbol, marginType: z.enum(['ISOLATED', 'CROSSED']), account,
    }, core.setMarginType);

    registerTool(server, 'binance_adjust_isolated_margin',
    'Add or remove margin on an ISOLATED futures position (pushes the liquidation price away / frees collateral) WITHOUT closing it. DRY-RUN unless confirm:true. Hedge Mode requires positionSide.', {
    market, symbol,
    amount: z.coerce.number().describe('Margin amount to move (> 0)'),
    direction: z.enum(['add', 'remove']).default('add').describe("'add' increases margin (liq further away); 'remove' frees collateral"),
    positionSide: z.enum(['LONG', 'SHORT', 'BOTH']).optional().describe('Required in Hedge Mode; defaults to BOTH in one-way mode'),
    account,
    confirm: z.boolean().default(false).describe('Must be true to actually move margin (real funds on mainnet)'),
        }, core.adjustIsolatedMargin);

    registerTool(server, 'binance_get_leverage_brackets', 'Leverage/margin tiers (max leverage + maintenance-margin steps per notional) for a symbol (futures only)', {
    market, symbol: symbol.optional(), account,
    }, core.getLeverageBrackets);

  // ---- Money-moving (DRY-RUN unless confirm:true) ----
    registerTool(server, 'binance_place_order',
    'Place an order. DRY-RUN preview unless confirm:true (real funds on mainnet).\n'
    + 'Two order GROUPS with different rules:\n'
    + '  IMMEDIATE (fill now / rest at price; quantity required):\n'
    + '    MARKET — side=BUY, quantity=0.01 (taker: needs allowTaker:true)\n'
    + '    LIMIT  — side=SELL, quantity=0.01, price=64800 (post-only/GTX by default)\n'
    + '  CONDITIONAL (wait for stopPrice trigger; STOP/STOP_MARKET/TAKE_PROFIT/TAKE_PROFIT_MARKET):\n'
    + '    Stop-loss full close:  side=SELL, type=STOP_MARKET, stopPrice=62000, closePosition:true\n'
    + '    Stop-loss partial:     side=SELL, type=STOP_MARKET, stopPrice=62000, quantity=0.01, reduceOnly:true\n'
    + 'closePosition:true closes the ENTIRE position (no quantity, max 1 SL + 1 TP per direction) — '
    + 'reduceOnly:true closes a PARTIAL quantity (multiple allowed). Never set both. '
    + 'Hedge Mode: pass positionSide (LONG/SHORT), not reduceOnly. USD-M conditionals auto-route to the Algo endpoint.', {
    market, symbol,
    side: z.enum(['BUY', 'SELL']),
    type: z.enum(['MARKET', 'LIMIT', 'STOP', 'STOP_MARKET', 'TAKE_PROFIT', 'TAKE_PROFIT_MARKET']).default('MARKET'),
    quantity: z.coerce.number().optional().describe('Base-asset quantity (omit with closePosition)'),
    price: z.coerce.number().optional().describe('Limit price (LIMIT/STOP/TAKE_PROFIT)'),
    stopPrice: z.coerce.number().optional().describe('Trigger price (required for stop/TP types)'),
    closePosition: z.boolean().optional().describe('Futures stop/TP that closes the whole position'),
    reduceOnly: z.boolean().optional().describe('Futures: close-only order'),
    postOnly: z.boolean().default(true).describe('Maker-only, ENFORCED by default: futures→GTX, spot→LIMIT_MAKER. Set false for a normal taker-capable limit.'),
    allowTaker: z.boolean().default(false).describe('Required to place taker-only types (MARKET/STOP_MARKET/TAKE_PROFIT_MARKET) — they cross the book and cannot be post-only.'),
    timeInForce: z.enum(['GTC', 'IOC', 'FOK', 'GTX']).optional().describe('Post-only forces GTX; otherwise defaults GTC.'),
    positionSide: z.enum(['LONG', 'SHORT', 'BOTH']).optional().describe('Required in Hedge Mode: which position the order targets (LONG/SHORT).'),
    round: z.boolean().default(true).describe('Snap price/quantity to the symbol tick/step size so the order is not rejected for precision.'),
    newClientOrderId: z.string().optional(),
    account,
    confirm: z.boolean().default(false).describe('Must be true to actually place the order (real funds on mainnet)'),
        }, core.placeOrder);

    registerTool(server, 'binance_place_bracket',
    'Place entry + protective stop + take-profit(s) in one shot (futures). DRY-RUN unless confirm:true. side is the POSITION direction; stop/TPs go on the closing side. Set includeEntry:false to protect a position you already hold.', {
    market, symbol,
    side: z.enum(['BUY', 'SELL']).describe('Position direction: BUY=long, SELL=short'),
    quantity: z.coerce.number().describe('Position size in base asset'),
    includeEntry: z.boolean().default(true).describe('Place the entry leg too (false = attach stop/TPs to existing position)'),
    entryType: z.enum(['MARKET', 'LIMIT']).default('MARKET'),
    entryPrice: z.coerce.number().optional().describe('Required for LIMIT entry'),
    postOnly: z.boolean().default(true).describe('Maker-only entry (LIMIT only): timeInForce GTX. Enforced by default.'),
    allowTaker: z.boolean().default(false).describe('Required: a bracket with a stop / market-TP / MARKET entry has taker legs that cannot be post-only.'),
    stopPrice: z.coerce.number().optional().describe('Protective stop trigger'),
    takeProfits: z.array(z.object({
      price: z.coerce.number(),
      quantity: z.coerce.number().optional().describe('Per-TP size; required when there is more than one TP'),
    })).optional().describe('One or more take-profit legs'),
    hedge: z.boolean().optional().describe('Force Hedge Mode positionSide on every leg. Omit to auto-detect when confirm:true.'),
    round: z.boolean().default(true).describe('Snap leg prices/quantities to the symbol tick/step size.'),
    account,
    confirm: z.boolean().default(false).describe('Must be true to actually place the bracket (real funds on mainnet)'),
        }, core.placeBracket);

    registerTool(server, 'binance_modify_order',
    'Amend a resting futures LIMIT order price/quantity in place (avoids cancel+replace). DRY-RUN unless confirm:true. Binance requires side + both price and quantity.', {
    market, symbol,
    orderId: z.union([z.string(), z.number()]).optional(),
    origClientOrderId: z.string().optional(),
    side: z.enum(['BUY', 'SELL']).describe('Must match the original order side'),
    quantity: z.coerce.number().describe('New quantity (required by Binance modify)'),
    price: z.coerce.number().describe('New limit price (required by Binance modify)'),
    round: z.boolean().default(true).describe('Snap price/quantity to the symbol tick/step size.'),
    account,
    confirm: z.boolean().default(false).describe('Must be true to actually modify the order (real funds on mainnet)'),
        }, core.modifyOrder);

    registerTool(server, 'binance_place_ladder',
    'Scale into a position with a ladder of post-only LIMIT rungs evenly spaced across [lo, hi], optionally seeded with a MARKET order and guarded by a closePosition stop. DRY-RUN unless confirm:true. Pass exactly one of totalNotional or totalQuantity.', {
    market, symbol,
    side: z.enum(['BUY', 'SELL']),
    lo: z.coerce.number().describe('Bottom of the entry range'),
    hi: z.coerce.number().describe('Top of the entry range'),
    count: z.coerce.number().default(10).describe('Number of rungs'),
    totalNotional: z.coerce.number().optional().describe('Total $ notional split evenly across rungs'),
    totalQuantity: z.coerce.number().optional().describe('Total base qty split evenly across rungs'),
    positionSide: z.enum(['LONG', 'SHORT', 'BOTH']).optional().describe('Required in Hedge Mode'),
    seedQuantity: z.union([z.literal('min'), z.coerce.number()]).optional().describe('Optional MARKET seed to open the position immediately; "min" uses the smallest valid size so a closePosition stop can rest'),
    stop: z.coerce.number().optional().describe('Optional closePosition STOP_MARKET trigger price'),
    postOnly: z.boolean().default(true).describe('Rungs are maker-only GTX by default'),
    round: z.boolean().default(true),
    account,
    confirm: z.boolean().default(false).describe('Must be true to place the ladder (real funds on mainnet)'),
        }, core.placeLadder);

    registerTool(server, 'binance_ensure_protective_stop',
    'Idempotently ensure an open futures position has a closePosition stop. If one already rests, does nothing; otherwise places a STOP_MARKET closePosition at `stop`. DRY-RUN unless confirm:true.', {
    market, symbol,
    stop: z.coerce.number().describe('Stop trigger price'),
    positionSide: z.enum(['LONG', 'SHORT', 'BOTH']).optional().describe('Defaults to the open position side'),
    account,
    confirm: z.boolean().default(false).describe('Must be true to actually place the stop'),
        }, core.ensureProtectiveStop);

    registerTool(server, 'binance_cancel_order', 'Cancel a single open order by orderId or origClientOrderId', {
    market, symbol,
    orderId: z.union([z.string(), z.number()]).optional(),
    origClientOrderId: z.string().optional(),
    account,
    }, core.cancelOrder);

    registerTool(server, 'binance_cancel_all_orders', 'Cancel ALL open orders for a symbol (regular + conditional/algo). DRY-RUN unless confirm:true.', {
    market, symbol, account, confirm: z.boolean().default(false),
    }, core.cancelAllOrders);

  // ---- Multi-account trade mirroring (DRY-RUN unless confirm:true) ----
    registerTool(server, 'binance_mirror_order',
    'Mirror one order across multiple accounts, sized by balance ratio. The base account (accounts[0]) places `quantity`; each other places quantity × (its balance / base balance), snapped to step size. DRY-RUN unless confirm:true. Same order args as binance_place_order. On confirm the base is placed first; if it fails the mirrors are skipped. Leverage/margin-type are NOT mirrored.', {
    market, symbol,
    side: z.enum(['BUY', 'SELL']),
    type: z.enum(['MARKET', 'LIMIT', 'STOP', 'STOP_MARKET', 'TAKE_PROFIT', 'TAKE_PROFIT_MARKET']).default('MARKET'),
    quantity: z.coerce.number().describe('Base-asset quantity for the base account; mirrors are scaled from this'),
    price: z.coerce.number().optional().describe('Limit price (LIMIT/STOP/TAKE_PROFIT)'),
    stopPrice: z.coerce.number().optional().describe('Trigger price (required for stop/TP types)'),
    reduceOnly: z.boolean().optional(),
    postOnly: z.boolean().default(true).describe('Maker-only, enforced by default (futures→GTX, spot→LIMIT_MAKER).'),
    allowTaker: z.boolean().default(false).describe('Required for taker-only types (MARKET/STOP_MARKET/TAKE_PROFIT_MARKET).'),
    timeInForce: z.enum(['GTC', 'IOC', 'FOK', 'GTX']).optional(),
    positionSide: z.enum(['LONG', 'SHORT', 'BOTH']).optional().describe('Required in Hedge Mode (applied to every account).'),
    round: z.boolean().default(true),
    accounts, marginAsset,
    confirm: z.boolean().default(false).describe('Must be true to actually place orders on all accounts (real funds on mainnet)'),
        }, core.mirrorOrder);

    registerTool(server, 'binance_mirror_bracket',
    'Mirror a full bracket (entry + stop + take-profit(s)) across multiple accounts, sized by balance ratio. Same args as binance_place_bracket plus accounts/marginAsset. DRY-RUN unless confirm:true. Per-TP quantities are scaled too. Leverage/margin-type are NOT mirrored.', {
    market, symbol,
    side: z.enum(['BUY', 'SELL']).describe('Position direction: BUY=long, SELL=short'),
    quantity: z.coerce.number().describe('Base-account position size; mirrors are scaled from this'),
    includeEntry: z.boolean().default(true),
    entryType: z.enum(['MARKET', 'LIMIT']).default('MARKET'),
    entryPrice: z.coerce.number().optional(),
    postOnly: z.boolean().default(true),
    allowTaker: z.boolean().default(false),
    stopPrice: z.coerce.number().optional(),
    takeProfits: z.array(z.object({
      price: z.coerce.number(),
      quantity: z.coerce.number().optional(),
    })).optional(),
    hedge: z.boolean().optional(),
    round: z.boolean().default(true),
    accounts, marginAsset,
    confirm: z.boolean().default(false).describe('Must be true to actually place the brackets on all accounts (real funds on mainnet)'),
        }, core.mirrorBracket);

    registerTool(server, 'binance_cancel_algo_order', 'Cancel a conditional (stop/TP) algo order by algoId — USD-M futures', {
    market, algoId: z.union([z.string(), z.number()]).describe('Algo order id (from binance_get_open_orders algoOrders[].algoId)'), account,
    }, core.cancelAlgoOrder);

  const wallet = z.enum(['spot', 'futures', 'usdm', 'coinm']);
    registerTool(server, 'binance_transfer',
    'Move an asset between wallets via Universal Transfer (e.g. USD-M futures → spot). DRY-RUN unless confirm:true. Requires the API key to have "Permits Universal Transfer" enabled.', {
    asset: z.string().describe('Asset to move, e.g. "USDC"'),
    amount: z.coerce.number().describe('Amount to transfer'),
    from: wallet.default('futures').describe('Source wallet'),
    to: wallet.default('spot').describe('Destination wallet'),
    account,
    confirm: z.boolean().default(false).describe('Must be true to actually move funds (real)'),
        }, core.transfer);

    registerTool(server, 'binance_get_transfer_history', 'Recent universal transfers for a wallet pair', {
    from: wallet.default('futures'), to: wallet.default('spot'), size: z.coerce.number().optional(), account,
    }, core.getTransferHistory);

  // ---- Wallet history / address (read-only, SAPI/spot host, mainnet) ----
    registerTool(server, 'binance_get_deposit_history', 'On-chain deposit history (signed). Filter by coin, status (numeric Binance codes) and time window. Read-only.', {
    coin: z.string().optional().describe('Asset to filter by, e.g. "USDC" (omit for all)'),
    status: z.coerce.number().optional().describe('Binance status code: 0 pending, 6 credited-cannot-withdraw, 1 success'),
    startTime: z.coerce.number().optional(), endTime: z.coerce.number().optional(),
    offset: z.coerce.number().optional(),
    limit: z.coerce.number().optional().describe('Max rows (default 100, max 1000)'),
    account,
    }, core.getDepositHistory);

    registerTool(server, 'binance_get_withdraw_history', 'Withdrawal history (signed). Filter by coin, status (numeric Binance codes) and time window. Read-only.', {
    coin: z.string().optional().describe('Asset to filter by, e.g. "USDC" (omit for all)'),
    status: z.coerce.number().optional().describe('Binance status code: 0 email-sent, 1 cancelled, 2 awaiting-approval, 4 processing, 5 failure, 6 completed'),
    startTime: z.coerce.number().optional(), endTime: z.coerce.number().optional(),
    offset: z.coerce.number().optional(),
    limit: z.coerce.number().optional().describe('Max rows (default 100, max 1000)'),
    account,
    }, core.getWithdrawHistory);

    registerTool(server, 'binance_get_deposit_address', 'Deposit address for a coin (signed, read-only). Returns address, optional memo/tag, and explorer url.', {
    coin: z.string().describe('Asset, e.g. "USDC"'),
    network: z.string().optional().describe('Network, e.g. "BSC", "ETH", "TRX", "BNB" (omit for the coin default)'),
    account,
    }, core.getDepositAddress);
}
