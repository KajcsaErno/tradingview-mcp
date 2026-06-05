---
name: binance-trade-review
description: Post-trade review of a Binance symbol/window — realized PnL, funding paid, commissions, and the fill/order history. Use when the user asks "how did that trade do" or wants a performance breakdown of recent activity.
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
