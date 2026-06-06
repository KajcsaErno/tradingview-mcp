# Binance Futures Order/Rate Limits Notes (2026-06-06)

Source: user-provided limits captured for execution planning.

## Limits to plan around

- Open orders: up to 10,000 per user account across USD-M + COIN-M futures.
- Order rate limits (default):
  - 1,200 orders/minute per account/sub-account.
  - 300 orders per 10-second window.
- Conditional orders sub-limit: 200 open conditional orders per user.
- Per-symbol open orders: often capped at 200 open orders per symbol/user.
- Minimum notional per futures order: typically at least 5 USDT equivalent.

## Practical implications for a ladder + stop on one symbol

- If per-symbol cap is 200 and one protective stop is open, max ladder rungs is 199.
- A `seed` market order can be used to open a tiny position so a close-position stop can rest immediately.
- With 199 rungs, each account remains under 300 orders/10s and 1,200 orders/min by order count.
- Keep conditional orders usage low (one stop per account is far below the 200 conditional cap).

## Hard spacing rule (BTCUSDC)

- Preferred spacing between ladder prices is fixed priority: `100` USD, else `50`, else `25`.
- Selection logic for a range width `W = hi - lo`:
  - Use `100` if `W >= 100`
  - Else use `50` if `W >= 50`
  - Else use `25` if `W >= 25`
  - Else do not build a multi-rung ladder (single order only).
- Rung count from spacing: `count = floor((hi - lo) / spacing) + 1`.
- Example (`59,000` to `60,000`): width `1,000` => spacing `100` => `11` rungs.

## Current plan snapshot

- Symbol range: 59,000 to 60,000 (equal spacing).
- Account 1 notional: 200,000.
- Account 2 notional: 100,000.
- Stop: 57,900.
- Suggested rung count under the hard spacing rule: 11 (plus one stop order per account).

