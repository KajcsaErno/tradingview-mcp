---
name: binance-position-manager
description: Manage an open Binance futures position — ensure a protective stop, add or scale take-profits, amend resting orders, and trail the stop. Use when the user wants to protect, adjust, or take profit on an existing position.
---

# Binance Position Manager

You are managing an **already-open** Binance futures position (no new entry). Focus on protection and exits.

> ⚠️ Real funds. DRY-RUN until explicit `confirm`. Standing rules: **3x max**, **USDC pairs (BTCUSDC)**. Default `account 1` unless told otherwise.

## Step 0: Consult the playbook

Read `strategies/playbook.md` (if present). Apply *Standing rules* and *Confirmed rules*
to how you manage this position (e.g. a confirmed funding-bleed rule argues for tighter
exits on multi-day holds); surface matching *Observations* for the user to weigh.

## Step 1: Assess the position

- `binance_get_positions` — side, qty, entry, mark, uPnl, leverage.
- `binance_get_open_orders` — what's already resting (limits + algo stops/TPs).
- `binance_get_risk_report` — liquidation distance, % of equity.
- `binance_get_account_summary` — margin headroom.

## Step 2: Ensure it's protected (do this first)

- `binance_ensure_protective_stop` (CLI: `tv binance ensure-stop`) — idempotent: places a `closePosition` STOP_MARKET only if one is missing. Dry-run first, then confirm. This is the single most important step if the position is unguarded.

## Step 3: Set / scale take-profits

Pick the exit structure with the user:
- **One-shot** — if attaching a full bracket of exits, `binance_place_bracket` with `--noEntry` (stop + take-profits on the existing position).
- **Individual TPs** — `binance_place_order` reduce-only / closePosition TAKE_PROFIT_MARKET (or post-only LIMIT reduce-only for maker exits) at each target. In Hedge Mode use the correct `positionSide`.
- Scale out (e.g. ⅓ at T1, ⅓ at T2, trail the rest) per the user's plan.

## Step 4: Adjust resting orders

- `binance_modify_order` (CLI: `tv binance modify`) — amend a rung/TP price or quantity in place (no cancel+replace). Requires side + new price + new qty.
- `binance_cancel_order` / `binance_cancel_algo_order` — remove a specific order/stop.

## Step 5: Trail the stop (on request)

After T1 fills, move the stop to breakeven or trail it: cancel the old `closePosition` stop (`cancel-algo`) and `ensure-stop` at the new level. Confirm each move.

## Step 6: Verify & report

`binance_get_open_orders` + `binance_get_positions` to confirm the new protection/exit structure. Report: stop level, take-profit ladder, distance-to-liq, and remaining size.

## Guardrails

- Never leave a position **larger** and **less** protected than you found it.
- Don't widen a stop further from price without the user explicitly asking.
- Reduce-only / closePosition for all exits so you never accidentally flip the position.
