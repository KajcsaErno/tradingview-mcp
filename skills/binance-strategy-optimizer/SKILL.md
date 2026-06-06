---
name: binance-strategy-optimizer
description: Self-iterating strategy search over the Binance backtester — sweep symbols × timeframes × the 9 built-in strategies, rank by a risk metric, validate the leader out-of-sample, and keep a best-so-far leaderboard. Use when the user wants to "find a profitable strategy", "optimize a strategy", or run the looping "build a better strategy every 5 minutes" workflow. Read-only: NO orders are placed.
---

# Binance Strategy Optimizer (loop)

This is the local-backtester equivalent of the "loop every 5 minutes for an hour to build
a better strategy" workflow. It uses **your own** `tv binance` backtester — no external MCP
server, no chart, **no orders ever placed**. All math runs off klines.

The 9 strategies: `rsi`, `bollinger`, `macd`, `ema_cross`, `supertrend`, `donchian`,
`rsi_pullback` (long-only), `keltner`, `triple_ema`.

## Search space

- **Symbols:** the user's `watchlist` from `rules.json`, else `BTCUSDC`. USDC pairs only (user rule).
- **Timeframes:** default `15m,1h,4h` (add `1d` for swing). Lower TFs need more bars.
- **Strategies:** all 9 (via `compare-strategies`, which backtests them off **one** klines fetch).
- **Ranking metric:** default `sharpe` (risk-adjusted). Alternatives: `calmar`, `totalReturnPct`,
  `profitFactor`, `winRatePct`, `maxDrawdownPct`. Ask the user if they care; default to `sharpe`.

## One iteration (do this each loop tick)

1. **Pick the next combo to explore.** Read `strategies/optimizer-leaderboard.json` (create
   `{"runs":[],"best":[]}` if absent). Choose a `symbol × interval` pair **not yet tried this
   session**, or the next in rotation. Each tick explores a fresh combo — don't re-run the same
   one (klines barely move in 5 min; re-running wastes the tick).

2. **Rank all 9 strategies on that combo:**
   ```
   tv binance compare-strategies -s <SYMBOL> -i <INTERVAL> --sortBy sharpe -n 1000
   ```
   (`--noShort` if the user wants long-only / spot.) Note the leader and its metrics.

3. **Validate the leader out-of-sample** (this is the anti-"pretty equity curve" check the
   video skips — your backtester has it):
   ```
   tv binance walk-forward -s <SYMBOL> --strategy <LEADER_KEY> -i <INTERVAL> -n 1000
   ```
   Read the **overfitting verdict** (ROBUST / MODERATE / WEAK / OVERFITTED / UNPROFITABLE /
   INCONCLUSIVE). **Discard anything not ROBUST or MODERATE** — a high in-sample Sharpe that
   fails walk-forward is curve-fit, not edge.

4. **Optional confluence sanity-check:** `tv binance multi-timeframe -s <SYMBOL>` — does the
   higher-TF bias agree with the strategy's direction? Note disagreement; don't hard-gate on it.

5. **Update the leaderboard.** Append the run; if the validated leader beats the current
   best-for-that-symbol (by the ranking metric AND passing walk-forward), update `best`. Write
   the file back. Keep `best` to the top ~5.

6. **Report a one-line tick summary**, e.g.:
   `SOLUSDC 4h → supertrend: Sharpe 1.8, +79%, maxDD 18%, walk-forward MODERATE ✅ (new #2)`

## Running it as a loop

Drive it with the `/loop` skill, mirroring the video's cadence:

```
/loop 5m Run one iteration of the binance-strategy-optimizer skill, then stop.
```

Stop after ~1 hour (≈12 ticks) or when the user says so. For a quick one-shot (no loop), just
run steps 1–6 once over the whole watchlist × timeframe grid in a single pass.

## Output: final leaderboard

When the loop ends (or on request), present the `best` list ranked, each row:

```
#1  ETHUSDC 4h  triple_ema   Sharpe 2.1 | +100% | maxDD 22% | PF 1.9 | 41 trades | WF ROBUST
#2  SOLUSDC 4h  supertrend   Sharpe 1.8 | +79%  | maxDD 18% | PF 1.6 | 50 trades | WF MODERATE
...
```

Then: which one you'd actually trade and **why** (favor ROBUST verdict + reasonable trade
count + drawdown you can stomach), and a caution that backtest ≠ live.

## Hard rules (do not regress)

- **No orders.** This skill only reads/backtests. If the user wants to trade a winner, hand off
  to `chart-to-binance-trade` or `binance-ladder-entry` — never place anything from here.
- **Distrust in-sample results.** A strategy is only a candidate after it survives `walk-forward`.
  Always run step 3 before promoting to `best`. State the verdict in every report.
- **Be honest about overfitting.** Sweeping 9 strategies × N symbols × M timeframes is a multiple-
  comparisons problem: the "winner" is partly luck. Say so. Prefer a MODERATE result that makes
  sense over a ROBUST-looking one you can't explain.
- USDC pairs only; respect the user's 3x leverage rule if/when sizing is discussed downstream.
