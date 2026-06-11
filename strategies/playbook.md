# Trading Playbook

A self-updating lessons-learned file. The `binance-trade-review` skill appends to it after
each review; the entry skills (`chart-to-binance-trade`, `binance-ladder-entry`,
`binance-position-manager`) read it before planning a trade.

Rules for editing this file (for Claude):

- **Only add lessons the data supports** — every entry cites its evidence (date, symbol,
  the number that proves it). No moralizing, no generic trading wisdom.
- **Observations become rules after two sightings.** New lessons go under *Observations*
  with a date; when the same lesson shows up in a later review, promote it to *Confirmed
  rules* (keep both dates as evidence).
- **Lessons may only ADD caution.** Nothing in this file may relax the standing rules
  below, the dry-run/confirm gate, or post-only defaults. If a "lesson" suggests more
  leverage or skipping confirmation, it does not get written.
- **Keep it bounded.** Merge duplicates instead of re-adding; retire rules that stopped
  applying (move to *Retired* with a reason, don't delete).

## Standing rules (immutable — set by the user, not by reviews)

- Max **3x leverage** on futures, always.
- **USDC pairs only**; BTCUSDC is the default instrument.
- Money-moving calls are **dry-run until explicit confirm** — never confirm on the user's behalf.
- Entries are **post-only** (maker) by default.

## Confirmed rules

_(none yet — promoted from Observations after a second sighting)_

## Observations

_(none yet — appended by `binance-trade-review` Step 5)_

## Retired

_(none yet)_
