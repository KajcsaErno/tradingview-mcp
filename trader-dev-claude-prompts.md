# Claude trading-strategy prompts — from David's videos

Sources:

- "Claude Opus 4.8" video: https://www.youtube.com/watch?v=tkAq6g2Gjz4
- "Fable 5" video: https://www.youtube.com/watch?v=2WJnNhQD2go — full transcript:
  `transcripts/Fable5_trading_test_2WJnNhQD2go.txt`

Scraped via Apify (`pintostudio/youtube-transcript-scraper`).

> ⚠️ These are **transcribed from the narrator's spoken description**, not captured from
> the on-screen text he pastes. He never shows the literal prompt text on screen, so the
> wording below is reconstructed from how he narrates each prompt. Treat them as faithful
> paraphrases, not byte-exact copies. The free prompts/worksheets he mentions are gated
> behind commenting on the video.

---

# Video 1 — "Claude Opus 4.8" (tkAq6g2Gjz4)

---

## ⭐ Main command — develop & optimize a strategy in a loop (with Trader Dev MCP)

This is the core "develop a trading strategy" command — run in **Claude Code** with his
**Trader Dev MCP server** connected, which lets Claude backtest on TradingView:

```
You can use the Trader Dev platform to backtest strategies on TradingView so you can
find something better.

I'd like you to loop every 5 minutes through this prompt so that you can build a better
strategy. Continue improving and optimizing it every 5 minutes for 1 full hour.

Don't forget that you have access to the Trader Dev MCP server, which will allow you to
backtest the strategies and optimize to find better results.
```

Behavior shown: Claude builds a Pine Script strategy, backtests it via the MCP server,
and keeps iterating for ~1 hour — producing several strategies (BTC 4h ~112% P&L / 27%
max DD / 65 trades, ETH 4h ~100%, SOL 4h ~79%).

---

## Test 1 — build a strategy with ZERO tools (baseline)

Narrated as: a prompt that gives Claude "just some rules" —

```
You are a 0.1 systematic trader using Pine Script. Do not use any tools whatsoever.
Build a strategy for BTCUSDT and backtest that strategy.
```

Run on **high-effort thinking**. (Result in the video: it compiled after a fix but was
not profitable — the point was to show tools make the difference.)

---

## Fast-mode — build a simple strategy as fast as possible

```
I'd like you to build me a trading strategy. Build something simple for BTCUSDT on the
1-hour time frame. I'm looking for a stop loss, a take profit, and an entry thanks to
indicators. Build it as fast as you can.
```

And a stripped-down speed test:

```
We've got fast mode enabled. We don't want anything fancy — don't overthink it. We're
just testing how fast you can code a Pine Script strategy. No backtest. Code me a
trading strategy for BTCUSDT as fast as you can.
```

---

## Bonus — live trade-execution prompts (Bybit, not strategy dev)

Included for completeness — these place real trades, not build strategies:

**Scan & propose trades:**
```
You have access to my account and also access to skills. Adapt those skills to what you
feel is the correct way of trading. Scan the market for three trades using the coin
pairs from Bybit — three potential trades that could actually work out. I want stop
losses: one single stop loss, one single take profit, all on market orders.
```

**Execute the trades:**
```
Please take these trades for me on Bybit. I'd like to use $100 per trade from my wallet
and use 10x leverage for all of these trades.
```

**Next-morning autonomous run (fast mode):**
```
The markets have changed. Scrape the market, go through and get all of the data, and
find me a couple of positions. Take those positions — don't wait for confirmation. Set
stop losses and take profits. Use $100 per position with 10x leverage.
```

---

# Video 2 — "Fable 5" (2WJnNhQD2go)

Same three-test format, run on the then-new Fable 5 model. New here vs video 1:
an anti-repainting rule in the baseline prompt, a non-crypto extension of the backtest
loop, and a **self-learning twist** — he asks Claude to rewrite its own skill files
before trading.

## Test 1 — no-tools baseline (BTCUSDT 1h, with anti-repainting rule)

Narrated as a "standard prompt" with these rules baked in:

```
You are not allowed to use any extra tools. Come up with a profitable trading strategy
for BTCUSDT on the 1-hour time frame. Do not use multiple take profits on multiple
time frames — that can create repainting, which is cheating.
```

Result shown: compiled with zero errors first try; profitable on 1h/2h/4h full history
(4h: 31% win rate, 12% max DD, 21% P&L, profit factor 1.12); poor on low timeframes.
Indicators it picked: fast/slow EMA cross, ADX regime filter, SMA, RSI — plus
commission and slippage included on its own.

## Test 2 — Trader Dev MCP backtest loop, extended beyond crypto

Same 5-minute optimize loop as video 1's ⭐ main command, with one addition:

```
[Video-1 loop prompt, plus:]
Don't only look at crypto — look outside of the crypto world and try to find the best
settings for other TradingView markets too.
```

Result shown: after ~1–2 hours it produced BTC ~112% P&L, a 119% / 1.78-profit-factor
variant, ETH and 4h strategies, **and stock strategies on its own initiative** (Apple
1D, TJX 4h with clean equity curves). He ran a second loop in parallel because the
first wouldn't keep looping by itself.

## Test 3 — "Strategy Factory" skill: self-update skills, then find 3 trades (Bybit)

The closest-to-verbatim prompt in the video (spoken while typing):

```
Claude, with your skills in this folder, I'd love for you to update those skills with
all of your new knowledge. You are the most powerful model out there. You understand
markets like nobody else. These skills — update them. Learn from your previous
mistakes and find me three trades. I want the stop loss, the take profit, and the
actual entry. All market orders. Three trades which we can potentially take right now.
```

Behavior shown (worth noting as a cautionary tale): Claude **took the three trades
without asking** (10x isolated leverage, sizing inferred from previous chats), then
**kept monitoring on its own** — checking stops every 15–20 minutes, manually closing
two trades and letting one hit its stop (net **−$20**), and **updating its own skill
files** afterward as a self-learning step.

---

# What he has that we don't (and vice versa)

| His stack                             | What it does                                                                                                      | Our equivalent                                                                                                                                                                                                                                                                                  |
|---------------------------------------|-------------------------------------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **Trader Dev MCP** (trader.dev)       | Hosted backtester driving TradingView's Strategy Tester; community of 63k+ backtests; crypto, gold, forex, stocks | `binance_backtest_strategy` / `compare_strategies` / `walk_forward_backtest` (klines-based, 9 fixed strategies, **crypto only**) + `batch_run get_strategy_results` for reading TV Strategy Tester                                                                                              |
| **Strategy Factory skill** (Bybit)    | Exchange connection + trade execution, DCA bot, grid bot, conversational risk mgmt ("move my stop to break even") | Binance module + skills (`binance-position-manager`, `binance-ladder-entry`…), now incl. **`binance-grid-trader`** (`planGrid` + ladder execution + /loop maintenance) and **`binance-dca`** (/schedule-driven recurring buys). Ours is dry-run-by-default; his fires live without confirmation |
| **Self-updating skills**              | Prompts Claude to rewrite its skill files with lessons learned before/after trading                               | Nothing equivalent — our skills are static; `binance-strategy-optimizer` keeps a best-so-far leaderboard but doesn't rewrite itself                                                                                                                                                             |
| **5-min optimize loop**               | "Loop every 5 minutes, keep improving" free-running prompt                                                        | `/loop` + `skills/binance-strategy-optimizer` (structured sweep, read-only)                                                                                                                                                                                                                     |
| **Autonomous trade monitoring**       | Claude self-polled positions every 15–20 min and closed trades on its own                                         | **`binance-trade-guardian`** skill: same 15-min watch cadence, but alert/propose-only — the single pre-authorizable action is placing a missing protective stop; it never closes or opens positions                                                                                             |
| Pine strategy generation + TV compile | Hand-pastes code into TradingView                                                                                 | `pine_set_source` → `pine_smart_compile` → Strategy Tester via CDP — **ours is more automated here**                                                                                                                                                                                            |

Ideas worth stealing — **both implemented (2026-06-11):**

- ✅ **Post-trade playbook**: `binance-trade-review` Step 5 now appends data-backed
  lessons to `strategies/playbook.md`; `chart-to-binance-trade`, `binance-ladder-entry`
  and `binance-position-manager` read it as Step 0 before planning. Lessons can only
  ADD caution — they can never relax the confirm gate, 3x cap, or post-only defaults.
- ✅ **Non-crypto optimizer**: `skills/tv-strategy-optimizer/` sweeps the Pine strategy
  on the live chart across any TradingView symbols (stocks/gold/forex) × timeframes via
  `batch_run get_strategy_results`, leaderboard in `strategies/tv-optimizer-leaderboard.json`.
- ✅ **DCA/grid**: `planGrid` core tool (`binance_plan_grid` / `tv binance grid-plan`,
  pure planner with grid economics + 3x check) + `skills/binance-grid-trader/`
  (placement via ladders, /loop maintenance, user confirms every re-quote) +
  `skills/binance-dca/` (recurring post-only buys via /schedule with hard caps).
- ✅ **Autonomous management, made safe**: `skills/binance-trade-guardian/` — 15-min
  /loop watch over open positions (protection, liq distance, margin, funding,
  breakeven/trail proposals). Only pre-authorizable action: `ensureProtectiveStop` at a
  charter-agreed price. It never closes, opens, or resizes positions.

Ideas to keep rejecting: unconfirmed live execution and 10x leverage (our 3x cap and
confirm-gate exist because of an accidental trade).
