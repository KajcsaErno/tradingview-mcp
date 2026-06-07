# TradingView MCP

`tradingview-mcp` lets an AI assistant work with your chart in TradingView Desktop and, optionally, your Binance account.

> [!WARNING]
> This project is not affiliated with TradingView Inc.

> [!IMPORTANT]
> The TradingView side requires your own TradingView Desktop app and account. It does not bypass subscriptions or paywalls.

> [!CAUTION]
> The Binance module is optional but can place real orders if you confirm them. Start with dry-runs and read the safety section first.

## What this project is

You get two separate modules in one repo:

| Module | Connects to | What you can do | Why this is useful |
|---|---|---|---|
| TradingView tools | Your local TradingView Desktop app via Chrome DevTools Protocol (`localhost:9222`) | Read chart state, switch symbols/timeframes, manage indicators, replay, screenshots, Pine workflow | Great for chart analysis, Pine development, and workflow automation |
| Binance tools (optional) | Binance REST/WebSocket APIs using your API keys | Read balances/positions, run technical analysis, backtest, size risk, preview/place orders | Great for execution and risk tooling outside of TradingView |

The two modules are independent.

- TradingView module does not place trades through TradingView.
- Binance module does not require TradingView to be open.
- TradingView module talks to your local desktop app over a debug port you enable.

## Prerequisites

- TradingView Desktop installed (for chart tools)
- Node.js 18+
- Claude Code with MCP support (for tool use through chat), or terminal access for CLI
- Binance API keys only if you plan to use `tv binance`

## Quick glossary (new-user friendly)

- `Symbol`: the market ticker, like `AAPL` or `BTCUSDC`.
- `Timeframe`: chart interval, like `1m`, `15m`, `1h`, `D`.
- `Indicator`: calculation shown on chart (RSI, MACD, moving averages).
- `Pine Script`: TradingView's scripting language for indicators/strategies.
- `Spot`: buying/selling the asset directly.
- `Futures`: leveraged derivatives market.
- `Dry-run`: preview only, no live order is sent.
- `Post-only`: order must add liquidity (maker), not take it.

## Quick start (Windows-first)

### 1) Install

```powershell
git clone https://github.com/tradesdontlie/tradingview-mcp.git
Set-Location .\tradingview-mcp
npm install
```

### 2) Launch TradingView Desktop with debug port enabled

From the repo root:

```powershell
.\scripts\launch_tv_debug.bat
```

If you are on Mac/Linux instead, use `scripts/launch_tv_debug_mac.sh` or `scripts/launch_tv_debug_linux.sh`.

### 3) Verify TradingView connection

```powershell
npm run tv -- status
```

### 4) Start the MCP server

```powershell
npm start
```

### 5) Add to Claude Code MCP config

Use your local absolute path:

```json
{
  "mcpServers": {
    "tradingview": {
      "command": "node",
      "args": ["/absolute/path/to/tradingview-mcp/src/server.js"]
    }
  }
}
```

## First 10-minute wins

Try these right away:

```powershell
npm run tv -- state
npm run tv -- symbol AAPL
npm run tv -- timeframe 60
npm run tv -- quote
npm run tv -- ohlcv --summary
npm run tv -- values
npm run tv -- screenshot -r chart
npm run tv -- pane layout 2x2
```

Why these are good:

- You confirm the pipeline works end to end.
- You learn the core chart controls fast.
- You get useful output immediately without writing code.

## TradingView tools: what each tool group does, why it is good, and examples

| Tool group | What you can do | Why it is good | Example |
|---|---|---|---|
| Health and launch (`tv_health_check`, `tv_launch`, `tv_discover`, `tv_ui_state`) | Check connection, launch app, inspect API/UI availability | Saves time when setup breaks | `npm run tv -- status` |
| Chart snapshot (`chart_get_state`, `quote_get`, `data_get_study_values`) | Read current symbol, timeframe, price, and indicator values | Fast chart summary before deeper analysis | `npm run tv -- state` |
| Price bars (`data_get_ohlcv`) | Get OHLCV bars or compact summary | Lets you analyze structure and volatility quickly | `npm run tv -- ohlcv --summary` |
| Pine drawings data (`data_get_pine_lines`, `data_get_pine_labels`, `data_get_pine_tables`, `data_get_pine_boxes`) | Extract levels, labels, tables, zones drawn by custom Pine indicators | Makes custom indicator output machine-readable | `npm run tv -- data lines -f Profiler` |
| Chart control (`chart_set_symbol`, `chart_set_timeframe`, `chart_set_type`, `chart_scroll_to_date`, `chart_set_visible_range`) | Navigate any market quickly | Faster than manual clicking during analysis loops | `npm run tv -- symbol ES1!` |
| Symbol discovery (`symbol_search`, `symbol_info`) | Search symbols and inspect metadata | Helps beginners find correct tickers | `npm run tv -- search crude oil` |
| Indicator management (`chart_manage_indicator`, `indicator_set_inputs`, `indicator_toggle_visibility`, `data_get_indicator`) | Add/remove indicators and change settings | Useful for building repeatable chart templates | `npm run tv -- indicator add "Relative Strength Index"` |
| Multi-pane layouts (`pane_list`, `pane_set_layout`, `pane_focus`, `pane_set_symbol`) | Build multi-chart dashboards | Great for watching multiple symbols/timeframes | `npm run tv -- pane layout 2x2` |
| Tab management (`tab_list`, `tab_new`, `tab_switch`, `tab_close`) | Manage chart tabs from CLI/MCP | Keeps workflows organized without mouse-heavy navigation | `npm run tv -- tab list` |
| Pine editor workflow (`pine_set_source`, `pine_smart_compile`, `pine_get_errors`, `pine_get_console`, `pine_save`, `pine_open`, `pine_list_scripts`) | Write, compile, debug, save Pine scripts | Huge speed boost for Pine iteration | `npm run tv -- pine compile` |
| Replay practice (`replay_start`, `replay_step`, `replay_autoplay`, `replay_trade`, `replay_status`, `replay_stop`) | Practice execution on historical bars | Useful for training and process discipline | `npm run tv -- replay start -d 2025-03-01` |
| Drawings (`draw_shape`, `draw_list`, `draw_remove_one`, `draw_clear`) | Draw lines/zones/text and manage them | Good for marking plans and reviewing decisions | `npm run tv -- draw list` |
| Alerts (`alert_create`, `alert_list`, `alert_delete`, `alert_activate`) | Create and manage chart alerts | Great for not missing planned levels | `npm run tv -- alert create --price 60000 --condition crossing --message "BTC level"` |
| Watchlist (`watchlist_get`, `watchlist_add`) | Read or update watchlist | Keeps a curated market list synced with your workflow | `npm run tv -- watchlist add BTCUSDC` |
| Layout and UI automation (`layout_list`, `layout_switch`, `ui_click`, `ui_keyboard`, `ui_open_panel`, `ui_find_element`, `ui_evaluate`, etc.) | Automate repetitive UI actions | Useful when no direct chart API exists for a step | `npm run tv -- layout list` |
| Screenshots (`capture_screenshot`) | Capture full/chart/strategy tester views | Easy visual record for journaling and review | `npm run tv -- screenshot -r strategy_tester` |
| Batch workflows (`batch_run`) | Run the same action across multiple symbols | Efficient multi-symbol scans | Use MCP `batch_run` with `symbols` list |
| Streaming (CLI: `tv stream quote|bars|values|lines|labels|tables|all`) | Emit JSONL updates continuously | Good for local monitoring scripts and dashboards | `npm run tv -- stream quote -i 300` |
| Morning workflow (`morning_brief`, `session_save`, `session_get`) | Run a rules-based morning scan and store briefs | Creates repeatable daily prep habits | `npm run tv -- brief` |

## Optional Binance module (direct API)

> [!CAUTION]
> Binance commands can touch real funds when `--confirm` is used.

### Minimal setup

1) Copy env template:

```powershell
Copy-Item .env.example .env
```

2) Fill at least:

```dotenv
BINANCE_API_KEY=your_key
BINANCE_API_SECRET=your_secret
```

3) Optional safety switches:

```dotenv
BINANCE_TESTNET=1
PAPER_TRADING=true
```

Notes:

- `BINANCE_TESTNET=1` routes requests to Binance testnet hosts.
- `PAPER_TRADING=true` forces money-moving commands to preview only, even if `--confirm` is passed.

## Binance tools: what each tool group does, why it is good, and examples

| Tool group | What you can do | Why it is good | Example |
|---|---|---|---|
| Account reads (`balance`, `account-summary`, `account-snapshot`, `positions`, `risk-report`) | Inspect balances, positions, risk, and margin health | Gives immediate account clarity | `npm run tv -- binance account-summary` |
| Order and fill history (`orders`, `order-status`, `order-history`, `account-trades`, `income`, `liquidation-history`) | Audit what happened and what it cost | Essential for post-trade review and debugging | `npm run tv -- binance order-history --symbol BTCUSDC` |
| Public market data (`ticker`, `book-ticker`, `ticker-24hr`, `klines`, `depth`, `funding`, `trades`, `agg-trades`, `historical`) | Pull exchange data without TradingView | Useful for scripts and scanners | `npm run tv -- binance klines --symbol BTCUSDC -i 1h -n 200` |
| Advanced market scans (`compare`, `watch-price`, `ui-klines`, `trading-day`, `rolling-ticker`, `avg-price`) | Compare symbols and inspect short-term microstructure | Helps pick cleaner setups | `npm run tv -- binance compare --symbols BTCUSDC,ETHUSDC,SOLUSDC` |
| Technical analysis (`technicals`, `correlate`, `multi-timeframe`, `scan-signals`, `candles`, `signal`) | Compute indicators, correlations, patterns, and directional scores | Reduces manual indicator checking | `npm run tv -- binance technicals --symbol BTCUSDC -i 1h` |
| Backtesting (`backtest`, `compare-strategies`, `walk-forward`) | Evaluate strategy logic on historical klines | Good for filtering weak ideas before live risk | `npm run tv -- binance backtest --symbol BTCUSDC --strategy ema_cross -i 1h` |
| Risk math (`position-size`, `expectancy`, `losing-streak`, `simulate-equity`) | Size positions and model outcome distributions | Prevents random sizing decisions | `npm run tv -- binance position-size --symbol BTCUSDC --entry 60000 --stop 58900 --riskPct 1 --leverage 3` |
| Futures account config (`position-mode`, `set-position-mode`, `leverage`, `margin-type`, `adjust-margin`, `leverage-brackets`, `commission`, `server-time`) | Configure and inspect futures settings and constraints | Reduces order rejections and risk mismatch | `npm run tv -- binance leverage --symbol BTCUSDC --leverage 3` |
| Single-order flow (`order`, `modify`, `cancel`, `cancel-all`, `cancel-algo`) | Preview/place/edit/cancel orders | Core execution controls with safety defaults | `npm run tv -- binance order --symbol BTCUSDC --side BUY --type LIMIT --quantity 0.001 --price 60000` |
| Structured execution (`ladder`, `bracket`, `ensure-stop`) | Build scale-ins and protection plans in one flow | Better risk discipline than one-off manual clicks | `npm run tv -- binance bracket --symbol BTCUSDC --side BUY --quantity 0.01 --entryType LIMIT --entryPrice 60000 --stop 58900 --tp 62000:0.5 --tp 63000:0.5` |
| Multi-account mirroring (`mirror-order`, `mirror-bracket`) | Replicate trades across accounts with size scaling | Useful for master/follower account setups | `npm run tv -- binance mirror-order --symbol BTCUSDC --side BUY --type LIMIT --quantity 0.01 --price 60000 --accounts 1,2` |
| Wallet and transfers (`transfer`, `transfer-history`, `deposit-history`, `withdraw-history`, `deposit-address`) | Move funds and audit wallet activity | Helpful for operational bookkeeping | `npm run tv -- binance transfer --asset USDC --amount 100 --from futures --to spot` |
| Streams (`stream`, `user-stream`, `market-stream`) | Live JSONL updates for account or market events | Useful for monitoring and alerts | `npm run tv -- binance user-stream --account 1` |

## Binance safety defaults you should know

These defaults are intentionally strict:

| Safety behavior | What it means |
|---|---|
| Dry-run by default | Money-moving commands preview only until you pass `--confirm` |
| Post-only defaults for LIMIT | Helps avoid accidental taker fills |
| Taker-only orders require opt-in | `MARKET` and related taker types need explicit `--allowTaker` |
| Hedge mode awareness | Functions require or derive `positionSide` where needed |
| Precision snapping | Price/quantity are rounded to exchange rules unless disabled |
| Testnet switch | `BINANCE_TESTNET=1` routes to testnet hosts |
| Paper-trading kill-switch | `PAPER_TRADING=true` forces preview-only behavior globally |

## Prompt examples for MCP users (Claude Code)

Use prompts like these:

- "Use `chart_get_state`, `data_get_study_values`, and `quote_get`, then explain my chart in plain English."
- "Use `data_get_pine_lines` with `study_filter: \"Profiler\"` and list key levels."
- "Switch to `BTCUSDC` on 1H and take a chart screenshot."
- "Set this Pine code with `pine_set_source`, compile, and fix any errors."
- "Start replay on 2025-03-01 and walk me through one-bar-at-a-time practice."
- "Run `binance_calc_position_size` with 1% risk and 3x leverage and explain the output."
- "Preview a Binance bracket order first (no confirm), then ask me before live placement."
- "Run `binance_get_risk_report` for account 1 and summarize top risks."

## Common beginner workflows

### 1) Quick chart read in under 30 seconds

```powershell
npm run tv -- state
npm run tv -- quote
npm run tv -- values
npm run tv -- ohlcv --summary
```

### 2) Morning prep routine

```powershell
npm run tv -- brief
npm run tv -- session save --brief "Key levels and bias for today"
npm run tv -- session get
```

### 3) Safer Binance execution flow

```powershell
npm run tv -- binance symbol-info --symbol BTCUSDC
npm run tv -- binance position-size --symbol BTCUSDC --entry 60000 --stop 58900 --riskPct 1 --leverage 3
npm run tv -- binance order --symbol BTCUSDC --side BUY --type LIMIT --quantity 0.001 --price 60000
```

The third command is a preview unless you add `--confirm`.

## Troubleshooting

- `status` fails: relaunch TradingView with debug port enabled.
- Pine drawing tools return little/no data: make sure the indicator is visible.
- Indicator add fails: use full indicator names, not abbreviations (`Relative Strength Index`, not `RSI`).
- Binance signed command fails: check `.env` keys and `--account` selection.
- Binance execution safety: keep `PAPER_TRADING=true` while testing automation.

## Testing

```bash
npm test           # full offline suite — no TradingView needed
npm run test:binance
npm run test:e2e   # live e2e — requires TradingView running on port 9222
```

- `npm test` runs the offline suite (pine_analyze + cli + morning + binance + sanitization + replay) and is what CI runs on every push and PR.
- `npm run test:e2e` (and `npm run test:all`) require TradingView running on port `9222`.

## Architecture (simple view)

```text
MCP client  -> src/tools/*         -> src/core/* -> src/connection.js -> TradingView Desktop (CDP)
CLI (tv)    -> src/cli/commands/*  -> src/core/* -> src/connection.js -> TradingView Desktop (CDP)
CLI/MCP     -> src/core/binance.js -> Binance REST/WS APIs (optional, separate)
```

Key design notes:

- Core logic lives in `src/core/*`.
- MCP and CLI layers are thin adapters.
- TradingView input safety uses `safeString()` and `requireFinite()`.
- Binance module is separate and dependency-injected for testability.

## Legal and risk disclaimer

This project is for personal, educational, and research use.

You are responsible for complying with TradingView and Binance terms, exchange data licensing, and applicable laws. Market data and trading involve risk, and Binance execution can result in real financial loss.

## License

MIT. See `LICENSE`.
