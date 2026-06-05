---
name: binance-account-review
description: Produce a health, exposure, and cost report across one or more Binance accounts — balances, positions, liquidation distance, funding, and realized PnL. Use when the user asks "where do I stand", "how exposed am I", or wants an account check-up.
---

# Binance Account Review

You are producing a **read-only** account health report across the user's Binance accounts. No orders are placed. Default to the accounts the user has configured (`1`, `2`, … — each `--account`/`account` selects a key set). Default symbol focus: `BTCUSDC`.

## Step 1: Per-account snapshot

For each account:
- `binance_get_account_summary` — wallet/margin balance, unrealized PnL, available margin, **margin ratio**.
- `binance_get_risk_report` — per-position notional, **liquidation price + distance-to-liq %**, % of equity, gross exposure, exposure/equity.
- `binance_get_positions` — open positions (side, qty, entry, mark, uPnl, leverage).
- `binance_get_open_orders` — resting orders + algo stops (flag any position **without** a protective stop).

## Step 2: Cost & performance context

- `binance_get_funding_rate` (per held perp) — are they paying or receiving funding? Multiply by notional for the ~8h cost.
- `binance_get_income` (e.g. `incomeType: REALIZED_PNL` / `FUNDING_FEE` / `COMMISSION`) over a recent window — realized PnL, funding paid, fees.

## Step 3: Risk checks

Flag anything that needs attention:
- A position with **no protective stop** (suggest `binance-position-manager` / `ensure-stop`).
- **Leverage > 3x** or exposure/equity > 3x (violates the user's 3x rule).
- **Margin ratio** elevated / **distance-to-liquidation** small.
- Net funding bleeding a multi-day hold.

## Step 4: Report

Present a compact, scannable summary:

```
Account 1 — equity $X, uPnL $Y, margin ratio Z%
  BTCUSDC LONG 1.6 @ 60,000 | mark 59,000 | liq 45,000 (24% away) | 1.6x equity | stop ✅/❌
  funding: −0.003% (receiving) | realized PnL (7d): −$143 | fees: ~$0 (post-only)
Account 2 — …
```

Then: top risks (ranked), and concrete next actions (e.g., "Account 1 LONG has no stop — arm one at 58,900"). Do NOT place anything — recommend, and hand off to a money-moving skill only on explicit user request.
