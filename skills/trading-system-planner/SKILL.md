---
name: trading-system-planner
description: Plan a trading system's risk from the math of expectancy — pick a realistic win-rate/reward-risk archetype, then size risk-% per trade so the expected losing streak and drawdown stay inside the user's tolerance. Use when the user asks "what win rate / R:R do I need", "how much should I risk per trade", "will I survive the drawdowns", or wants to sanity-check a strategy's numbers before trading it.
---

# Trading System Planner

You are helping the user design (or sanity-check) a trading system around **the math of expectancy** — the framework that being profitable on paper means nothing if the drawdowns blow you up first. This is **planning only**: no orders, no chart needed. All three tools are pure calculators (no network, no account).

The governing idea: **you don't choose your win rate and reward:risk independently — they trade off** (high win rate ⇒ small R:R, big R:R ⇒ low win rate). What you actually choose is the *risk per trade*, and you choose it so the losing streaks you're *guaranteed* to hit stay survivable. Drawdowns are the cost of doing business — plan for them, don't try to avoid them.

## Step 0: Anchor on drawdown tolerance

Before any numbers, get the one input that drives everything: **what peak-to-trough drawdown can the user actually stomach** without abandoning the system? Most traders: 10–20%. If unknown, ask. Everything below is sized to keep the *expected* drawdown inside that number. Respect the user's standing rules (3x leverage cap, USDC pairs — see memory).

## Step 1: Pick a realistic win-rate / reward-risk archetype

Win rate and R:R are inversely correlated. Map the user's style to a realistic pair (don't let them assume a 60% win rate at 3:1 — that combo doesn't exist robustly):

| Archetype | Win rate | Reward:risk | Feel |
|-----------|----------|-------------|------|
| Mean-reversion / scalp | 60–70% | 0.5–1.0 | Many small wins, rare bigger losses; depends on the high win rate |
| Balanced | 45–55% | 1.0–2.0 | The comfortable middle |
| Trend-following | 35–45% | 1.5–3.0+ | Lots of small losses, occasional big wins; needs a strong stomach for drawdown |

Beyond ~5:1 R:R, expect a sub-20% win rate. Below ~40% win rate, drawdowns get long and psychologically hard — flag this.

## Step 2: Check the edge exists

`binance_calc_expectancy` (CLI `tv binance expectancy --winRate <%> --rrRatio <r>`):
- **expectancyR** must be **> 0**, or the system loses money no matter how you size it — stop here.
- **breakevenWinRatePct** = `1/(1+rr)` — the win rate floor for this R:R (e.g. 33% for 2:1). Confirm the chosen win rate clears it with margin (`marginOverBreakevenPct`).
- Pass `--riskAmount` or `--riskPct`+`--balance` to see expected $/% per trade and projected PnL over N trades.

## Step 3: Size risk-% to the losing streak

`binance_estimate_losing_streak` (CLI `tv binance losing-streak --winRate <%> --sampleSize 1000 --riskPct <%>`):
- Read **maxLosingStreak** — the longest run of losses to expect over the sample. Even a 90% win rate loses ~3 in a row over 1000 trades; 60% loses ~8; 40% loses ~13. **These will happen.**
- With `--riskPct`, read **streakDrawdownPctCompounded** — the drawdown that streak alone produces.
- **Find the risk-% where that drawdown sits inside the Step-0 tolerance.** If 2% risk implies a 16% streak drawdown and tolerance is 10%, drop to 1%.

## Step 4: Stress-test with Monte Carlo

`binance_simulate_equity` (CLI `tv binance simulate-equity --winRate <%> --rrRatio <r> --riskPct <%> --trades 1000 --runs 1000`):
- **maxDrawdownPct.p90 / .worst** — the realistic and bad-case drawdowns across many random sequences. This is the real test of the risk-% from Step 3.
- **ruinRunsPct** — % of runs that breached `--ruinDrawdownPct` (default 50%). Want this at/near 0.
- **finalReturnPct** median vs p10 — the spread of outcomes; p10 is your unlucky-but-plausible result.
- Compounding (default) inflates the median return — judge the system on **drawdown and ruin %**, not the headline return.
- If p90/worst drawdown exceeds tolerance or ruin% is non-trivial, **lower risk-% and re-run** until it fits.

## Step 5: Report

Give the user a concrete, sized plan:

```
System: <archetype> — ~<win%> win rate, <r>:1 reward:risk
Edge:   expectancy +<X>R/trade (break-even <B>%, clears by <margin>%)
Reality: expect ~<S> losses in a row over 1000 trades
Sizing:  risk <P>% per trade → ~<DD>% expected drawdown, worst-case ~<W>%, ruin <R>%
Verdict: fits your <tolerance>% tolerance ✅ / too hot, drop to <P'>% ❌
```

Then the principles the user should internalize (from the source material):
- **Drawdowns are inevitable** — plan for them, don't system-hop when one arrives.
- **Each trade is independent** (gambler's fallacy): a losing streak does *not* make the next trade more likely to win — never Martingale / increase risk into losses.
- **Commit to a sample** (≥100 trades) before judging or changing the system.
- These are *theoretical* numbers — commission, slippage and tax make live results worse, so leave margin.

Do not place any orders from this skill. To act on a sized plan, hand off to `binance-ladder-entry` or `chart-to-binance-trade` on explicit user request.
