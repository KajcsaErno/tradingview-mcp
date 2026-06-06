# Claude trading-strategy prompts — from David's "Claude Opus 4.8" video

Source: https://www.youtube.com/watch?v=tkAq6g2Gjz4
Scraped via Apify (`pintostudio/youtube-transcript-scraper`). Full transcript: `apify_transcript_full.txt`.

> ⚠️ These are **transcribed from the narrator's spoken description**, not captured from
> the on-screen text he pastes. He never shows the literal prompt text on screen, so the
> wording below is reconstructed from how he narrates each prompt. Treat them as faithful
> paraphrases, not byte-exact copies. The free prompts/worksheets he mentions are gated
> behind commenting "Claude code" on the video.

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
