---
name: binance-trade-guardian
description: Autonomous position monitoring on a /loop cadence — each tick checks protection, liquidation distance, margin health, funding bleed, and breakeven/trail opportunities on open Binance positions, then ALERTS or PROPOSES. The only action it may take on its own is placing a missing protective stop, and only if the user pre-authorized that at start. Use when the user wants their open trades watched ("babysit my position", "watch my trades while I'm away").
---

# Binance Trade Guardian

The safe version of "Claude monitored its own trades and closed them" (which lost the
YouTuber $20): this guardian **watches and alerts**; it does not trade. It exists so an
open position is never unprotected and the user never misses a degradation — not to
make exit decisions for them.

## The charter (set once, at start)

Before the first tick, agree the charter with the user and restate it in the loop prompt:

- **Scope**: which symbol(s)/account(s) to watch (default: all open positions, account 1).
- **Stop policy**: the agreed stop price or rule per position (e.g. "the chart
  invalidation at 58,900", or "1.5×ATR(1h) below entry" via `binance_calc_position_size`'s
  ATR machinery / `binance_get_technicals`).
- **The ONE pre-authorizable action**: `binance_ensure_protective_stop` with that agreed
  stop, auto-confirmed **only if the user explicitly grants it here**. Default: not
  granted — the guardian proposes, the user confirms.
- Everything else is **propose-only, always**, regardless of what the user offers:
  closing, reducing, adding, widening a stop, or raising leverage are never automated.

Start the loop:

```
/loop 15m Run one tick of the binance-trade-guardian skill. Charter: watch BTCUSDC on
account 1; agreed stop 58,900; ensure-stop auto-confirm GRANTED/NOT GRANTED.
```

(15 minutes mirrors a human check-in cadence; use 5m only around news/volatility.)

## One tick

1. **Snapshot**: `binance_get_account_snapshot` + `binance_get_positions` +
   `binance_get_open_orders`. No positions and no orders → report "flat, nothing to
   guard" and end the tick.
2. **Protection check (the core)**: every position has a resting closePosition stop?
    - Missing + auto-confirm granted → `binance_ensure_protective_stop` with the
      charter's stop, `confirm:true`, and report loudly that it acted.
    - Missing + not granted → dry-run it and present the proposal as the tick's headline.
3. **Risk check**: `binance_get_risk_report` — liquidation distance < 15% or margin
   ratio degrading tick-over-tick → prominent alert (this is the "wake the user" case).
4. **Improvement proposals** (propose-only):
    - Unrealized profit ≥ 1R (one initial-risk unit) and stop still below entry →
      propose moving the stop to breakeven (`binance_modify_order` / cancel+re-place).
    - ≥ 2R → propose a trail (e.g. stop to 1R, or 1×ATR behind price).
    - Hold crossing a funding interval with negative carry (`binance_get_funding_rate`,
      accrued via `binance_get_income` type FUNDING_FEE) → flag the bleed in $.
5. **Log + report**: append one line per position to `strategies/guardian-log.md`
   (`tick 7 | BTCUSDC LONG 0.01 @60,000 | mark 61,200 +2.0% | stop 58,900 ✓ | liq −34% | funding −$0.40`),
   then report: headline (action taken / proposal / all-clear), changes since last tick,
   open proposals awaiting the user.

## Hard rules (do not regress)

- **Never close, reduce, open, or add to a position.** Not even "obviously right" exits —
  that decision is the user's. The −$20 lesson: an LLM improvising exits is gambling
  with someone else's money.
- **Never move a stop AWAY from price**, never remove one, never raise leverage past 3x.
- The auto-stop grant covers exactly `ensureProtectiveStop` at the charter's price —
  it is not a general trading authorization and does not carry to the next session.
- If the account is flat for 3 consecutive ticks, suggest ending the loop instead of
  burning ticks.
- Significant events (stop saved a position, funding bled badly) → flag for
  `binance-trade-review` so the playbook records them.
