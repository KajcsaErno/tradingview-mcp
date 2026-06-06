# AGENTS.md — Architecture & Patterns for AI Code Agents

## System Architecture (Three-Layer Fan-Out)

This codebase follows a strict **three-layer fan-out** pattern from a single core:

```
MCP Server  ────┐
                ├──→ src/core/*  ──→ src/connection.js ──→ CDP (localhost:9222) ──→ TradingView
CLI Router  ────┤
(src/cli/*)──────┤
                └──→ Public API: src/core/index.js
```

**Each layer is thin:**

- **`src/core/*.js`** (modules: chart, data, pine, replay, drawing, alerts, batch, indicators, pane, tab, ui, watchlist, capture, health, stream, binance)
  - Pure async functions that build JavaScript expressions to evaluate
  - **Every function takes optional `_deps` parameter** — this is the dependency injection hook for testing
  - Call `evaluate()` or `evaluateAsync()` to send JS to TradingView, then parse/return the result
  - Apply `safeString()` to ALL user inputs before interpolating into JS strings
  - Apply `requireFinite()` to all numeric inputs before they reach TV APIs that persist state

- **`src/tools/*.js`** (MCP adapters)
  - Call matching `src/core/*.js` function
  - Wrap result with `jsonResult()`
  - Register with `server.tool(name, description, zodSchema, handler)`
  - Uniform error handling: `{ success: false, error: msg }`

- **`src/cli/commands/*.js`** (CLI adapters)
  - Register with `router.register(name, { description, options, handler })`
  - Parse flags → call same `src/core/*.js` function
  - Print JSON to stdout (errors to stderr)

- **`src/connection.js`** (singleton CDP bridge)
  - `getClient()` — auto-reconnect with exponential backoff (5 retries)
  - `evaluate(expr)` — `Runtime.evaluate` in TradingView page
  - `evaluateAsync(expr)` — same, but awaits Promises
  - `safeString(str)` — JSON.stringify-based escape for all user values
  - `requireFinite(n, name)` — throws if NaN, Infinity, or non-numeric

- **`src/wait.js`** (chart state polling)
  - `waitForChartReady(expectedSymbol?, expectedTf?, timeout?)` — polls DOM for readiness
  - Call after any chart mutation (setSymbol, setTimeframe, etc.)

## Security Model: The Two Input Validators

**CRITICAL: Never interpolate user input directly into JS strings.**

Every `src/core/*.js` function that takes user input must apply one of these:

```javascript
// For strings (symbols, indicator names, text, dates) — ALWAYS safeString()
const symbol = safeString(symbol);  // produces: "AAPL" (with quotes, properly escaped)
await evaluate(`chart.setSymbol(${symbol})`);

// For numbers (lengths, prices, timestamps) — ALWAYS requireFinite()
const length = requireFinite(20, 'MA length');  // returns: 20 (throws if NaN or Infinity)
await evaluate(`RSI(${length})`);
```

**In tests:** Mock the `_deps` parameter and inspect the actual JS expression strings to catch injection regressions:

```javascript
const { _deps, evaluate } = mockDeps();
await setSymbol({ symbol: "'); alert('xss", _deps });
const js = evaluate.calls[0];  // Inspect the generated JS
assert(js.includes('"\\u0027); alert('));  // Verify it's escaped
```

## Binance module (separate integration — NOT CDP)

`src/core/binance.js` is an independent module that talks to the Binance REST API (signed HMAC-SHA256). It does **not** use CDP, `evaluate()`, `safeString()`, or `KNOWN_PATHS`. It is fully wired through all three layers (45 tools / 45 CLI subcommands):

- **Core:** `src/core/binance.js`
- **MCP:** `src/tools/binance.js` — `registerBinanceTools(server)`, registered in `src/server.js`. (Binance **is** exposed over MCP.)
- **CLI:** `src/cli/commands/binance.js` — `npm run tv -- binance <subcommand>`.

**DI shape differs from the CDP modules:** instead of `{ evaluate, waitForChartReady }`, Binance functions take `_deps = { fetch, now, keys, sleep }`. Tests in `tests/binance.test.js` inject these (a mock `fetch`, fixed `now`, fake `keys`, and a no-op `sleep`) to assert on the exact requests built — **no network, no real keys**. Run `npm run test:binance` (104 tests).

**Invariants every Binance contributor must preserve:**
- **Credentials:** `BINANCE_API_KEY`/`BINANCE_API_SECRET` (account "1"), plus `_2`/`_3`… for more accounts, from the environment or a gitignored `.env` (minimal loader, never overwrites existing env vars). See `.env.example`.
- **Per-account key routing:** every signed/account-specific function takes `account` and resolves keys via `resolveDeps(account, _deps)` before calling `signedRequest({ …, _deps: deps })`. Omitting `account` silently falls back to account 1 — a dangerous bug (acting on the wrong account). The `tests/binance.test.js` "account routing" suite guards this; CLI/MCP wrappers must forward `account`.
- **Dry-run by default:** all money-moving functions (`placeOrder`, `placeLadder`, `placeBracket`, `modifyOrder`, `ensureProtectiveStop`, `cancelAllOrders`, `mirrorOrder`, `mirrorBracket`, `transfer`) return a preview and send nothing unless `confirm: true`. Never auto-confirm.
- **Post-only by default:** LIMIT → `GTX` (futures) / `LIMIT_MAKER` (spot); taker-only types require `allowTaker`.
- **Hedge mode / precision / algo routing / clock-skew & 429-backoff:** see the "Binance module" section in `CLAUDE.md` for the full list — keep them intact.
- **Validation:** numeric inputs go through `requireFinite()`; price/qty snap to tickSize/stepSize.

When adding a Binance tool, follow the same 4-step checklist below but use the `{ fetch, now, keys, sleep }` DI shape and add the route/assertion to `tests/binance.test.js` (not `sanitization.test.js`, which is for CDP injection).

## Core Module Patterns

### Function Structure with Dependency Injection

```javascript
// src/core/chart.js
import { evaluate as _evaluate, safeString } from '../connection.js';
import { waitForChartReady as _waitForChartReady } from '../wait.js';

function _resolve(deps) {
  return {
    evaluate: deps?.evaluate || _evaluate,
    waitForChartReady: deps?.waitForChartReady || _waitForChartReady,
  };
}

export async function setSymbol({ symbol, _deps }) {
  const { evaluate, waitForChartReady } = _resolve(_deps);
  // Use the resolved dependences
  await evaluate(`chart.setSymbol(${safeString(symbol)})`);
  return { success: true, symbol };
}
```

**Why `_deps`?** Lets tests inject mock functions without touching live TradingView.

Note on streaming modules: `src/core/stream.js` implements long-running poll-and-diff "stream" functions (quote, bars, values, lines, labels, tables, all-panes) that emit JSONL to stdout when data changes. These functions are invoked directly by the CLI `tv stream <subcommand>` handlers and do not return a JSON object — they run until interrupted (Ctrl+C). The stream module writes a short compliance/header message to stderr on start.

### Typical Return Shape

```javascript
{ success: true, symbol: "AAPL", chart_ready: true }
// or on error:
{ success: false, error: "Chart API not available" }
```

## Adding a New Tool — The Checklist

### 1. Add core function in `src/core/<domain>.js`

- Accepts an options object with `_deps` parameter: `async function myFunc({ arg1, arg2, _deps })`
- Use `_resolve(_deps)` to get dependencies
- Apply `safeString()` to every user string
- Apply `requireFinite()` to every user number
- Use `CHART_API` constant: `'window.TradingViewApi._activeChartWidgetWV.value()'`
- Return `{ success: true, ... }` or throw (MCP layer catches errors)
- Call `waitForChartReady()` after mutations

```javascript
export async function myFunc({ param, _deps }) {
  const { evaluate, waitForChartReady } = _resolve(_deps);
  const result = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      chart.doSomething(${safeString(param)});
      return 'ok';
    })()
  `);
  await waitForChartReady();
  return { success: true, result };
}
```

### 2. Add MCP tool in `src/tools/<domain>.js`

```javascript
import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/chart.js';

export function register<Domain>Tools(server) {
  server.tool('my_tool_name', 'Human description', {
    param: z.string().describe('What is this?'),
  }, async ({ param }) => {
    try { return jsonResult(await core.myFunc({ param })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
```

Then register in `src/server.js`:
```javascript
import { register<Domain>Tools } from './tools/<domain>.js';
// ...
register<Domain>Tools(server);
```

### 3. Add CLI command in `src/cli/commands/<domain>.js`

```javascript
import { register } from '../router.js';
import * as core from '../../core/chart.js';

register('my-command', {
  description: 'What this does',
  options: { param: { /*...*/ } },
  handler: (opts, positionals) => core.myFunc({ param: opts.param }),
});
```

### 4. Test it

- **Unit test**: `src/core/myFunc` with mock `_deps` in `tests/sanitization.test.js` (verify JS expression strings)
- **CLI test**: Router test in `tests/cli.test.js`
- **E2E test**: Live TradingView in `tests/e2e.test.js` (requires `npm run test:e2e`)

## Undocumented TradingView APIs (KNOWN_PATHS)

These are discovered via live probing. **They can break on any TradingView update.**

Located in `src/connection.js`:

```javascript
const KNOWN_PATHS = {
  chartApi: 'window.TradingViewApi._activeChartWidgetWV.value()',
  chartWidgetCollection: 'window.TradingViewApi._chartWidgetCollection',
  replayApi: 'window.TradingViewApi._replayApi',
  alertService: 'window.TradingViewApi._alertService',
  mainSeriesBars: 'window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars()',
  // ... more paths
};
```

**To debug API changes:**
1. Run `window.TradingViewApi` in Chrome DevTools (TradingView must be running with `--remote-debugging-port=9222`)
2. Explore the object tree to find new paths
3. Add to `KNOWN_PATHS` and verify with `await getChartApi()` (see `src/connection.js` line 147)

## Testing Strategy

### Unit Tests (No TradingView Required)

**File**: `tests/sanitization.test.js`, `tests/cli.test.js`, `tests/pine_analyze.test.js`

```bash
npm run test:unit
```

Use `mockDeps()` to capture generated JS expressions:

```javascript
const { _deps, evaluate } = mockDeps();
await setSymbol({ symbol: "AAPL", _deps });
assert(evaluate.calls[0].includes('setSymbol("AAPL")'));
```

### E2E Tests (Requires Live TradingView)

**File**: `tests/e2e.test.js`

```bash
# Start TradingView first with:
/path/to/TradingView --remote-debugging-port=9222

# Then:
npm run test:e2e
```

Connect to localhost:9222, run real functions, verify real results.

## Development Workflow

### Start the MCP Server

```bash
npm start
# Prints a startup notice to stderr (e.g. "⚠  tradingview-mcp  |  Unofficial tool. Not affiliated with TradingView Inc. or Anthropic.")
# Listens on stdin/stdout for MCP requests
```

### Test via CLI

```bash
npm run tv -- state
npm run tv -- symbol AAPL
npm run tv -- ohlcv --summary
```

Note: stream subcommands (e.g. `npm run tv -- stream quote -i 300`) are special — they write newline-delimited JSON (JSONL) to stdout continuously and do not return a single JSON payload. They print a short compliance/header message to stderr on start and run until interrupted (Ctrl+C).

All output is JSON (piped to stdout), errors to stderr, exit codes: 0=ok, 1=error, 2=connection failure.

### Run Tests

```bash
npm test                # e2e + pine_analyze
npm run test:unit       # unit tests only (no TradingView)
npm run test:cli        # router tests
npm run test:all        # everything
npm run test:verbose    # spec reporter
```

### Debugging

1. **Check connection**: `tv health`
   - `tv_discover` reports which known TradingView API paths are present and enumerates method names exposed on those objects.
   - `tv_ui_state` dumps UI panel visibility and commonly-used button labels/locations.
   - `tv_launch` can attempt to start TradingView with `--remote-debugging-port` set (options: `port`, `kill_existing`, default `kill_existing=true`). The launcher auto-detects common install locations per platform and waits briefly for CDP to become available.
2. **See what's on chart**: `tv state` → dumps symbol, timeframe, all indicator IDs
3. **Read Pine errors**: `tv pine errors`
4. **Inspect DOM**: Open Chrome DevTools at `localhost:9222`, inspect **page tab**
5. **Check for API changes**: Explore `window.TradingViewApi` in console

## Context Management for AI Agents

The codebase is designed to minimize token usage:

| Technique | How It Works |
|-----------|------------|
| `study_filter: "ProfileName"` | On pine tools, filter to one indicator instead of scanning all |
| `summary: true` | On data_get_ohlcv, get stats + last 5 bars instead of all bars |
| Deduplication | Pine lines/boxes auto-deduplicate price levels |
| Capped results | Pine labels capped at 50 per study; trades at 20 per request |
| Entity IDs | Chat state once (`chart_get_state`), reference IDs for subsequent calls |

**Typical workflow output sizes:**
- `quote_get`: ~200 bytes
- `data_get_study_values`: ~500 bytes (all indicators)
- `data_get_ohlcv` (summary): ~500 bytes
- `data_get_ohlcv` (100 bars): ~8 KB
- `data_get_pine_lines`: ~1-3 KB per study
- Screenshot: ~300 bytes (returns file path, not image data)

## Key Decisions

### Why ESM + Node.js native tools?

- No build step, faster iteration
- `node:test` for testing (no Jest/Mocha overhead)
- `node:util parseArgs` for CLI routing (zero dependencies beyond MCP SDK and chrome-remote-interface)

### Why `_deps` parameter for DI?

- Lets tests inspect generated JS expressions without mocking `evaluate` globally
- Unit tests can assert that `safeString()` was applied to user inputs
- Isolated testing without a running TradingView instance

### Why `safeString()` + `requireFinite()` everywhere?

- All TradingView APIs are accessed via dynamic JS evaluation (CDP Runtime.evaluate)
- User input must never be concatenated directly into code strings
- Injection bugs are silent: the JS executes, but with attacker-controlled data
- `safeString()` uses JSON.stringify — it's the standard JS escape mechanism

### Why poll `waitForChartReady()` after mutations?

- TradingView is asynchronous; mutations don't complete instantly
- Polling DOM for loader spinners + bar count stability + symbol match ensures the chart actually updated
- Prevents race conditions where subsequent commands run before the chart is ready

## Repository Conventions

- **Files**: Modules are named after the TradingView feature (chart, data, pine, replay, drawing, etc.)
- **Functions**: One exported function per logical operation (setSymbol, setTimeframe, manageIndicator)
- **Error messages**: Plain English, mention the expected API path if debugging needed
- **Comments**: Explain _why_ a thing is done (especially for undocumented TV API hacks)

## Decision Tree — When to Add a Tool

1. **Can it be done via existing tools?** Use composition instead (e.g., call chart_set_symbol then waitForChartReady)
2. **Does it require new JavaScript evaluation?** Add to src/core
3. **Does it take user input?** Add safeString/requireFinite validators
4. **Is it a new domain?** Create a new src/core/*.js file
5. **Need CLI access?** Add src/cli/commands/*.js subcommand
6. **Need MCP access?** Register in src/tools/*.js and src/server.js

