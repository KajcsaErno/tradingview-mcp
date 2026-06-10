# First-time Binance setup

A 10-minute walkthrough from zero to a (dry-run) order. The Binance module is completely
independent of the TradingView/CDP side — no chart needs to be running.

## 1. Create a Binance API key

On binance.com → Profile → **API Management** → Create API.

Permissions to enable:

| Permission                   | Needed for                                               |
|------------------------------|----------------------------------------------------------|
| Enable Reading               | everything (balances, positions, history)                |
| Enable Futures               | USD-M / COIN-M trading (`market: futures` — the default) |
| Enable Spot & Margin Trading | only if you trade spot                                   |
| Permits Universal Transfer   | only if you use `tv binance transfer`                    |
| ~~Enable Withdrawals~~       | **never enable this** — nothing here withdraws           |

Strongly recommended: restrict the key to your IP.

## 2. Put the keys in `.env`

```bash
cp .env.example .env       # .env is gitignored — it never leaves your machine
```

Edit `.env` and paste the key/secret into `BINANCE_API_KEY` / `BINANCE_API_SECRET`.
No quotes, no spaces around `=`. Extra accounts follow the `BINANCE_API_KEY_2` /
`BINANCE_API_SECRET_2` pattern and are selected with `--account 2` (CLI) or
`account: "2"` (MCP).

## 3. Verify with read-only calls first

```bash
npm run tv -- binance server-time     # connectivity + clock-skew check (no keys needed)
npm run tv -- binance balance         # first signed call — proves the keys work
npm run tv -- binance positions       # current futures positions
```

If `balance` fails with a signature error (`-1022`), the usual causes are a stray
space/newline pasted into `.env`, or the wrong key for the wrong environment
(testnet keys on mainnet or vice versa — they are separate credentials).
A `-2015` error means the key lacks a permission or your IP isn't whitelisted.

## 4. Understand the safety rails (already on by default)

- **Dry-run by default** — every money-moving command (`order`, `bracket`, `ladder`,
  `transfer`, `cancel-all`, …) returns a preview and sends **nothing** until you add
  `--confirm` / `confirm: true`.
- **Post-only by default** — LIMIT orders are maker-only (0 maker fee); taker types
  (`MARKET`, stop-markets) require an explicit `allowTaker`.
- **`BINANCE_TESTNET=1`** routes every call to Binance's testnet exchange (separate
  `BINANCE_TESTNET_API_KEY` credentials — register at testnet.binancefuture.com).
- **`PAPER_TRADING=1`** is the master kill-switch: even `confirm:true` sends nothing,
  anywhere. Use it to dry-run a bot wired for live.
- House rules baked into the tools: 3x leverage max warning in position sizing, and
  USDC pairs (BTCUSDC) as the default instrument.

## 5. First order walkthrough (dry-run → confirm)

```bash
# 1. Size the position from entry, stop, and a risk budget
npm run tv -- binance position-size -s BTCUSDC --entry 100000 --stop 99000 --riskPct 1

# 2. Preview the order — this is a DRY RUN, nothing is sent
npm run tv -- binance order -s BTCUSDC --side BUY --type LIMIT --quantity 0.001 --price 100000

# 3. Read the preview (endpoint, params, live_funds flag). Only then:
npm run tv -- binance order -s BTCUSDC --side BUY --type LIMIT --quantity 0.001 --price 100000 --confirm

# 4. Protect it
npm run tv -- binance ensure-stop -s BTCUSDC --stop 99000 --positionSide LONG --confirm
```

Note: the account referenced in these docs runs in **Hedge Mode**, so futures orders
need `--positionSide LONG|SHORT`; the tools refuse to guess.

## 6. Where to go next

- `npm run tv -- binance --help` — all 70 subcommands
- `skills/binance-ladder-entry/` — plan/size/dry-run a laddered scale-in
- `skills/binance-account-review/` — read-only account health report
- `skills/trading-system-planner/` — size risk-% from expectancy math
- CLAUDE.md "Binance module" section — the full invariant list (hedge mode, algo
  routing, precision snapping, multi-account mirroring)
