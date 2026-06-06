# TradingView MCP Bridge

Personal AI assistant for your TradingView Desktop charts. Connects Claude Code to your locally running TradingView app via Chrome DevTools Protocol for AI-assisted chart analysis, Pine Script development, and workflow automation.

> [!WARNING]
> **This tool is not affiliated with, endorsed by, or associated with TradingView Inc.** It interacts with your locally running TradingView Desktop application via Chrome DevTools Protocol. Review the [Disclaimer](#disclaimer) before use.

> [!IMPORTANT]
> **Requires a valid TradingView subscription.** This tool does not bypass or circumvent any TradingView paywall or access control. It reads from and controls the TradingView Desktop app already running on your machine.

> [!NOTE]
> **All data processing occurs locally on your machine.** No TradingView data is transmitted, stored, or redistributed externally by this tool.

> [!CAUTION]
> This tool accesses undocumented internal TradingView APIs via the Electron debug interface. These can change or break without notice in any TradingView update. Pin your TradingView Desktop version if stability matters to you.

## How It Works (and why it's safe to run)

This tool does not connect to TradingView's servers, modify any TradingView files, or intercept any network traffic. It communicates exclusively with your locally running TradingView Desktop instance via Chrome DevTools Protocol (CDP) — a standard debugging interface built into all Chromium/Electron applications by Google, including VS Code, Slack, and Discord.

The debug port is disabled by default and must be explicitly enabled by you using a standard Chromium flag (`--remote-debugging-port=9222`). Nothing happens without that deliberate step.

## What This Tool Does Not Do

- Connect to TradingView's servers or APIs
- Store, transmit, or redistribute any market data
- Work without a valid TradingView subscription and installed Desktop app
- Bypass any TradingView paywall or access restriction
- Execute trades **through TradingView** (the CDP bridge is chart-interaction only)
- Work if TradingView changes their internal Electron structure

> **Optional Binance module (separate from the above).** The repo also ships a standalone `tv binance` client (`src/core/binance.js`) that talks **directly to Binance's REST API** with your own API keys — independent of the TradingView/CDP bridge, and it **can place real orders**. Safeguards: orders are a **dry-run preview unless `--confirm`**, **post-only by default** (taker requires `--allowTaker`), keys are read only from a **gitignored `.env`**, and it does nothing at all unless you configure keys. See [Binance trading](#binance-trading-direct-api) below.

## Research Context

This project explores an open research question: **how can LLM-based agents interact with professional trading interfaces to support human decision-making?**

Specifically it investigates:

- How structured tool APIs (MCP) can bridge LLMs and stateful desktop financial applications
- What latency, context, and reliability constraints emerge when an agent operates on live chart data
- How agents handle ambiguous financial UI state (e.g. interpreting Pine Script output, reading indicator tables)
- Whether natural language is an effective interface for chart navigation and Pine Script development
- The failure modes of LLM agents operating in real-time data environments

This is not a trading bot. It is an interface layer that makes a trading application legible to an LLM agent, allowing researchers and developers to study human-AI collaboration in financial workflows.

See [RESEARCH.md](RESEARCH.md) for open questions, findings, and related work.

## Prerequisites

- **TradingView Desktop app** (paid subscription required for real-time data)
- **Node.js 18+**
- **Claude Code** with MCP support (for MCP tools) or any terminal (for CLI)
- **macOS, Windows, or Linux**

## What It Does

Gives your AI assistant eyes and hands on your own chart:

- **Pine Script development** — write, inject, compile, debug, and iterate on scripts with AI assistance
- **Chart navigation** — change symbols, timeframes, zoom to dates, add/remove indicators
- **Visual analysis** — read your chart's indicator values, price levels, and annotations
- **Draw on charts** — trend lines, horizontal lines, rectangles, text annotations
- **Manage alerts** — create, list, and delete price alerts
- **Replay practice** — step through historical bars, practice entries/exits
- **Screenshots** — capture chart state for AI visual analysis
- **Multi-pane layouts** — set up 2x2, 3x1, etc. grids with different symbols per pane
- **Monitor your chart** — stream JSONL from your locally running chart for local monitoring scripts
- **CLI access** — every MCP tool is also a `tv` CLI command, pipe-friendly with JSON output
- **Launch TradingView** — auto-detect and launch with debug mode from any platform
- **Binance trading (optional, separate)** — a standalone `tv binance` client (61 tools) places real Binance spot / USD-M / COIN-M orders via your own API keys; dry-run + post-only by default. Includes laddered scale-in, risk-based position sizing (with optional ATR-derived stops), a portfolio risk report, klines-based technical indicators + multi-symbol correlation, a **strategy backtesting engine** (9 strategies with Sharpe/Calmar/max-drawdown/profit-factor, compare-all + walk-forward), multi-timeframe confluence, a composite BUY/SELL/HOLD **signal score**, signal scanning, candlestick-pattern detection, multi-account mirroring, a one-call market screener (`--all`), real-time order/position WebSocket push, and account monitoring. Independent of the TradingView bridge — see [Binance trading](#binance-trading-direct-api)

## Install with Claude Code

Paste this into Claude Code and it will handle the rest:

> Install the TradingView MCP server. Clone https://github.com/tradesdontlie/tradingview-mcp.git, run npm install, add it to my MCP config at ~/.claude/.mcp.json, and launch TradingView with the debug port. Then verify the connection with tv_health_check.

Or follow the manual steps below.

## Quick Start

### 1. Install

```bash
git clone https://github.com/tradesdontlie/tradingview-mcp.git
cd tradingview-mcp
npm install
```

### 2. Launch TradingView with CDP

TradingView Desktop must be running with Chrome DevTools Protocol enabled on port 9222.

**Mac:**
```bash
./scripts/launch_tv_debug_mac.sh
```

**Windows:**
```bash
scripts\launch_tv_debug.bat
```

**Linux:**
```bash
./scripts/launch_tv_debug_linux.sh
```

**Or launch manually on any platform:**
```bash
/path/to/TradingView --remote-debugging-port=9222
```

**Or use the MCP tool** (auto-detects your install):
> "Use tv_launch to start TradingView in debug mode"

### 3. Add to Claude Code

Add to your Claude Code MCP config (`~/.claude/.mcp.json` or project `.mcp.json`):

```json
{
  "mcpServers": {
    "tradingview": {
      "command": "node",
      "args": ["/path/to/tradingview-mcp/src/server.js"]
    }
  }
}
```

Replace `/path/to/tradingview-mcp` with your actual path.

### 4. Verify

Ask Claude: *"Use tv_health_check to verify TradingView is connected"*

## CLI

Every MCP tool is also accessible as a `tv` CLI command. All output is JSON for piping with `jq`.

```bash
# Install globally (optional)
npm link

# Or run directly
node src/cli/index.js <command>
```

### Quick Examples

```bash
tv status                          # check connection
tv quote                           # current price
tv symbol AAPL                     # change symbol
tv ohlcv --summary                 # price summary
tv screenshot -r chart             # capture chart
tv pine compile                    # compile Pine Script
tv pane layout 2x2                 # 4-chart grid
tv pane symbol 1 ES1!              # set pane symbol
tv stream quote | jq '.close'      # monitor price changes
```

### Binance CLI examples

All commands take `--account 1|2|3…` (default `1`) to target a specific API-key set, and `-m spot|futures|coinm` (default `futures`).

```bash
# --- reads (no funds at risk) ---
tv binance balance                                  # account balances (futures by default)
tv binance balance --account 2                      # a second API-key set
tv binance positions                                # open futures positions
tv binance account-summary                          # wallet/margin balance, uPnL, margin ratio
tv binance risk-report                              # per-position liq distance, % of equity, exposure
tv binance ticker --symbol BTCUSDC                  # latest price (public)
tv binance klines --symbol BTCUSDC -i 1h -n 100     # candlesticks for the exact contract (public)
tv binance ticker-24hr --symbol BTCUSDC             # 24h change/high/low/volume (public)
tv binance book-ticker --symbol BTCUSDC             # best bid/ask + computed spread (public)
tv binance funding --symbol BTCUSDC                 # perpetual funding rate (public)
tv binance income --symbol BTCUSDC                  # realized PnL / funding / commissions, summarized
tv binance order-history --symbol BTCUSDC           # all orders: open, filled, cancelled
tv binance symbol-info --symbol BTCUSDC             # tick/step/minNotional filters
tv binance leverage-brackets --symbol BTCUSDC       # max-leverage tiers per notional
tv binance position-mode                            # Hedge Mode vs one-way

# --- risk sizing (pure calc) ---
# From entry/stop + risk budget → quantity, notional, required margin (warns if it breaks 3x):
tv binance position-size --symbol BTCUSDC --entry 60000 --stop 58900 --riskPct 1 --leverage 3

# --- placing orders (DRY-RUN unless --confirm; post-only unless --noPostOnly) ---
# Post-only limit (defaults to GTX on futures / LIMIT_MAKER on spot):
tv binance order --symbol BTCUSDC --side BUY --type LIMIT --quantity 0.001 --price 60000

# Hedge-mode accounts must pass --positionSide:
tv binance order --symbol BTCUSDC --side SELL --type LIMIT -q 1 -p 64800 --positionSide SHORT --confirm

# Taker order types (MARKET / STOP_MARKET / TAKE_PROFIT_MARKET) require --allowTaker:
tv binance order --symbol BTCUSDC --side BUY --type MARKET -q 0.01 --allowTaker --confirm

# Scale in with a ladder of N post-only rungs across a range, optional seed + protective stop:
tv binance ladder --symbol BTCUSDC --side BUY --lo 59800 --hi 60500 --count 50 \
  --totalNotional 100000 --positionSide LONG --seed 0.001 --stop 58900   # add --confirm to place

# One-shot bracket: entry (post-only LIMIT) + protective stop + take-profits:
tv binance bracket --symbol BTCUSDC --side SELL -q 1 \
  --entryType LIMIT --entryPrice 64800 --stop 67500 --tp 61300:0.5 --tp 60000:0.5 \
  --hedge --allowTaker            # add --confirm to actually place

# Ensure an open position has a protective stop (places one only if missing):
tv binance ensure-stop --symbol BTCUSDC --stop 58900     # add --confirm to place

# Amend a resting LIMIT order in place (no cancel+replace):
tv binance modify --symbol BTCUSDC --orderId 123456789 --side BUY -q 0.033 -p 60100 --confirm

# Mirror one order across accounts, sized by balance ratio (DRY-RUN unless --confirm):
tv binance mirror-order --symbol BTCUSDC --side BUY --type LIMIT -q 0.01 -p 60000 \
  --positionSide LONG --accounts 1,2

# Futures config + cancels:
tv binance leverage --symbol BTCUSDC --leverage 3 --account 2
tv binance set-position-mode --hedge --account 2     # switch Hedge/one-way (idempotent)
tv binance margin-type --symbol BTCUSDC --marginType CROSSED
tv binance cancel --symbol BTCUSDC --orderId 123456789
tv binance cancel-all --symbol BTCUSDC --confirm
tv binance cancel-algo --algoId 1000001871754500     # cancel a conditional/stop (algo) order

# Monitor account/position state — JSONL on every change (Ctrl-C to stop):
tv binance stream --symbol BTCUSDC --account 1
tv binance account-snapshot --account 1              # one-shot compact snapshot

# Wallet transfer (DRY-RUN unless --confirm; needs "Universal Transfer" enabled on the key):
tv binance transfer --asset USDC --amount 100 --from futures --to spot
tv binance transfer-history --from futures --to spot
```

### All Commands

```
tv status / launch / state / symbol / timeframe / type / info / search
tv quote / ohlcv / values
tv data lines/labels/tables/boxes/strategy/trades/equity/depth/indicator
tv pine get/set/compile/analyze/check/save/new/open/list/errors/console
tv draw shape/list/get/remove/clear
tv alert list/create/delete
tv watchlist get/add
tv indicator add/remove/toggle/set/get
tv layout list/switch
tv pane list/layout/focus/symbol
tv tab list/new/close/switch
tv replay start/step/stop/status/autoplay/trade
tv stream quote/bars/values/lines/labels/tables/all
tv ui click/keyboard/hover/scroll/find/eval/type/panel/fullscreen/mouse
tv screenshot / discover / ui-state / range / scroll
tv binance balance/account-summary/account-snapshot/risk-report/positions/stream
tv binance orders/order-status/order-history/order/modify/cancel/cancel-all/cancel-algo
tv binance ladder/bracket/ensure-stop/position-size
tv binance ticker/klines/ticker-24hr/book-ticker/funding/avg-price/rolling-ticker/depth
tv binance symbol-info/leverage-brackets/trades/agg-trades/historical/account-trades/income
tv binance leverage/margin-type/position-mode/set-position-mode/commission/server-time
tv binance mirror-order/mirror-bracket/transfer/transfer-history
```

All `tv binance` commands accept `--account <n>` (multi-account, default `1`) and `-m spot|futures|coinm`.

## Streaming

The `tv stream` commands poll your locally running TradingView Desktop instance at regular intervals via Chrome DevTools Protocol on localhost.

No connection is made to TradingView's servers. All data stays on your machine.

> [!WARNING]
> Programmatic consumption of TradingView data may conflict with their Terms of Use regardless of the data source. You are solely responsible for ensuring your usage complies.

```bash
tv stream quote                          # price tick monitoring
tv stream bars                           # bar-by-bar updates
tv stream values                         # indicator value monitoring
tv stream lines --filter "NY Levels"     # price level monitoring
tv stream tables --filter Profiler       # table data monitoring
tv stream all                            # all panes at once (multi-symbol)
```

## Binance trading (direct API)

> [!CAUTION]
> This is a **separate, optional** component that places **real orders on your Binance account** using **your own API keys**. It is independent of the TradingView/CDP bridge — TradingView is not involved in execution. Cryptocurrency trading carries substantial risk of loss. You are solely responsible for every order placed.

`src/core/binance.js` (and the matching `tv binance` CLI / `binance_*` MCP tools) talk directly to Binance's signed REST API. It is unrelated to TradingView and only does something once you provide keys.

**Setup:** copy `.env.example` to `.env` (gitignored) and fill in your keys. Multiple accounts are supported — the unsuffixed pair is account `1`, and `_2` / `_3` / … add more (used by `--account` and the mirror tools):

```
BINANCE_API_KEY=...
BINANCE_API_SECRET=...
BINANCE_API_KEY_2=...
BINANCE_API_SECRET_2=...
```

Keys are read from `.env` or the environment — never hardcoded, never committed. Restrict the key to trading (no withdrawals) and ideally to your IP. See `.env.example` for the full template and recommended permissions.

**Safety model (built in):**

| Guard | Behavior |
|-------|----------|
| **Dry-run by default** | `order`, `bracket`, and `cancel-all` return a preview and send nothing unless you pass `--confirm` / `confirm:true`. |
| **Post-only by default** | LIMIT orders are maker-only (futures `GTX`, spot `LIMIT_MAKER`). Disable per-order with `--noPostOnly`. |
| **Taker opt-in** | `MARKET` / `STOP_MARKET` / `TAKE_PROFIT_MARKET` are blocked unless you pass `--allowTaker` (they cannot be post-only). |
| **Hedge-mode aware** | In Hedge Mode, orders require `--positionSide LONG\|SHORT`; `placeOrder` auto-detects and refuses to guess. `bracket` derives it from `--side` (`--hedge`). |
| **Precision rounding** | Price/quantity snap to the symbol's tickSize/stepSize so orders aren't rejected (`--noRound` to disable). |
| **Algo routing** | Conditional orders (STOP / TP) auto-route to Binance's algo endpoint (`/fapi/v1/algoOrder`) per the 2025-12 migration; `get-open-orders` merges them; `cancel-algo` / `cancel-all` clear them. |
| **Clock-skew guard** | Signed requests auto-resync to Binance server time and retry once on a `-1021` timestamp error. |
| **Rate-limit backoff** | Signed requests retry `429` / `418` with `Retry-After`/exponential backoff (hardens the ladder & batch paths). |
| **Multi-account** | Every command takes `--account 1\|2\|3…`; keys resolve per account. Leverage / margin-type / position-mode are NOT mirrored — set them per account. |

`market` is `futures` (USD-M) by default; pass `-m spot` for spot or `-m coinm` for COIN-M. `leverage`, `margin-type`, `position-mode`, `account-summary`, `risk-report`, `bracket`, and `ladder` are futures-only.

**Testnet (paper trading):** set `BINANCE_TESTNET=1` to route every market to its testnet host (`testnet.binancefuture.com` / `testnet.binance.vision`) — no per-call `-m futures-testnet` needed. Order previews then report `live_funds:false`. Testnet uses its **own** API keys (mainnet keys don't work there); set `BINANCE_TESTNET_API_KEY` / `BINANCE_TESTNET_API_SECRET` (with the same `_2`/`_3`… suffix scheme). See `.env.example`. You can still target a single testnet market per call with `-m futures-testnet` without the global flag.

**Paper-trading kill-switch:** set `PAPER_TRADING=true` (or `BINANCE_PAPER_TRADING=true`) to force **every** money-moving command into dry-run: it logs the full decision/preview but sends **nothing — even with `--confirm`**. Dry-run output carries `"paper_trading": true`. This is the master guard for running automation wired for live without risking a real fill: watch a few days of logged decisions, confirm the logic matches what you expect, then unset it to go live. Unlike `BINANCE_TESTNET` (which still *places* orders on the testnet exchange), paper trading places nothing anywhere; the two can be combined.

**Tool groups (61 tools / 63 CLI subcommands):**

| Group | Tools |
|-------|-------|
| **Reads** | `balance`, `account-summary`, `account-snapshot`, `risk-report`, `positions`, `orders`, `order-status`, `order-history`, `income`, `liquidation-history`, `account-trades`, `position-mode`, `leverage-brackets`, `commission`, `server-time` |
| **Market data (public)** | `ticker`, `klines`, `ui-klines`, `ticker-24hr` (`--all [--quote USDC]`), `book-ticker` (`--all [--quote USDC]`), `trading-day`, `funding`, `avg-price`, `rolling-ticker` (`--symbols`), `compare` (`--symbols` ranked side-by-side), `depth`, `symbol-info`, `trades`, `agg-trades`, `historical`, `watch-price` (bounded live-WS OHLC/VWAP summary, `-d` 1-60s) |
| **Technical analysis (computed off klines, public)** | `technicals` (RSI/ATR/MACD/SMA/EMA/Bollinger/VWAP + trend classification for one symbol), `correlate` (`--symbols`: per-symbol return/volatility/Sharpe/ATR%/RSI/trend + Pearson correlation matrix + rankings), `multi-timeframe` (trend confluence across `--intervals`), `scan-signals` (`--symbols --signal oversold\|overbought\|bullish\|bearish\|breakout\|breakdown`), `candles` (candlestick-pattern detection), `signal` (composite BUY/SELL/HOLD score + reasons; `--mtf` folds in multi-timeframe) |
| **Backtesting (computed off klines, public — no orders)** | `backtest` (`--strategy` one of rsi/bollinger/macd/ema_cross/supertrend/donchian/rsi_pullback/keltner/triple_ema → Sharpe/Calmar/max-drawdown/profit-factor/expectancy/vs buy&hold), `compare-strategies` (rank all 9 by `--sortBy`), `walk-forward` (train/test out-of-sample verdict) |
| **Orders & risk (money-moving, dry-run unless `--confirm`)** | `order`, `ladder`, `bracket`, `modify`, `ensure-stop`, `adjust-margin`, `cancel`, `cancel-all`, `cancel-algo`, `mirror-order`, `mirror-bracket`, `transfer` |
| **Sizing & config** | `position-size` (pure calc; explicit `--stop` **or** ATR-derived via `--atrMult` + `--side`), `leverage`, `margin-type`, `set-position-mode` |
| **Monitoring** | `stream` (polled JSONL on change), `user-stream` (real-time WebSocket push of fills/positions/balance), `market-stream` (real-time WebSocket push of public market data — `--symbols` × `--streams` trade/ticker/bookTicker/kline/markPrice/funding, JSONL), `account-snapshot` |
| **Wallet (read-only, spot host, mainnet)** | `transfer-history`, `deposit-history`, `withdraw-history`, `deposit-address` |

**COIN-M futures (`-m coinm`)** has the same commands as USD-M — reads, order placement, brackets, cancels, leverage, and margin-type — routed to the coin-margined (`dapi`) API. **One critical difference: COIN-M `--quantity` is in CONTRACTS** (a fixed USD notional each, e.g. $100/contract for BTC), not coin amount. Order previews include a `coinm_note` reminder, and `symbol-info` reports `contractSize`.

See [Binance CLI examples](#binance-cli-examples) above for usage.

## How Claude Knows Which Tool to Use

Claude reads [`CLAUDE.md`](CLAUDE.md) automatically when working in this project. It contains a complete decision tree:

| You say... | Claude uses... |
|------------|---------------|
| "What's on my chart?" | `chart_get_state` → `data_get_study_values` → `quote_get` |
| "What levels are showing?" | `data_get_pine_lines` → `data_get_pine_labels` |
| "Read the session table" | `data_get_pine_tables` with `study_filter` |
| "Give me a full analysis" | `quote_get` → `data_get_study_values` → `data_get_pine_lines` → `data_get_pine_labels` → `data_get_pine_tables` → `data_get_ohlcv` (summary) → `capture_screenshot` |
| "Switch to AAPL daily" | `chart_set_symbol` → `chart_set_timeframe` |
| "Write a Pine Script for..." | `pine_set_source` → `pine_smart_compile` → `pine_get_errors` |
| "Start replay at March 1st" | `replay_start` → `replay_step` → `replay_trade` |
| "Set up a 4-chart grid" | `pane_set_layout` → `pane_set_symbol` for each pane |
| "Draw a level at 24500" | `draw_shape` (horizontal_line) |
| "Take a screenshot" | `capture_screenshot` |

## Tool Reference (140 MCP tools)

The tables below cover the **79 TradingView chart tools**. The **61 Binance tools** are documented separately under [Binance trading](#binance-trading-direct-api).

### Chart Reading

| Tool | When to use | Output size |
|------|------------|-------------|
| `chart_get_state` | First call — get symbol, timeframe, all indicator names + IDs | ~500B |
| `data_get_study_values` | Read current RSI, MACD, BB, EMA values from all indicators | ~500B |
| `quote_get` | Get latest price, OHLC, volume | ~200B |
| `data_get_ohlcv` | Get price bars. **Use `summary: true`** for compact stats | 500B (summary) / 8KB (100 bars) |

### Custom Indicator Data (Pine Drawings)

Read `line.new()`, `label.new()`, `table.new()`, `box.new()` output from any visible Pine indicator.

| Tool | When to use | Output size |
|------|------------|-------------|
| `data_get_pine_lines` | Read horizontal price levels (support/resistance, session levels) | ~1-3KB |
| `data_get_pine_labels` | Read text annotations + prices ("PDH 24550", "Bias Long") | ~2-5KB |
| `data_get_pine_tables` | Read data tables (session stats, analytics dashboards) | ~1-4KB |
| `data_get_pine_boxes` | Read price zones / ranges as {high, low} pairs | ~1-2KB |

**Always use `study_filter`** to target a specific indicator: `study_filter: "Profiler"`.

### Chart Control

| Tool | What it does |
|------|-------------|
| `chart_set_symbol` | Change ticker (BTCUSD, AAPL, ES1!, NYMEX:CL1!) |
| `chart_set_timeframe` | Change resolution (1, 5, 15, 60, D, W, M) |
| `chart_set_type` | Change style (Candles, HeikinAshi, Line, Area, Renko) |
| `chart_manage_indicator` | Add/remove indicators. **Use full names**: "Relative Strength Index" not "RSI" |
| `chart_scroll_to_date` | Jump to a date (ISO: "2025-01-15") |
| `chart_set_visible_range` | Zoom to exact range (unix timestamps) |
| `symbol_info` / `symbol_search` | Symbol metadata and search |
| `indicator_set_inputs` / `indicator_toggle_visibility` | Change indicator settings, show/hide |

### Multi-Pane Layouts

| Tool | What it does |
|------|-------------|
| `pane_list` | List all panes with symbols and active state |
| `pane_set_layout` | Change grid: `s`, `2h`, `2v`, `2x2`, `4`, `6`, `8` |
| `pane_focus` | Focus a specific pane by index |
| `pane_set_symbol` | Set symbol on any pane |

### Tab Management

| Tool | What it does |
|------|-------------|
| `tab_list` | List open chart tabs |
| `tab_new` / `tab_close` | Open/close tabs |
| `tab_switch` | Switch to a tab by index |

### Pine Script Development

| Tool | Step |
|------|------|
| `pine_set_source` | 1. Inject code into editor |
| `pine_smart_compile` | 2. Compile with auto-detection + error check |
| `pine_get_errors` | 3. Read compilation errors if any |
| `pine_get_console` | 4. Read log.info() output |
| `pine_save` | 5. Save to TradingView cloud |
| `pine_get_source` | Read current script (**warning: can be 200KB+ for complex scripts**) |
| `pine_new` | Create blank indicator/strategy/library |
| `pine_open` / `pine_list_scripts` | Open or list saved scripts |
| `pine_analyze` | Offline static analysis (no chart needed) |
| `pine_check` | Server-side compile check (no chart needed) |

### Replay Mode

| Tool | Step |
|------|------|
| `replay_start` | Enter replay at a date |
| `replay_step` | Advance one bar |
| `replay_autoplay` | Auto-advance (set speed in ms) |
| `replay_trade` | Buy/sell/close positions |
| `replay_status` | Check position, P&L, date |
| `replay_stop` | Return to realtime |

### Drawing, Alerts, UI Automation

| Tool | What it does |
|------|-------------|
| `draw_shape` | Draw horizontal_line, trend_line, rectangle, text |
| `draw_list` / `draw_remove_one` / `draw_clear` | Manage drawings |
| `alert_create` / `alert_list` / `alert_delete` | Manage price alerts |
| `capture_screenshot` | Screenshot (regions: full, chart, strategy_tester) |
| `batch_run` | Run action across multiple symbols/timeframes |
| `watchlist_get` / `watchlist_add` | Read/modify watchlist |
| `layout_list` / `layout_switch` | Manage saved layouts |
| `ui_open_panel` / `ui_click` / `ui_evaluate` | UI automation |
| `tv_launch` / `tv_health_check` / `tv_discover` | Connection management |

## Context Management

Tools return compact output by default to minimize context usage. For a typical "analyze my chart" workflow, total context is ~5-10KB instead of ~80KB.

| Feature | How it saves context |
|---------|---------------------|
| Pine lines | Returns deduplicated price levels only, not every line object |
| Pine labels | Capped at 50 per study, text+price only |
| Pine tables | Pre-formatted row strings, no cell metadata |
| Pine boxes | Deduplicated {high, low} zones only |
| OHLCV summary mode | Stats + last 5 bars instead of all bars |
| Indicator inputs | Encrypted/encoded blobs auto-filtered |
| `verbose: true` | Pass on any pine tool to get raw data with IDs/colors when needed |
| `study_filter` | Target one indicator instead of scanning all |

## Finding TradingView on Your System

Launch scripts and `tv_launch` auto-detect TradingView. If auto-detection fails:

| Platform | Common Locations |
|----------|-----------------|
| **Mac** | `/Applications/TradingView.app/Contents/MacOS/TradingView` |
| **Windows** | `%LOCALAPPDATA%\TradingView\TradingView.exe`, `%PROGRAMFILES%\WindowsApps\TradingView*\TradingView.exe` |
| **Linux** | `/opt/TradingView/tradingview`, `~/.local/share/TradingView/TradingView`, `/snap/tradingview/current/tradingview` |

The key flag: `--remote-debugging-port=9222`

## Testing

```bash
# Requires TradingView running with --remote-debugging-port=9222
npm test
```

```bash
# No TradingView needed (pure unit tests):
npm run test:unit                  # pine_analyze + CLI routing
node --test tests/binance.test.js  # 90 Binance unit tests (DI-mocked, no network)
node --test tests/sanitization.test.js   # CDP injection-prevention tests
```

Test coverage: Pine Script static analysis, server-side compilation, CLI routing, CDP injection prevention, and the Binance module (90 tests — post-only/taker gates, dry-run guards, hedge mode, precision, algo routing, **per-account key routing**, ladder/batch, risk sizing, rate-limit backoff — all via injected `_deps`, no live API).

## Architecture

```
Claude Code  ←→  MCP Server (stdio)  ←→  CDP (port 9222)  ←→  TradingView Desktop (Electron)
```

- **Transport**: MCP over stdio (140 tools — 79 TradingView + 61 Binance) + CLI (`tv` command; the `binance` command alone has 63 subcommands)
- **Connection**: Chrome DevTools Protocol on localhost:9222 (TradingView); signed REST to Binance (trading module, independent of CDP)
- **Streaming**: Poll-and-diff loop with deduplication, JSONL output to stdout (`tv stream` for the chart, `tv binance stream` for account/positions)
- **No dependencies** beyond `@modelcontextprotocol/sdk` and `chrome-remote-interface` (the Binance module is zero-dep: HMAC signing + a tiny `.env` parser)

## Attributions

This project is not affiliated with, endorsed by, or associated with:
- **TradingView Inc.** — TradingView is a trademark of TradingView Inc.
- **Anthropic** — Claude and Claude Code are trademarks of Anthropic, PBC.

This tool is an independent MCP server that connects to Claude Code via the standard MCP protocol. It does not contain or modify any Anthropic software.

## Disclaimer

This project is provided **for personal, educational, and research purposes only**.

**How this tool works:** This tool uses the Chrome DevTools Protocol (CDP), a standard debugging interface built into all Chromium-based applications by Google. It does not reverse engineer any proprietary TradingView protocol, connect to TradingView's servers, or bypass any access controls. The debug port must be explicitly enabled by the user via a standard Chromium command-line flag (`--remote-debugging-port=9222`).

By using this software, you acknowledge and agree that:

1. **You are solely responsible** for ensuring your use of this tool complies with [TradingView's Terms of Use](https://www.tradingview.com/policies/) and all applicable laws.
2. TradingView's Terms of Use **restrict automated data collection, scraping, and non-display usage** of their platform and data. This tool uses Chrome DevTools Protocol to programmatically interact with the TradingView Desktop app, which may conflict with those terms.
3. **You assume all risk** associated with using this tool. The authors are not responsible for any account bans, suspensions, legal actions, or other consequences resulting from its use.
4. This tool **must not be used** for, including but not limited to:
   - Redistributing, reselling, or commercially exploiting TradingView's market data
   - Circumventing TradingView's access controls or subscription restrictions
   - Performing automated trading or algorithmic decision-making using extracted data
   - Violating the intellectual property rights of Pine Script indicator authors
   - Connecting to TradingView's servers or infrastructure (all access is via the locally running Desktop app)
5. The streaming functionality monitors your locally running TradingView Desktop instance only. It does not connect to TradingView's servers or extract data from TradingView's infrastructure.
6. Market data accessed through this tool remains subject to exchange and data provider licensing terms. **Do not redistribute, store, or commercially exploit any data obtained through this tool.**
7. This tool accesses internal, undocumented TradingView application interfaces that may change or break at any time without notice.

**Use at your own risk.** If you are unsure whether your intended use complies with TradingView's terms, do not use this tool.

## License

MIT — see [LICENSE](LICENSE) for details.

The MIT license applies to the source code of this project only. It does not grant any rights to TradingView's software, data, trademarks, or intellectual property.
