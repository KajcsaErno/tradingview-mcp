---
name: chart-to-binance-trade
description: Read levels and bias off the live TradingView chart, then translate them into a risk-sized Binance futures order or ladder with a protective stop. Use when the user wants to act on a chart setup by placing a real Binance trade.
---

# Chart → Binance Trade

You are bridging the two halves of this project: read the **live TradingView chart** (via CDP) to find the trade levels, then execute on **Binance** (via signed REST). TradingView is analysis only; Binance is execution.

> ⚠️ Binance tools move **real funds** — DRY-RUN until explicit `confirm`. Standing rules: **3x max leverage**, **USDC pairs only (BTCUSDC)**. Note the chart symbol (often a reference feed like `BITSTAMP:BTCUSD`) may differ from the **traded contract** (`BTCUSDC` on Binance) — always execute on the Binance contract, and sanity-check prices against `binance_get_ticker`.

## Step 1: Read the chart setup

- `chart_get_state` — current symbol, timeframe, indicators.
- `quote_get` + `data_get_ohlcv` (summary) — current price and recent range.
- `data_get_pine_lines` / `data_get_pine_labels` — custom levels (support/resistance, targets).
- `draw_list` + `draw_get` — any hand-drawn levels (entry zones, stop, targets).
- `data_get_study_values` — indicator readings for bias.
- `capture_screenshot` — visual confirmation.

Synthesize: **bias** (long/short), **entry zone**, **stop** (invalidation), **targets**.

## Step 2: Map levels to the Binance contract

- Decide the Binance symbol (default `BTCUSDC`) and confirm it with `binance_get_ticker` / `binance_get_book_ticker`.
- If the chart feed price differs materially from Binance, adjust the levels to Binance's price (use Binance as the source of truth for execution).
- `binance_get_symbol_info` — tick/step/minNotional.

## Step 3: Size to risk (respect 3x)

- `binance_get_account_summary` — equity / available margin.
- `binance_calc_position_size` with the chart's `entry` + `stop` and the user's risk % → quantity, notional, required margin, and 3x/ margin warnings.
- Ensure leverage is **3x** (`binance_set_leverage`) and position mode is correct (`binance_get_position_mode` / `binance_set_position_mode`).

## Step 4: Choose execution shape

- **Single entry at a level** → `binance_place_order` (post-only LIMIT) + a `binance_ensure_protective_stop` at the chart's stop.
- **Scale into a zone** → `binance_place_ladder` across the entry zone, with `stop` = chart invalidation (see the `binance-ladder-entry` skill).
- **Entry + stop + targets in one shot** → `binance_place_bracket` (stop = invalidation, take-profits = chart targets).

Always **dry-run first**.

## Step 5: Present, confirm, execute

Show the user the chart-derived plan side-by-side with the order plan: entry(s), stop, targets, size, avg fill, risk, R multiples, leverage. Get explicit approval, then re-run with `confirm:true`.

## Step 6: Mirror the levels back onto the chart (optional)

So the user can see the live trade against price, draw the executed levels with `draw_shape` (horizontal_line) — entry zone, stop, targets — following the user's drawing/color preferences (warm = resistance/targets above, cool = support/entry below).

## Step 7: Verify

`binance_get_open_orders` + `binance_get_positions` (+ `binance_get_account_snapshot`) to confirm the trade is on and protected. Report order ids and the active stop.
