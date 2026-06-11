---
name: tv-strategy-optimizer
description: Sweep a Pine strategy across ANY TradingView symbols (stocks, gold, forex, indices — not just crypto) × timeframes by driving the live chart's Strategy Tester via batch_run, rank the results, and keep a best-so-far leaderboard. Use when the user wants to optimize or validate a Pine strategy outside Binance's klines universe. Read-only on funds: NO orders are ever placed.
---

# TradingView Strategy Optimizer (any market)

The non-crypto sibling of `binance-strategy-optimizer`. That skill backtests 9 fixed
strategies off Binance klines; **this one backtests the Pine strategy on the live chart**
against any symbol TradingView can chart — stocks (`NASDAQ:AAPL`), gold (`OANDA:XAUUSD`),
forex (`FX:EURUSD`), indices (`AMEX:SPY`, `TVC:DXY`) — by switching the chart through a
symbol × timeframe grid and scraping the Strategy Tester panel.

It moves no funds, but it **does drive the live chart** (symbol/timeframe changes).
Restore the user's chart when done.

## Prerequisites (check, don't assume)

1. `tv_health_check` — TradingView must be live on :9222.
2. A Pine **strategy** (not an indicator) must be on the chart. If not:
    - load a saved one with `pine_open`, or develop one via the `pine-develop` skill
      (the repo's own candidates live in `strategies/*.pine` — `pine_set_source` →
      `pine_smart_compile` → add to chart).
3. `ui_open_panel` with `strategy-tester` — the metrics are scraped from this panel's
   DOM; it must be open and visible.
4. `chart_get_state` — record the user's current symbol + timeframe to restore later.

## Search space

- **Symbols:** ask the user, or default to a cross-asset spread, e.g.
  `NASDAQ:AAPL, NASDAQ:MSFT, AMEX:SPY, OANDA:XAUUSD, FX:EURUSD`. Use full
  `EXCHANGE:TICKER` form so TradingView resolves the right feed.
- **Timeframes:** default `60, 240, D` (Strategy Tester needs enough bars; intraday on
  stocks may have limited history on a free plan).
- **Ranking:** parse what the Strategy Tester shows — net profit %, max drawdown %,
  profit factor, win rate, total trades. Rank by **profit factor** by default (the
  scraped metrics don't include Sharpe); confirm with the user if they care.

## One iteration (each loop tick)

1. **Pick the next combo(s).** Read `strategies/tv-optimizer-leaderboard.json` (create
   `{"strategy":"<name>","runs":[],"best":[]}` if absent). Choose symbol × timeframe
   combos not yet tried this session.

2. **Run the sweep:**
   ```
   batch_run { symbols: [...], timeframes: ["240","D"], action: "get_strategy_results" }
   ```
   Each combo returns the Strategy Tester's metrics as label→value strings. Parse the
   numbers (strip %, $, commas). A combo with `metric_count: 0` or an error usually
   means the panel closed or the strategy dropped off the chart — re-check prerequisites.

3. **Sanity-check the numbers.** Discard combos with fewer than ~30 trades (too few to
   mean anything) or where TradingView loaded only a sliver of history — if the trade
   count looks implausibly low for the timeframe, note it. For deeper history, scroll
   back first (`chart_scroll_to_date`) or use TradingView's own Deep Backtesting mode
   manually; the tester only sees loaded bars.

4. **Update the leaderboard.** Append runs; keep `best` to the top ~5 by the ranking
   metric. Write the file back.

5. **One-line tick summary**, e.g.:
   `NASDAQ:AAPL D → PF 1.62 | net +84% | maxDD 14% | 112 trades (new #1)`

## Running it as a loop

Same cadence as the binance optimizer:

```
/loop 5m Run one iteration of the tv-strategy-optimizer skill, then stop.
```

Or one-shot: run the whole grid in a single `batch_run` (it iterates combos itself —
mind `delay_ms`; each combo costs a symbol switch + chart-ready wait).

## Wrap-up

- Present the `best` table (symbol, TF, PF, net %, maxDD, trades) and which result
  you'd trust most — favor **consistency across symbols/TFs** over one outlier curve.
- **Restore the chart** to the symbol/timeframe recorded in prerequisites
  (`chart_set_symbol` + `chart_set_timeframe`).

## Hard rules & honesty (do not regress)

- **No orders, ever.** This skill reads a backtester. Execution lives in other skills —
  and only for the user's Binance USDC universe; a great AAPL backtest is research, not
  a trade ticket.
- **No walk-forward here.** Unlike the binance optimizer, this path has no
  out-of-sample check — the scraped metrics are 100% in-sample. Say so in every report.
  The robustness proxy is consistency: a strategy that holds up across several symbols
  and timeframes beats one great curve.
- **Multiple-comparisons honesty:** sweeping a grid guarantees a pretty winner by luck
  alone. Always report how many combos were tried alongside the best result.
- The Strategy Tester scrape reads whatever the panel shows — if results look stale,
  the chart may not have finished loading; increase `batch_run`'s `delay_ms`.
