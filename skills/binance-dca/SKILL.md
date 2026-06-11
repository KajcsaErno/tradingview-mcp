---
name: binance-dca
description: Recurring fixed-amount accumulation (DCA — Dollar-Cost Averaging) of a symbol on Binance, driven by the harness scheduler (/schedule or /loop) with hard caps and a per-run log. Use when the user wants to "buy $X of BTC every day/week" or set up automatic accumulation. Each buy is post-only; nothing is placed without the authorization the user wrote into the schedule.
---

# Binance DCA (recurring buy)

DCA (Dollar-Cost Averaging) buys a **fixed $ amount on a fixed cadence** regardless of
price — more units when cheap, fewer when expensive. The "bot" is the harness scheduler
(`/schedule` cron routine, or `/loop` for short horizons) running this skill's buy step;
there is no resident process.

> ⚠️ Real funds. The dry-run→confirm rule still applies: in an interactive session, the
> user confirms each buy. In a **scheduled routine**, the user's pre-authorization must
> be written INTO the routine prompt itself (exact symbol, exact $ amount, the caps
> below) — that written grant is what `confirm:true` executes against. Never widen it.
> Rehearse new schedules under `PAPER_TRADING=1` for at least a few runs first.

## Step 0: Consult the playbook

Read `strategies/playbook.md` (if present) — *Standing rules* and *Confirmed rules* apply.

## Step 1: Define the plan (once)

Agree with the user, then write it into the schedule prompt verbatim:

- **Symbol** — USDC pairs only; default `BTCUSDC`. **Market** — `spot` for pure
  accumulation (no leverage, no funding); `futures` only if they explicitly want it.
- **Amount per buy** ($, fixed — never scales up; scaling after losses is Martingale).
- **Cadence** — e.g. daily 09:00, weekly Monday. Set up via the `/schedule` skill;
  `/loop 1h`-style only for short experiments.
- **Caps (hard)**: max $ per buy, total budget or end date, and "skip if available
  balance < amount" — all stated in the routine prompt.

## Step 2: One buy (each scheduled run)

1. `binance_get_balance` — enough quote available? If not, log SKIPPED and stop.
2. `binance_get_book_ticker` → place `binance_place_order` LIMIT **post-only at the
   bid**, `quantity = amount / bid` (snapping handles step size). Maker fill = 0 fee.
   Only use MARKET (`allowTaker:true`) if the user explicitly chose "fill at any cost".
3. If the **previous** run's order is still unfilled (`binance_get_open_orders`):
   re-price it to the current bid with `binance_modify_order` before placing the new
   one — don't let stale orders stack.
4. Append one line to `strategies/dca-log.md`:
   `2026-06-11 BTCUSDC bought 0.0009 @ 61,420 ($55) | total: 0.0142 BTC, avg $58,930 | run 14`
5. Report: this run + running totals (units, total spent, average cost vs current price).

## Step 3: Review (monthly or on request)

Summarize the log: total accumulated, average cost vs spot, what lump-sum at run 1 would
have done (honesty check — DCA isn't always better), fees paid (should be ~0). Feed
anything notable into `strategies/playbook.md` via the trade-review rules.

## Hard rules (do not regress)

- **Fixed amount, fixed cadence.** Never "double up because price dropped" — that's
  Martingale, explicitly rejected in the expectancy framework.
- Never exceed the caps written in the schedule prompt; a missing cap means ask, not assume.
- USDC pairs only; spot needs no leverage — never silently switch a DCA to futures.
