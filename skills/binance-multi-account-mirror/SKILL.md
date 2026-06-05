---
name: binance-multi-account-mirror
description: Replicate a Binance trade across multiple accounts, sized by balance ratio, after pre-flighting each account's position mode and leverage. Use when the user wants the same order or bracket placed on accounts 1, 2, 3…
---

# Binance Multi-Account Mirror

You are fanning one trade out across several Binance accounts, **sized by each account's balance**. The base account (`accounts[0]`) drives sizing; each mirror gets `quantity × (its balance / base balance)`.

> ⚠️ Real funds on **multiple** accounts. DRY-RUN until explicit `confirm`. Standing rules: **3x max**, **USDC pairs (BTCUSDC)**. Leverage and position mode are **NOT** mirrored — you must set them per account first.

## Step 1: Pre-flight EVERY target account

This is where multi-account trades go wrong. For each account in the set:
- `binance_get_position_mode` — confirm it matches what the order expects. In Hedge Mode you must pass `positionSide`; if an account is one-way and others are hedge, **fix it** with `binance_set_position_mode` (a mismatch throws `-4061`).
- `binance_set_leverage` `leverage:3` — set **3x on each account** (leverage is not mirrored; defaults differ per account).
- `binance_get_balance` / `binance_get_account_summary` — confirm each account has margin for its scaled share.

## Step 2: Dry-run the mirror

- Single order → `binance_mirror_order` (CLI: `tv binance mirror-order`).
- Full bracket → `binance_mirror_bracket`.

Pass `accounts` (e.g. `["1","2"]`), the base `quantity`, `positionSide` (if hedge), and order params. Review the preview: the scaled quantity per account, and any account whose scaled size **floors below minQty** (it will be skipped).

## Step 3: Present and confirm

Show a per-account table: balance, scale factor, resulting quantity, notional, implied leverage (must be ≤3x). Get explicit approval.

## Step 4: Place and verify

On confirm: the **base account is placed first**; if it fails, mirrors are skipped (so you never end up holding only a mirrored leg). Then verify each account with `binance_get_positions` + `binance_get_open_orders`, and report what filled vs. skipped per account.

## Notes

- For a **laddered** mirror, run the `binance-ladder-entry` skill per account (the mirror tools fan out single orders/brackets, sized by balance).
- Re-check each account is still **3x** after — `set_leverage` is per-account and easy to miss on a new account.
