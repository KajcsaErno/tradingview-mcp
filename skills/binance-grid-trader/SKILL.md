---
name: binance-grid-trader
description: Plan and run a grid (buy low / sell high across a range) on Binance — plan with binance_plan_grid, place the levels post-only, then maintain the cycle on a /loop tick (re-quote the opposite side as levels fill). Use when the user wants a grid bot, range-trading automation, or recurring buy-low-sell-high in a channel. Every placement is dry-run until the user confirms.
---

# Binance Grid Trader

A grid earns the **spacing between levels** every time price crosses a cell and comes
back: buy fills at level N, the sell one level up exits it, pocket the step. It only
works while price stays in the range — a breakout turns the grid into a one-sided bag.
Say this to the user up front.

> ⚠️ Real funds. Every placement is **dry-run until explicit confirm** — NEVER confirm on
> the user's behalf, including maintenance re-quotes. Standing rules: **3x leverage max**,
> **USDC pairs (BTCUSDC default)**, post-only entries. An unattended fully-live grid is
> **not supported by design** — the loop proposes, the user confirms. For unattended
> rehearsal, run under `PAPER_TRADING=1`.

## Step 0: Consult the playbook

Read `strategies/playbook.md` (if present) — apply *Standing rules* and *Confirmed
rules*; surface matching *Observations*.

## Step 1: Define and plan the grid

Establish with the user: **range** `[lower, upper]` (a real channel — check
`binance_get_technicals` / chart levels, not arbitrary numbers), **mode** (`long` /
`short` / `neutral`), **total size**, **account**.

- **Spacing rule (BTCUSDC):** rung spacing is fixed by range width — **$100 / $50 / $25**
  for wide / medium / tight ranges. Derive `count` from spacing
  (`count = rangeWidth/spacing + 1`), don't pick an arbitrary N.
- Plan it: `binance_plan_grid` (CLI `tv binance grid-plan`) — returns the levels with
  BUY/SELL classification around the current price, grid economics (profit per completed
  cycle net of 2× maker fee — with post-only the fee is 0), margin at 3x, and warnings.
- **Take the warnings seriously**: a negative `profitPerGridPct`, price outside the
  range, or a 3x breach each kill the plan — fix the inputs, don't override.

## Step 2: Initial placement (dry-run → confirm)

- **BUY side** (levels below price): `binance_place_ladder` over `[lower, highest BUY
  level]` with the BUY levels' share of the size. For a `long`-mode grid add `stop`
  just below `lower` (the grid's disaster stop) — remember the seed/stop gotcha: a stop
  with no position needs `seedQuantity: 'min'`.
- **SELL side**:
    - `long` mode — these REDUCE the long (hedge mode: same `positionSide LONG`). They can
      only rest once there's position; place them per-fill in maintenance (Step 3) or seed
      first.
    - `neutral` mode — a second `placeLadder` with `side SELL`, `positionSide SHORT` above
      price (its own stop above `upper`).
- Dry-run both ladders, show the combined plan + total margin, get **one explicit
  confirm**, then place. Verify with `binance_get_open_orders`.

## Step 3: Maintenance tick (the bot part — run via /loop)

```
/loop 15m Run one maintenance tick of the binance-grid-trader skill for <SYMBOL>, then stop.
```

Each tick:

1. `binance_get_account_trades` (since the last tick) + `binance_get_open_orders` —
   which levels filled?
2. For each **BUY fill at level i** → propose a SELL (reduce) at level i+1, same qty,
   post-only. For each **SELL fill at level i** → propose a BUY at level i−1.
3. Batch the proposals into ONE dry-run summary (`grid cycle: 2 fills → re-quote 2
   orders, +$X realized this cycle`) and ask the user to confirm. Under
   `PAPER_TRADING=1`, "confirm" anyway — nothing sends; the decisions get logged.
4. Check the grid is still valid: price inside the range? disaster stop still resting
   (`binance_ensure_protective_stop`)? If price broke out, STOP re-quoting and tell the
   user the grid is one-sided — recommend tearing down (`binance_cancel_all_orders`,
   dry-run first) rather than averaging into the breakout.
5. Track running totals (cycles completed, realized per cycle, fees=0 check) in
   `strategies/grid-log.md` — one line per tick.

## Step 4: Teardown

On request or breakout: `binance_cancel_all_orders` (dry-run → confirm), deal with any
remaining position explicitly (hand to `binance-position-manager`), final tally from
`binance_get_income` over the grid's lifetime, and run `binance-trade-review` so the
playbook learns from it.

## Hard rules (do not regress)

- Never re-quote past the range edges; never add levels to "catch up" with a breakout
  (that's Martingale — see the expectancy rules).
- Respect rate limits: max **199 rungs** per ladder, 300 orders/10s account cap.
- Total grid notional ≤ **3x** equity, always — re-check on every maintenance tick, not
  just at placement.
