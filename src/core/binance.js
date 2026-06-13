/**
 * Binance REST client — direct order placement on a Binance account.
 *
 * This module is INDEPENDENT of TradingView/CDP. It talks to Binance's signed
 * REST API using HMAC-SHA256, with API credentials read from the environment
 * (BINANCE_API_KEY / BINANCE_API_SECRET) or a gitignored project-root `.env`.
 *
 * SAFETY MODEL:
 *  - Credentials are NEVER hardcoded and must not be committed (`.env` is gitignored).
 *  - placeOrder() defaults to a DRY-RUN preview; it only sends a live order when
 *    called with `confirm: true`. This is a deliberate guard against accidental fills.
 *  - Every numeric input is validated with requireFinite before it reaches Binance.
 *
 * Like the rest of src/core, every function takes an optional `_deps` for testing
 * (inject `fetch`, `now`, and `keys`).
 */

// This file is the public barrel for the binance module. The implementation is
// split across src/core/binance/{request,account,orders,market,analysis}.js;
// every name re-exported here is part of the stable public surface consumed by
// the MCP tools, the CLI, tests, and src/core/index.js.

export {getServerTime} from './binance/request.js';

export {
    getBalance, getAccountSummary, getAccountSnapshot, getRiskReport,
    getPositions, getOpenOrders, getAccountTrades, getIncome, getLiquidationHistory,
    getPositionMode, setPositionMode, getCommissionRate, setLeverage, setMarginType,
    adjustIsolatedMargin, getLeverageBrackets,
    transfer, getTransferHistory, getDepositHistory, getWithdrawHistory, getDepositAddress,
} from './binance/account.js';

export {
    calcPositionSize, planGrid, getOrder, getOrderHistory,
    placeOrder, placeBracket, placeLadder, modifyOrder, ensureProtectiveStop,
    cancelOrder, cancelAlgoOrder, cancelAllOrders,
    mirrorOrder, mirrorBracket,
} from './binance/orders.js';

export {
    getTicker, getOrderBook, getKlines, getUiKlines,
    get24hrTicker, getBookTicker, getTradingDayTicker, getAvgPrice, getRollingWindowTicker,
    compareSymbols, getFundingRate,
    getOpenInterest, getOpenInterestHist, getLongShortRatio, getTakerBuySellRatio,
    getRecentTrades, getAggTrades, getHistoricalTrades,
    startUserStream, keepAliveUserStream, closeUserStream,
    watchPrice, watchOrderFlow, getFootprintBars, getOptionsSurface,
    buildMarketStream, formatMarketEvent,
    getSymbolInfo, roundToFilters,
} from './binance/market.js';

export {
    calcExpectancy, estimateLosingStreak, simulateEquity,
    getTechnicals, correlateSymbols, getVolatilityRegime,
    STRATEGY_KEYS, backtestStrategy, compareStrategies, walkForwardBacktest, optimizeStrategy,
    getMultiTimeframe, SCAN_SIGNAL_KEYS, scanSignals, detectCandlestickPatterns, getSignal,
    getPositioning,
} from './binance/analysis.js';

export {getFearGreed, getMarketEvents} from './binance/sentiment.js';

export {buildEquityLogEntry, appendEquityLog, analyzeEquityLog} from './binance/equity.js';
