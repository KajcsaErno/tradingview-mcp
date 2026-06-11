# Adaptive Trend Rider [BTCUSDC] — backtest results

> **v2 update (same day):** added Turtle-style pyramiding (up to 3 entries per trend,
> each requiring a fresh pullback + breakout; stack stop ratchets to hang off the
> latest add) and raised default risk to 2.25%/trade after Monte Carlo validation.
> **Final 4h figures: +53.9% net, PF 1.77, maxDD 14.0%, Sortino 0.95, 34 entries**
> (BTCUSDT.P cross-check: +49.9%, PF 1.74). Pyramiding alone (at 1% risk) lifted
> +20.5% → +24.1% with NO increase in drawdown (PF 1.98). Looser filters
> (ADX 20 / KC 1.5) were tested and rejected: same return, worse PF (1.64) and DD.
> Max leverage used ≈ 2.7x (3 adds × ~0.9x), inside the 3x cap. Expected worst
> losing streak at 2.25% risk ≈ -19% equity — sized to tolerance, do not raise further.
> The original 1%-risk no-pyramid analysis below is kept for reference.

Pine v6 strategy: `strategies/adaptive_trend_rider.pine` (saved to TradingView cloud).
Developed and validated 2026-06-11 on BINANCE:BTCUSDC.P via the Strategy Tester
(report read through `scripts/read_strategy_report.js` — works around the
overlay-strategy `_reportData` bug).

## Final configuration (variant C)

- **Entry (long-only):** close breaks above Keltner band (fast EMA + 2.0×ATR) while
  EMA20 > EMA50, close > EMA200, ADX(14) > 25, and price has pulled back to the fast
  EMA since the last trade (re-arm gate → "breakout after pullback", no churn).
- **Exit:** EMA20/50 cross-down (trend flip), or fixed initial stop at 2.5×ATR below
  entry. Chandelier trail exists but is OFF by default (cut winners too early).
- **Sizing:** 1% of equity risked per trade (qty = risk ÷ stop distance), hard-capped
  at 3x leverage. Commission 0.05% + 2 ticks slippage modeled.
- Shorts and a daily higher-timeframe filter exist as inputs but default OFF —
  both lost money in every test window.

## Results (Jan 2024 – Jun 2026, ~5,300 bars max intraday history)

| Timeframe | Window | Net | Trades | Win% | PF | MaxDD | Verdict |
|-----------|--------|-----|--------|------|----|-------|---------|
| **4h** | 2.4y (bull+bear) | **+20.5%** | 25 | 32% | **2.16** | **6.3%** | ✅ home timeframe |
| 4h (BTCUSDT.P) | 2.4y | +20.3% | 25 | 32% | 2.15 | 6.3% | ✅ cross-symbol consistent |
| 1d | 2.4y | +2.0% | 3 | 67% | 2.84 | 1.0% | too few trades (params too slow for daily) |
| 1h | 7.4mo (bear/chop only) | +5.2% | 58 | 24% | 1.13 | 8.9% | beat a -17% market, but thin after costs |
| 2h | 1.4y | +0.9% | 28 | 29% | 1.05 | 5.9% | flat |
| 15m | 55 days | -8.8% | 29 | 24% | 0.56 | 12.9% | ❌ noise + fee drag |

Buy-and-hold comparison on the 4h window: BTC went +43% peak-to-window-end with
multiple >30% drawdowns; the strategy made +20.5% (at a deliberately conservative
1% risk) with a 6.3% max drawdown.

## Trade distribution (4h, 25 trades)

Textbook trend-following: every loss uniformly ≈ -1R (-$100 on $10k — the sizing
works), three big winners pay for everything (+$1,625 Feb–Mar 2024 +44% ride,
+$696 Nov–Dec 2024, +$835 Apr–May 2025). Year split: 2024 +$2,212, 2025 +$117,
2026 -$298 — the system makes its money in trends and approximately breaks even
in chop (the ADX+regime filters keep losses small but can't create edge where
there's no trend).

## Expectancy profile

avgWin/avgLoss ≈ 4.6R, win rate 32% → expectancy +0.79R per trade.
Break-even win rate at 4.6:1 is 17.9% → 14-point margin of safety.
Expected worst losing streak ≈ 9 (≈ -9% at 1% risk) — psychologically hard;
this is the price of trend-following. Do NOT raise risk past ~2%/trade.

## Iteration log (what was tried and rejected)

1. v1 baseline (both directions, chandelier 3×ATR/22): 1h PF 1.09 over 274 trades — fee churn.
2. v2 channel re-arm gate: no effect (gate re-armed instantly after stop-outs).
3. v3 midline (fast EMA) re-arm: 1h 242 trades, still churny.
4. v4 stricter filters (ADX 25, KC 2.0) + slower trail (4×ATR/50): 1h worse (-5.4%) — wide trail
   gives back too much in hourly noise; but 4h improved to PF 1.36.
5. **Variant C: trail OFF (exit on trend flip) + long-only → 4h PF 2.16, +20.5%, DD 6.3%. KEPT.**
6. v5 daily EMA20/50 HTF filter: 4h dropped to PF 1.18 — daily cross lags weeks, blocks the
   exact breakouts that pay. REJECTED (input kept, default off). Stopped iterating here to
   avoid curve-fitting.

## Out-of-sample: BITSTAMP:BTCUSD, last 6 years (12h, 2020-06-11 → 2026-06-11)

Run 2026-06-11 with the new `Limit backtest range` input (added because Bitstamp's
2012-2013 data is toxic — thin-market gaps blow straight through stops, e.g. a -50%
single-day "trade"; never backtest this symbol unfiltered).

- **12h, exactly 6y: +274.5% net ($10k → $37.4k, ~24.6% CAGR), 16 trades, 68.8% win
  rate, PF 13.9.** Same params as the 4h system — nothing re-tuned.
- 4h (history cap = 2.4y only): +48.4%, PF 1.64 — matches the Binance result on a
  third venue.
- **Drawdown honesty:** `performance.maxStrategyDrawDownPercent` reported 2.7% but
  only tracks closed-trade equity. Reconstructed from per-trade run-up (`rn`) vs
  realized (`tp`): the May-2021 and Apr-2024 stack exits each gave back ~1/3 of peak
  open profit ≈ **~22% true open-equity drawdown**. (Implication: the 4h figures
  understate similarly but less — short holds, giveback ≈ +5pp.)
- Buy-and-hold over the same 6y: ≈ +570% with a -77% drawdown (2021-22). The strategy
  trades raw return for survivability: Calmar ≈ 1.1 vs ≈ 0.5.

## Caveats

- Only ~5,300 intraday bars (2.4y of 4h) are loadable on this TradingView plan — the window
  contains one full bull and one bear/chop phase but no 2022-style crash.
- 25 trades is a small sample; the Binance walk-forward on related trend strategies
  (ema_cross, triple_ema, keltner) returned INCONCLUSIVE (poor in 2024-25 train chop,
  strong in recent test) — regime dependence is real, not eliminated.
- Sparse signals: ~1 trade/month. This is a patience system, not an activity system.
