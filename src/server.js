import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {registerHealthTools} from './tools/health.js';
import {registerChartTools} from './tools/chart.js';
import {registerPineTools} from './tools/pine.js';
import {registerDataTools} from './tools/data.js';
import {registerCaptureTools} from './tools/capture.js';
import {registerDrawingTools} from './tools/drawing.js';
import {registerAlertTools} from './tools/alerts.js';
import {registerBatchTools} from './tools/batch.js';
import {registerReplayTools} from './tools/replay.js';
import {registerIndicatorTools} from './tools/indicators.js';
import {registerWatchlistTools} from './tools/watchlist.js';
import {registerUiTools} from './tools/ui.js';
import {registerPaneTools} from './tools/pane.js';
import {registerTabTools} from './tools/tab.js';
import {registerBinanceTools} from './tools/binance.js';
import {registerMorningTools} from './tools/morning.js';

const server = new McpServer(
  {
    name: 'tradingview',
    version: '2.0.0',
    description: 'AI-assisted TradingView chart analysis and Pine Script development via Chrome DevTools Protocol',
  },
  {
      instructions: `TradingView MCP — 161 tools: 82 for reading and controlling a live TradingView Desktop chart, plus 79 for direct Binance trading (separate module, no chart needed).

TOOL SELECTION GUIDE — use this to pick the right tool:

Reading your chart:
- chart_get_state → get symbol, timeframe, all indicator names + entity IDs (call first)
- data_get_study_values → get current numeric values from ALL visible indicators (RSI, MACD, BB, EMA, etc.)
- quote_get → get real-time price snapshot (last, OHLC, volume)
- data_get_ohlcv → get price bars. ALWAYS pass summary=true unless you need individual bars

Reading custom Pine indicator output (line.new/label.new/table.new/box.new drawings):
- data_get_pine_lines → horizontal price levels from custom indicators (deduplicated, sorted)
- data_get_pine_labels → text annotations with prices ("PDH 24550", "Bias Long", etc.)
- data_get_pine_tables → table data as formatted rows (session stats, analytics dashboards)
- data_get_pine_boxes → price zones as {high, low} pairs
- ALWAYS pass study_filter to target a specific indicator by name (e.g., study_filter="Profiler")
- Indicators must be VISIBLE on chart for these to work

Changing the chart:
- chart_set_symbol, chart_set_timeframe, chart_set_type → change ticker/resolution/style
- chart_manage_indicator → add/remove studies. USE FULL NAMES: "Relative Strength Index" not "RSI"
- chart_scroll_to_date → jump to a date (ISO format)
- indicator_set_inputs → change indicator settings (length, source, etc.)

Pine Script development:
- pine_set_source → inject code, pine_smart_compile → compile + check errors
- pine_get_errors → read errors, pine_get_console → read log output
- WARNING: pine_get_source can return 200KB+ for complex scripts — avoid unless editing

Screenshots: capture_screenshot → regions: "full", "chart", "strategy_tester"
Replay: replay_start → replay_step → replay_trade → replay_status → replay_stop
Batch: batch_run → run action across multiple symbols/timeframes
Drawing: draw_shape → horizontal_line, trend_line, rectangle, text
Alerts: alert_create, alert_list, alert_delete
Launch: tv_launch → auto-detect and start TradingView with CDP on any platform
Panes: pane_list, pane_set_layout (s, 2h, 2v, 4, 6, 8), pane_focus, pane_set_symbol
Tabs: tab_list, tab_new, tab_close, tab_switch

Binance trading — 79 tools (direct API, NOT via TradingView; needs BINANCE_API_KEY/SECRET in env or .env):
- Reads: binance_get_balance, binance_get_positions, binance_get_open_orders, binance_get_account_summary, binance_get_risk_report, binance_get_order_history, binance_get_income
- Market data (public, no keys): binance_get_ticker, binance_get_klines, binance_get_order_book, binance_get_symbol_info, binance_get_24hr_ticker (all:true = screener), binance_compare_symbols, binance_watch_price
- Positioning (public, USD-M): binance_get_positioning (OI-vs-price quadrant: who is driving the move), binance_get_open_interest(_hist), binance_get_long_short_ratio, binance_get_taker_buy_sell_ratio
- Sentiment & events: binance_get_fear_greed (crypto Fear & Greed index), binance_get_market_events (upcoming FOMC/CPI — check before trading into a squeeze)
- Technical analysis (computed off klines, no chart): binance_get_technicals (RSI/ATR/MACD/SMA/EMA/BB/VWAP), binance_get_signal (composite BUY/SELL/HOLD; mtf/positioning/events flags fold in more evidence), binance_get_multi_timeframe (confluence), binance_scan_signals (screen a list), binance_detect_candlestick_patterns, binance_correlate_symbols
- Backtesting (no orders): binance_backtest_strategy (9 strategies, Sharpe/Calmar/drawdown), binance_compare_strategies (rank all 9), binance_walk_forward_backtest (overfitting check), binance_optimize_strategy (parameter grid sweep, judged out-of-sample)
- Equity tracking: binance_equity_log_append (record an equity sample), binance_equity_log_report (actual vs expected drawdown)
- Sizing & trade math (pure calc): binance_calc_position_size (entry+stop+risk budget → qty), binance_calc_expectancy, binance_estimate_losing_streak, binance_simulate_equity (Monte Carlo)
- Config: binance_set_leverage, binance_set_margin_type, binance_set_position_mode (futures)
- Orders: binance_place_order, binance_place_bracket (entry+stop+TPs), binance_place_ladder (scale-in rungs), binance_modify_order, binance_ensure_protective_stop, binance_cancel_order, binance_cancel_all_orders, binance_mirror_order/binance_mirror_bracket (multi-account), binance_transfer
- SAFETY: all money-moving tools are DRY-RUN previews unless confirm:true. NEVER pass confirm:true on the user's behalf — show the preview and let the user confirm. mainnet = real funds (set BINANCE_TESTNET=1 to route everything to testnet/paper; previews then show live_funds:false).
- Always check binance_get_symbol_info first to round price/quantity to tickSize/stepSize, or orders get rejected.

CONTEXT MANAGEMENT:
- ALWAYS use summary=true on data_get_ohlcv
- ALWAYS use study_filter on pine tools when you know which indicator you want
- NEVER use verbose=true unless user specifically asks for raw data
- Prefer capture_screenshot for visual context over pulling large datasets
- Call chart_get_state ONCE at start, reuse entity IDs`,
  }
);

// Register all tool groups
registerHealthTools(server);
registerChartTools(server);
registerPineTools(server);
registerDataTools(server);
registerCaptureTools(server);
registerDrawingTools(server);
registerAlertTools(server);
registerBatchTools(server);
registerReplayTools(server);
registerIndicatorTools(server);
registerWatchlistTools(server);
registerUiTools(server);
registerPaneTools(server);
registerTabTools(server);
registerBinanceTools(server);
registerMorningTools(server);

// Startup notice (stderr so it doesn't interfere with MCP stdio protocol)
process.stderr.write('⚠  tradingview-mcp  |  Unofficial tool. Not affiliated with TradingView Inc. or Anthropic.\n');
process.stderr.write('   Ensure your usage complies with TradingView\'s Terms of Use.\n\n');

// Start stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
