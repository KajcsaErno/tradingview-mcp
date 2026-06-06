# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

124 MCP tools total (and matching `tv` CLI commands): **79 for reading and controlling a live TradingView Desktop chart** via Chrome DevTools Protocol on `localhost:9222`, plus **45 in the separate Binance trading module**. Two consumers, one core: an MCP server (stdio) and a pipe-friendly CLI.

There is also a **separate, optional Binance trading module** (`src/core/binance.js` + `tv binance` + `binance_*` MCP tools — 45 tools / 45 CLI subcommands) that talks directly to Binance's signed REST API with the user's own API keys. It is **independent of the TradingView/CDP layer** (no chart involved) and can place **real orders**. See "Binance module" below before touching it.

## Development Commands

```bash
npm install                        # zero-config, only @modelcontextprotocol/sdk + chrome-remote-interface
npm start                          # run MCP server (stdio)
npm run tv -- <command>            # run CLI (or `node src/cli/index.js`)

npm test                           # e2e + pine_analyze (e2e REQUIRES TradingView running on :9222)
npm run test:unit                  # pine_analyze + cli — no TradingView needed
npm run test:cli                   # CLI router tests
npm run test:e2e                   # full e2e (needs live TradingView)
npm run test:all                   # e2e + pine_analyze + cli
npm run test:verbose               # spec reporter
node --test tests/sanitization.test.js   # CDP injection-prevention tests (pure unit, no TV)
node --test tests/replay.test.js         # replay logic unit tests

# Run a single test by name filter
node --test --test-name-pattern="setSymbol" tests/sanitization.test.js
```

There is no lint/format step configured. Tests use the built-in `node:test` runner — no Jest, Mocha, or Vitest. The package is `"type": "module"` (ESM) — all source files use `import`/`export`, not `require`.

## Code Architecture

The codebase is a strict three-layer fan-out from a single core. **All TradingView interaction lives in `src/core/`; everything else is a thin adapter.**

```
                            ┌──────────────────────┐
   MCP client (Claude) ───► │  src/tools/*.js      │ ──┐
                            │  (Zod schemas +      │   │
                            │   server.tool calls) │   │
                            └──────────────────────┘   │
                                                       ▼
                            ┌──────────────────────┐  src/core/*.js
   CLI (`tv` command) ────► │  src/cli/commands/   │ ──► (chart, data, pine,
                            │  (parseArgs router)  │     replay, drawing, …)
                            └──────────────────────┘     │
                                                         ▼
                                                src/connection.js
                                                (CDP client, evaluate(),
                                                 safeString, requireFinite)
                                                         │
                                                         ▼
                                              CDP :9222 → TradingView
```

### Layers

- **`src/connection.js`** — singleton CDP client with auto-reconnect (exponential backoff up to 5 tries). Picks the Electron target whose URL matches `tradingview.com/chart`. Exposes `evaluate(expr)` / `evaluateAsync(expr)` which `Runtime.evaluate` JS strings inside the TradingView page. Also exports the **two security primitives every core function uses**:
  - `safeString(str)` — `JSON.stringify`-based escape for any user value interpolated into evaluated JS. Mandatory for symbols, indicator names, dates, drawing text, etc.
  - `requireFinite(n, name)` — validator for numeric inputs before they reach TV APIs that persist to cloud state.
  - `KNOWN_PATHS` — verified deep paths into the TradingView Electron app (`window.TradingViewApi._activeChartWidgetWV.value()`, `_replayApi`, `_alertService`, pine-facade REST, etc.). These are undocumented and **can break on any TradingView update** — pin the desktop version if stability matters.

- **`src/wait.js`** — `waitForChartReady()` polls DOM (loader spinner, bar count stability, symbol-match) before returning control. Use this after any chart mutation; do not rely on `setTimeout`.

- **`src/core/*.js`** — pure logic. Each module (chart, data, pine, replay, drawing, alerts, batch, indicators, pane, tab, ui, watchlist, capture, health, stream) exports functions that build a JS expression string, call `evaluate()`, and return `{ success, … }`. **Every function takes an optional `_deps` parameter** that defaults to the real `evaluate`/`evaluateAsync`/`waitForChartReady`. This is the DI hook used by `tests/sanitization.test.js` and `tests/replay.test.js` to assert against the actual JS strings being sent — that is how injection regressions are caught without a live chart.

- **`src/tools/*.js`** — MCP adapters. Each `register*Tools(server)` registers one `server.tool(name, description, zodSchema, handler)` per core function. Handlers are uniformly `try { return jsonResult(await core.fn(args)); } catch (err) { return jsonResult({ success: false, error: err.message }, true); }`. The `_format.js` helper wraps payloads as MCP text content.

- **`src/cli/`** — `index.js` imports every command module; `router.js` is a zero-dep wrapper over `node:util.parseArgs` with subcommand support; `commands/*.js` map CLI flags to the same `src/core/*` functions. CLI prints JSON to stdout, errors to stderr, exit codes: 0 ok / 1 error / 2 connection failure. `tv stream` polls and diffs to emit JSONL.

- **`src/server.js`** — MCP entry. Constructs `McpServer`, registers all tool groups, prints unaffiliated-with-TradingView notice to stderr (never stdout — MCP uses stdio), connects `StdioServerTransport`. The `instructions` field embedded here is the same selection guide users see in `CLAUDE.md`.

### Adding a new tool — the canonical flow

1. Add the function to the right `src/core/*.js` module with the `_deps` DI parameter and `safeString`/`requireFinite` on every user input.
2. Register an MCP wrapper in the matching `src/tools/*.js` with a Zod schema.
3. Add a CLI subcommand in `src/cli/commands/*.js` mapping flags → the core function.
4. Add e2e coverage in `tests/e2e.test.js` and (if the function builds JS from user input) a sanitization test in `tests/sanitization.test.js` that asserts on the generated expression string via `_deps`.

### Other things worth knowing

- `src/core/index.js` re-exports the core as a public surface (`import { chart, data, pine } from 'tradingview-mcp/core'`), separate from the MCP/CLI surfaces.
- Pine graphics path is non-obvious: `study._graphics._primitivesCollection.dwglines.get('lines').get(false)._primitivesDataById`. That's how `data_get_pine_*` reads `line.new()` / `label.new()` / `table.new()` / `box.new()` output. Indicators must be **visible** on the chart for this to work.
- `chart_manage_indicator` requires **full indicator names**: "Relative Strength Index" not "RSI", "Moving Average Exponential" not "EMA", "Bollinger Bands" not "BB".
- All entity IDs from `chart_get_state` are session-specific — never cache across sessions.
- Screenshots write to `screenshots/` and return a path, not image bytes.

## Decision tree — picking the right tool

Below is the decision tree the model should consult when responding to user requests on a live chart.

### "What's on my chart right now?"
1. `chart_get_state` → symbol, timeframe, chart type, list of all indicators with entity IDs
2. `data_get_study_values` → current numeric values from all visible indicators (RSI, MACD, BBands, EMAs, etc.)
3. `quote_get` → real-time price, OHLC, volume for current symbol

### "What levels/lines/labels are showing?"
Custom Pine indicators draw with `line.new()`, `label.new()`, `table.new()`, `box.new()`. These are invisible to normal data tools. Use:

1. `data_get_pine_lines` → horizontal price levels drawn by indicators (deduplicated, sorted high→low)
2. `data_get_pine_labels` → text annotations with prices (e.g., "PDH 24550", "Bias Long ✓")
3. `data_get_pine_tables` → table data formatted as rows (e.g., session stats, analytics dashboards)
4. `data_get_pine_boxes` → price zones / ranges as {high, low} pairs

Use `study_filter` parameter to target a specific indicator by name substring (e.g., `study_filter: "Profiler"`).

### "Give me price data"
- `data_get_ohlcv` with `summary: true` → compact stats (high, low, range, change%, avg volume, last 5 bars)
- `data_get_ohlcv` without summary → all bars (use `count` to limit, default 100)
- `quote_get` → single latest price snapshot

### "Analyze my chart" (full report workflow)
1. `quote_get` → current price
2. `data_get_study_values` → all indicator readings
3. `data_get_pine_lines` → key price levels from custom indicators
4. `data_get_pine_labels` → labeled levels with context (e.g., "Settlement", "ASN O/U")
5. `data_get_pine_tables` → session stats, analytics tables
6. `data_get_ohlcv` with `summary: true` → price action summary
7. `capture_screenshot` → visual confirmation

### "Change the chart"
- `chart_set_symbol` → switch ticker (e.g., "AAPL", "ES1!", "NYMEX:CL1!")
- `chart_set_timeframe` → switch resolution (e.g., "1", "5", "15", "60", "D", "W")
- `chart_set_type` → switch chart style (Candles, HeikinAshi, Line, Area, Renko, etc.)
- `chart_manage_indicator` → add or remove studies (use full name: "Relative Strength Index", not "RSI")
- `chart_scroll_to_date` → jump to a date (ISO format: "2025-01-15")
- `chart_set_visible_range` → zoom to exact date range (unix timestamps)

### "Work on Pine Script"
1. `pine_set_source` → inject code into editor
2. `pine_smart_compile` → compile with auto-detection + error check
3. `pine_get_errors` → read compilation errors
4. `pine_get_console` → read log.info() output
5. `pine_get_source` → read current code back (WARNING: can be very large for complex scripts)
6. `pine_save` → save to TradingView cloud
7. `pine_new` → create blank indicator/strategy/library
8. `pine_open` → load a saved script by name

### "Practice trading with replay"
1. `replay_start` with `date: "2025-03-01"` → enter replay mode
2. `replay_step` → advance one bar
3. `replay_autoplay` → auto-advance (set speed with `speed` param in ms)
4. `replay_trade` with `action: "buy"/"sell"/"close"` → execute trades
5. `replay_status` → check position, P&L, current date
6. `replay_stop` → return to realtime

### "Screen multiple symbols"
- `batch_run` with `symbols: ["ES1!", "NQ1!", "YM1!"]` and `action: "screenshot"`, `"get_ohlcv"`, or `"get_strategy_results"` (reads Strategy Tester metrics from DOM)

### "Draw on the chart"
- `draw_shape` → horizontal_line, trend_line, rectangle, text (pass point + optional point2)
- `draw_list` → see what's drawn
- `draw_remove_one` → remove by ID
- `draw_clear` → remove all

### "Manage alerts"
- `alert_create` → set price alert (condition: "crossing", "greater_than", "less_than")
- `alert_list` → view active alerts
- `alert_delete` → remove alerts

### "Navigate the UI"
- `ui_open_panel` → open/close pine-editor, strategy-tester, watchlist, alerts, trading
- `ui_click` → click buttons by aria-label, text, or data-name
- `layout_switch` → load a saved layout by name
- `ui_fullscreen` → toggle fullscreen
- `capture_screenshot` → take a screenshot (regions: "full", "chart", "strategy_tester")

### "TradingView isn't running"
- `tv_launch` → auto-detect and launch TradingView with CDP on Mac/Win/Linux
- `tv_health_check` → verify connection is working

## Context Management Rules

These tools can return large payloads. Follow these rules to avoid context bloat:

1. **Always use `summary: true` on `data_get_ohlcv`** unless you specifically need individual bars
2. **Always use `study_filter`** on pine tools when you know which indicator you want — don't scan all studies unnecessarily
3. **Never use `verbose: true`** on pine tools unless the user specifically asks for raw drawing data with IDs/colors
4. **Avoid calling `pine_get_source`** on complex scripts — it can return 200KB+. Only read if you need to edit the code.
5. **Avoid calling `data_get_indicator`** on protected/encrypted indicators — their inputs are encoded blobs. Use `data_get_study_values` instead for current values.
6. **Use `capture_screenshot`** for visual context instead of pulling large datasets — a screenshot is ~300KB but gives you the full visual picture
7. **Call `chart_get_state` once** at the start to get entity IDs, then reference them — don't re-call repeatedly
8. **Cap your OHLCV requests** — `count: 20` for quick analysis, `count: 100` for deeper work, `count: 500` only when specifically needed

### Output Size Estimates (compact mode)
| Tool | Typical Output |
|------|---------------|
| `quote_get` | ~200 bytes |
| `data_get_study_values` | ~500 bytes (all indicators) |
| `data_get_pine_lines` | ~1-3 KB per study (deduplicated levels) |
| `data_get_pine_labels` | ~2-5 KB per study (capped at 50) |
| `data_get_pine_tables` | ~1-4 KB per study (formatted rows) |
| `data_get_pine_boxes` | ~1-2 KB per study (deduplicated zones) |
| `data_get_ohlcv` (summary) | ~500 bytes |
| `data_get_ohlcv` (100 bars) | ~8 KB |
| `capture_screenshot` | ~300 bytes (returns file path, not image data) |

## Tool Conventions

- All tools return `{ success: true/false, ... }`
- Entity IDs (from `chart_get_state`) are session-specific — don't cache across sessions
- Pine indicators must be **visible** on chart for pine graphics tools to read their data
- `chart_manage_indicator` requires **full indicator names**: "Relative Strength Index" not "RSI", "Moving Average Exponential" not "EMA", "Bollinger Bands" not "BB"
- Screenshots save to `screenshots/` directory with timestamps
- OHLCV capped at 500 bars, trades at 20 per request
- Pine labels capped at 50 per study by default (pass `max_labels` to override)

## Binance module (`src/core/binance.js`)

Separate from everything above — it does **not** use CDP, `evaluate()`, `safeString`, or `KNOWN_PATHS`. It signs Binance REST calls with HMAC-SHA256 using keys from a **gitignored `.env`** (`BINANCE_API_KEY`/`BINANCE_API_SECRET`, plus `_2`/`_3`… for more accounts), loaded by a tiny zero-dep parser. Like the rest of core, every function takes `_deps` for DI — here `{ fetch, now, keys, sleep }` — which `tests/binance.test.js` injects to assert on the exact requests built (no network). **104 unit tests**; run `npm run test:binance` (or `node --test tests/binance.test.js`).

Surfaces: core in `src/core/binance.js`, MCP wrappers in `src/tools/binance.js` (registered in `server.js`), CLI in `src/cli/commands/binance.js` (`tv binance <sub>`). **45 tools / 45 CLI subcommands**, grouped:
- **Reads:** `getBalance`, `getAccountSummary`, `getAccountSnapshot`, `getRiskReport`, `getPositions`, `getOpenOrders`, `getOrder`, `getOrderHistory`, `getIncome`, `getAccountTrades`, `getPositionMode`, `getLeverageBrackets`, `getCommissionRate`, `getServerTime`.
- **Market data (public, unsigned):** `getTicker`, `getKlines`, `getUiKlines`*, `get24hrTicker`, `getBookTicker`, `getTradingDayTicker`*, `getFundingRate`, `getAvgPrice`*, `getRollingWindowTicker`*, `getOrderBook`, `getSymbolInfo`, `getRecentTrades`, `getAggTrades`, `getHistoricalTrades` (*spot-only). `get24hrTicker`/`getBookTicker` take `all:true` (+ optional `quote:"USDC"` filter) for a one-call market screener; `getRollingWindowTicker`/`getTradingDayTicker` take a `symbols` list (Binance has no bare "all" for those).
- **Money-moving (dry-run unless `confirm:true`):** `placeOrder`, `placeLadder`, `placeBracket`, `modifyOrder`, `ensureProtectiveStop`, `cancelOrder`, `cancelAllOrders`, `cancelAlgoOrder`, `mirrorOrder`, `mirrorBracket`, `transfer`.
- **Sizing & config:** `calcPositionSize` (pure calc), `setLeverage`, `setMarginType`, `setPositionMode`.
- **User-data stream (real-time push):** `startUserStream` / `keepAliveUserStream` / `closeUserStream` manage a `listenKey`; `startUserStream` returns the `wsUrl` to connect to. The ready-made live feed is the **`tv binance user-stream`** CLI subcommand — a long-running loop (like `tv binance stream`) that opens the WebSocket, emits JSONL on `ORDER_TRADE_UPDATE`/`ACCOUNT_UPDATE`/etc. (`--raw` for full payloads), keep-alives every 30 min, and auto-reconnects. Uses Node's built-in global `WebSocket` (no new dep). This is push (fills/positions/balance the instant they change) vs. `tv binance stream`'s polling.

**Invariants to preserve when editing (these are deliberate, see memory):**
- **Dry-run by default:** `placeOrder`, `placeLadder`, `placeBracket`, `modifyOrder`, `ensureProtectiveStop`, `cancelAllOrders`, `mirrorOrder`, `mirrorBracket`, `transfer` return a preview and send nothing unless `confirm: true`. Never auto-confirm on the user's behalf.
- **Post-only by default:** LIMIT orders → `GTX` (futures) / `LIMIT_MAKER` (spot). Taker-only types (`MARKET`, `STOP_MARKET`, `TAKE_PROFIT_MARKET`) throw unless `allowTaker: true`.
- **Hedge mode:** the user's account is in Hedge Mode — futures orders need `positionSide` (LONG/SHORT) and must NOT send `reduceOnly`. `placeOrder` auto-detects on confirm and refuses to guess; `placeBracket` derives `positionSide` from `side`.
- **Precision:** price/qty snap to tickSize/stepSize via `exchangeInfo` (`round` default true).
- **Conditional orders use the Algo endpoint (Binance migration, 2025-12-09):** USD-M `STOP/STOP_MARKET/TAKE_PROFIT/TAKE_PROFIT_MARKET/TRAILING_STOP_MARKET` are rejected by `POST /fapi/v1/order` with `-4120` and must POST to `/fapi/v1/algoOrder` with `algoType=CONDITIONAL` and **`triggerPrice`** (not `stopPrice`). `placeOrder`/`placeBracket` auto-route these (`useAlgo = isStop && isFutures`). `getOpenOrders` merges `openAlgoOrders`; `cancelAlgoOrder(algoId)` + `cancelAllOrders` clear them. Plain LIMIT/MARKET still use `/fapi/v1/order`. COIN-M conditional routing is NOT yet migrated in code (still `/dapi/v1/order`).
- **Clock skew & rate limits:** `signedRequest` applies a server-time offset and retries once on `-1021`; it also retries `429`/`418` with `Retry-After`/exponential backoff (sleep injectable via `_deps.sleep`).
- **Per-account key routing (do not regress):** EVERY signed or account-specific function takes `account` and resolves keys via `resolveDeps(account, _deps)`, then passes `_deps: deps` to `signedRequest`. A function that omits `account` silently falls back to account 1's keys (`getKeys()`), which is a dangerous bug — e.g. cancelling/transferring on the wrong account. This was fixed across `getPositionMode`, `setPositionMode`, `setLeverage`, `setMarginType`, `getCommissionRate`, `getOrder`, `cancelOrder`, `cancelAlgoOrder`, `getAccountTrades`, `getHistoricalTrades`, `getOrderHistory`, `transfer`, `getTransferHistory` (+ all new tools). `tests/binance.test.js` "account routing" suite injects a `getKeys` spy to assert each routes the requested account. The CLI/MCP wrappers must forward `account`/`o.account` too.
- **Laddered scale-in:** `placeLadder` builds N evenly-spaced post-only LIMIT rungs across `[lo,hi]` from `totalNotional` OR `totalQuantity` (exactly one), with optional `seedQuantity` (MARKET) and `stop` (closePosition STOP_MARKET). DRY-RUN by default; on confirm it places seed → stop (delegated to `placeOrder`) then the rungs via `batchPlaceOrders` (futures `/batchOrders`, 5/request). Inherits hedge/precision rules. **A `stop` with no seed fails (Binance `-4509`): a closePosition stop has nothing to guard until a position exists.** Pass `seedQuantity: 'min'` (CLI `--seed min`) to open the smallest valid position first — it resolves from the symbol's `minQty` AND `minNotional` (notional snapped UP via `snap(..., 'ceil')`, priced off the current bid), so a set-and-forget ladder's stop can rest immediately without over-seeding.
- **Protective-stop helper:** `ensureProtectiveStop` is idempotent — if a closePosition STOP already rests it does nothing; else (and only if a position exists) it places one. Dry-run unless confirm.
- **Risk tooling (read-only):** `calcPositionSize` (pure: entry/stop + riskAmount|riskPct → qty/notional/margin, warns if it breaches the user's 3x rule) and `getRiskReport` (per-position liq-distance %, % of equity, gross exposure). The user's standing rule: **always 3x leverage, never more; trade USDC pairs only (BTCUSDC default)** — see memory.
- **Monitoring:** `getAccountSnapshot` is a compact one-call snapshot; `tv binance stream` polls it and emits JSONL on change (CLI-only loop in the subcommand handler — it never returns; `--once` for a single snapshot).
- **Wallet transfers:** `transfer()` uses Binance Universal Transfer (`/sapi/v1/asset/transfer`, spot host) — dry-run unless `confirm:true`. `from`/`to` wallets (spot/futures/coinm) map to a transfer `type`; one side must be spot. Requires the API key to have "Permits Universal Transfer" enabled.
- **Multi-account trade mirroring:** every user-facing function takes an optional `account` ("1" = primary `BINANCE_API_KEY`, "2"/"3"… = `BINANCE_API_KEY_2`…); `getKeys(account)` resolves the suffix. `mirrorOrder`/`mirrorBracket` (`binance_mirror_order` / `tv binance mirror-order`, + `-bracket`) fan a single order/bracket out across `accounts` (default `["1","2"]`), **sized by balance ratio**: base account = `accounts[0]` (factor 1), each mirror gets `quantity × (its balance / base balance)` snapped to stepSize via `planMirrorSizing`. They **delegate to `placeOrder`/`placeBracket` per account**, so dry-run/post-only/hedge/precision/algo routing are all inherited. DRY-RUN by default; on confirm the base is placed first and mirrors are skipped if it fails (or if a scaled size floors below `minQty`). **Leverage/margin-type are NOT mirrored** — set them per account with `setLeverage`/`setMarginType` + `account`.
- `market` defaults to `futures` (USD-M, `fapi`). `getPositions`/`setLeverage`/`setMarginType`/`placeBracket` are futures-only.
- **COIN-M (`coinm`, `dapi`) has full parity with USD-M** — reads, orders, brackets, cancels, leverage, margin-type, position-mode, commission all route to `/dapi/v1/...` via the `isFuturesLike`/`futPrefix` helpers (USD-M = `/fapi`, COIN-M = `/dapi`). **Critical difference: COIN-M `quantity` is in CONTRACTS** (a fixed USD notional each, e.g. $100/contract for BTC), not coin amount. This is surfaced as a `coinm_note` in order previews and via `getSymbolInfo`'s `contractSize`. The post-only/hedge/rounding logic is shared; COIN-M `LOT_SIZE` stepSize is typically `1` so quantities floor to whole contracts.

## Skills and Agents

The repo ships Claude Code–native skills (in `skills/`) and a custom subagent (in `agents/`):

| Path | Purpose |
|------|---------|
| `skills/pine-develop/` | Full Pine Script write → compile → fix loop |
| `skills/chart-analysis/` | Set up chart, add indicators, annotate, screenshot |
| `skills/multi-symbol-scan/` | Batch symbol screening workflow |
| `skills/replay-practice/` | Guided replay mode trading practice |
| `skills/strategy-report/` | Backtest results gathering and reporting |
| `skills/binance-ladder-entry/` | Plan/size/dry-run/place a laddered scale-in (seed + protective stop) |
| `skills/chart-to-binance-trade/` | Read chart levels → risk-sized Binance order/ladder + stop (bridges CDP chart → CEX execution) |
| `skills/binance-account-review/` | Read-only cross-account health/exposure/funding/PnL report |
| `skills/binance-position-manager/` | Protect & manage an open position (ensure-stop, take-profits, modify, trail) |
| `skills/binance-multi-account-mirror/` | Pre-flight (hedge/3x) then mirror a trade across accounts by balance ratio |
| `skills/binance-trade-review/` | Post-trade review: realized PnL, funding, commissions, fills |
| `agents/performance-analyst.md` | Subagent: gather strategy data and analyze performance |
| `agents/binance-risk-analyst.md` | Subagent: deep read-only multi-account Binance risk/exposure sweep |

Skills reference `scripts/pine_pull.js` and `scripts/pine_push.js` for reading/injecting Pine code. `scripts/` also contains platform-specific TradingView launch scripts (`launch_tv_debug.bat`, `.vbs`, `.sh`).

## Runtime Topology

```
Claude Code ←→ MCP Server (stdio) ←→ CDP (localhost:9222) ←→ TradingView Desktop (Electron)
```
