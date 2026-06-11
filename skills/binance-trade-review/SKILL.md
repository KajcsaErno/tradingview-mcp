---
name: binance-trade-review
description: Post-trade review of a Binance symbol/window — realized PnL, funding paid, commissions, and the fill/order history — then update the trading playbook with what the data showed. Use when the user asks "how did that trade do" or wants a performance breakdown of recent activity.
---

# Binance Trade Review

You are producing a **read-only** performance review of recent Binance activity for a symbol (default `BTCUSDC`) and account (default `1`) over a time window. No orders are placed.

## Step 1: Gather the record

- `binance_get_income` — the core. Pull over the window; the response includes a **per-type summary**. Key types:
  - `REALIZED_PNL` — actual booked profit/loss.
  - `FUNDING_FEE` — funding paid/received over the hold.
  - `COMMISSION` — fees (should be ~0 if entries were post-only/maker).
- `binance_get_order_history` — all orders (filled / cancelled / expired) for the symbol.
- `binance_get_account_trades` — individual fills (price, qty, side, fee, maker/taker).
- `binance_get_positions` — any still-open exposure to separate realized from unrealized.

## Step 2: Reconstruct the trades

From fills + income, summarize:
- Net **realized PnL** for the window, and gross vs. costs (funding + commission).
- **Average entry/exit**, total volume traded, number of fills.
- **Maker ratio** — were entries actually post-only (0 fee) as intended?
- Funding as a share of PnL (did a multi-day hold bleed funding?).

## Step 3: Report

```
BTCUSDC — account 1 — last <window>
  Realized PnL:   $X
  Funding:        $Y  (paid/received)
  Commissions:    $Z  (maker ratio NN%)
  Net:            $X + Y − Z
  Fills: N  | avg entry  | avg exit  | volume
  Still open: <position or none>
```

## Step 4: Lessons (brief, factual)

Call out what the data shows — e.g. "fees were ~$0 (post-only worked)", "funding cost $X over the hold — consider shorter holds", "realized loss was within the planned stop risk". Keep it to what the numbers support; don't moralize. The user is a learning trader — expand any abbreviation inline on first use (e.g. PnL (Profit and Loss)).

## Step 5: Update the playbook

Carry the Step-4 lessons into `strategies/playbook.md` so future trades start from them
(the entry skills read this file before planning):

1. **Read the playbook first.** Follow its editing rules — they are part of this step.
2. For each data-backed lesson, check whether it already exists:
    - **Already an Observation** → promote it to *Confirmed rules*, appending this
      review's date + evidence to the entry.
    - **Already a Confirmed rule** → if this review adds something (new magnitude, new
      symbol), append the evidence; otherwise leave it.
    - **New** → append to *Observations* as one line:
      `- (YYYY-MM-DD, SYMBOL) <lesson> — evidence: <the number that proves it>.`
3. **Write only what Step 4 actually found.** A review with nothing noteworthy adds
   nothing — say so instead of inventing a lesson.
4. Never touch the *Standing rules* section, and never write a lesson that would relax
   safety defaults (leverage, confirm gate, post-only) — the playbook only adds caution.
5. Show the user the diff of what was added or promoted.
