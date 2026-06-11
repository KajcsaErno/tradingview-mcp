---
name: binance-ladder-entry
description: Scale into a Binance futures position with a laddered set of post-only limit orders across a price range, optionally seeded with a market order and guarded by a protective stop. Use when the user wants to DCA/scale into a position rather than enter all at once.
---

# Binance Laddered Entry

You are building a **scaled (laddered) entry** on Binance futures. The goal is to place N post-only limit rungs across a price range, size the whole thing to a risk budget, and guard it with a stop.

> ⚠️ These tools move **real funds**. Everything is DRY-RUN until `confirm:true` / `--confirm`. NEVER confirm on the user's behalf — always show the plan and get explicit approval first. Respect the user's standing rules: **3x leverage max**, **USDC pairs only (BTCUSDC default)**.

## Step 0: Consult the playbook

Read `strategies/playbook.md` (if present). Apply *Standing rules* and *Confirmed rules*
to the ladder you're about to plan; surface any matching *Observation* (same symbol or
pattern) for the user to weigh. Observations inform, they don't block.

## Step 1: Establish the setup

Clarify or infer from the user / chart:
- **Symbol** (default `BTCUSDC`), **side** (BUY=long, SELL=short), **account** (default `1`).
- **Range** `lo`–`hi` for the rungs (the accumulation zone).
- **Size**: total notional ($) OR total quantity, capped to ≤3x of the account.
- **Stop** price (protective), and whether to **seed** with a small market order to open immediately.

Pull context first:
- `binance_get_account_summary` (or `tv binance account-summary`) — available margin, equity.
- `binance_get_symbol_info` — tickSize/stepSize/minNotional (so rungs are valid).
- `binance_get_book_ticker` / `binance_get_ticker` — current price (rungs should rest below market for a BUY, above for a SELL).

## Step 2: Verify account config

- `binance_get_position_mode` — if Hedge Mode, you MUST pass `positionSide` (LONG/SHORT). If it's wrong, fix with `binance_set_position_mode`.
- Confirm leverage is **3x**: `binance_set_leverage` with `leverage:3` (per account). Never exceed 3x.

## Step 3: Size to risk (optional but recommended)

Use `binance_calc_position_size` with `entry` (≈ ladder midpoint), `stop`, and `riskPct`/`riskAmount`:
- It returns quantity, notional, required margin, and **warns if the plan breaches 3x or available margin**.
- Use the returned notional as the ladder's `totalNotional`.

## Step 4: Dry-run the ladder

Call `binance_place_ladder` (CLI: `tv binance ladder`) WITHOUT confirm:
```
symbol, side, lo, hi, count, totalNotional (or totalQuantity),
positionSide (if hedge), seedQuantity (optional), stop (optional)
```
Review the returned `ladder_preview`: rung count, avg price, total quantity/notional, `skippedBelowMin`, and the seed/stop legs.

## Step 5: Present and confirm

Show the user: range, rungs, per-order size, **average fill**, total notional, **risk to stop** (and R multiples to any targets), effective leverage. Ask for explicit approval.

## Step 6: Place and verify

On approval, re-call with `confirm:true`. The function places seed → stop → rungs (batched 5/request). Then verify:
- `binance_get_open_orders` — confirm rung count + the algo stop are resting.
- `binance_get_positions` — confirm the seed opened the position.
- Report order ids, what filled, and any rungs that errored.

## Notes

- All rungs are **post-only (GTX)** = 0 maker fee; they only fill on a pullback into the zone (no fill if price runs away — that's expected, not an error).
- The stop is `closePosition` — it guards the whole position regardless of how many rungs fill.
- To replicate across accounts, see the `binance-multi-account-mirror` skill (sizes by balance ratio).
