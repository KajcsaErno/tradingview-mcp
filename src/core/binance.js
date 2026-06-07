/**
 * Binance REST client — direct order placement on a Binance account.
 *
 * This module is INDEPENDENT of TradingView/CDP. It talks to Binance's signed
 * REST API using HMAC-SHA256, with API credentials read from the environment
 * (BINANCE_API_KEY / BINANCE_API_SECRET) or a gitignored project-root `.env`.
 *
 * SAFETY MODEL:
 *  - Credentials are NEVER hardcoded and must not be committed (`.env` is gitignored).
 *  - placeOrder() defaults to a DRY-RUN preview; it only sends a live order when
 *    called with `confirm: true`. This is a deliberate guard against accidental fills.
 *  - Every numeric input is validated with requireFinite before it reaches Binance.
 *
 * Like the rest of src/core, every function takes an optional `_deps` for testing
 * (inject `fetch`, `now`, and `keys`).
 */
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { requireFinite } from '../connection.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../');

// Base URLs per market. Mainnet = real funds; testnet = paper.
// "futures" = USD-M (fapi); "coinm" = COIN-M / coin-margined delivery (dapi).
const BASES = {
  spot: 'https://api.binance.com',
  futures: 'https://fapi.binance.com',
  coinm: 'https://dapi.binance.com',
  'spot-testnet': 'https://testnet.binance.vision',
  'futures-testnet': 'https://testnet.binancefuture.com',
  'coinm-testnet': 'https://testnet.binancefuture.com',
};

/** Minimal zero-dep `.env` loader. Reads KEY=VALUE lines from project-root `.env`
 *  into process.env without overwriting already-set vars. Silent if file absent. */
let envLoaded = false;
function loadDotEnv() {
  if (envLoaded) return;
  envLoaded = true;
  let text;
  try {
    text = readFileSync(path.join(PROJECT_ROOT, '.env'), 'utf8');
  } catch {
    return; // no .env — rely on real environment
  }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    const key = m[1];
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

/** Global testnet switch. When BINANCE_TESTNET is truthy (1/true/yes/on), every market is
 *  routed to its `-testnet` host and TESTNET credentials are used — no need to append
 *  "-testnet" to each call's `market`. A `_deps.testnet` boolean overrides the env (for tests). */
function useTestnet(_deps = {}) {
  if (_deps && _deps.testnet !== undefined) return !!_deps.testnet;
  loadDotEnv();
  const v = String(process.env.BINANCE_TESTNET ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/** Global PAPER-TRADING kill-switch. When BINANCE_PAPER_TRADING (or the bare PAPER_TRADING) is
 *  truthy, EVERY money-moving function is forced into dry-run: it builds and returns the full
 *  decision/preview (the "log") but sends NOTHING — even if `confirm: true` was passed. This is
 *  the master guard for running a bot wired for live (confirm:true everywhere) without risking a
 *  real fill: watch the logged decisions for a few days, then unset the var to go live. Distinct
 *  from BINANCE_TESTNET, which still PLACES orders, just on the testnet exchange/keys. A
 *  `_deps.paperTrading` boolean overrides the env (for tests). */
function usePaperTrading(_deps = {}) {
  if (_deps && _deps.paperTrading !== undefined) return !!_deps.paperTrading;
  loadDotEnv();
  const v = String(process.env.BINANCE_PAPER_TRADING ?? process.env.PAPER_TRADING ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

const PAPER_NOTE = 'PAPER_TRADING is ON — decision logged, nothing sent (even with confirm:true). Unset BINANCE_PAPER_TRADING / PAPER_TRADING to trade live.';
/** Extra fields merged into a dry-run response when the global paper-trading switch suppressed it. */
const paperFields = (on) => (on ? { paper_trading: true, paper_note: PAPER_NOTE } : {});

/** Map a logical market to its effective host market. With the testnet switch on, "futures"
 *  becomes "futures-testnet" (etc.); an already-explicit "*-testnet" market is left alone, as is
 *  any market with no testnet variant. Endpoint paths are host-independent, so only the base
 *  host changes — the logical market is still echoed in responses. */
function resolveMarket(market, _deps = {}) {
  if (!market || market.includes('testnet')) return market;
  if (!useTestnet(_deps)) return market;
  const tn = `${market}-testnet`;
  return BASES[tn] ? tn : market;
}

/** Resolve the env-var suffix for an account id. Account "1"/"primary"/undefined uses the
 *  unsuffixed BINANCE_API_KEY/SECRET (the original single-account vars); "2", "3", … use
 *  BINANCE_API_KEY_<n>/BINANCE_API_SECRET_<n>. */
function accountSuffix(account) {
  const a = String(account ?? '1').toLowerCase();
  if (a === '1' || a === 'primary' || a === 'main' || a === '') return '';
  if (/^\d+$/.test(a)) return `_${a}`;
  throw new Error(`Unknown account "${account}". Use "1" (primary) or a number like "2" for BINANCE_API_KEY_2.`);
}

/** Read API credentials for an account. Defaults to the primary (unsuffixed) keys; pass
 *  account "2" (etc.) to read BINANCE_API_KEY_2 / BINANCE_API_SECRET_2 for trade mirroring. */
function getKeys(account = '1') {
  loadDotEnv();
  const suffix = accountSuffix(account);
  // With the testnet switch on, read TESTNET credentials (mainnet keys do not work on testnet).
  const testnet = useTestnet();
  const prefix = testnet ? 'BINANCE_TESTNET_API' : 'BINANCE_API';
  const key = process.env[`${prefix}_KEY${suffix}`];
  const secret = process.env[`${prefix}_SECRET${suffix}`];
  if (!key || !secret) {
    throw new Error(
      `Binance ${testnet ? 'TESTNET ' : ''}credentials missing for account "${account}". Set ${prefix}_KEY${suffix} and ` +
      `${prefix}_SECRET${suffix} (in your environment or a gitignored .env at the project root).`
    );
  }
  return { key, secret };
}

/** Resolve a `_deps` object with the right credentials for `account`. An explicit `_deps.keys`
 *  still wins (the test/DI convention); otherwise keys are loaded via `_deps.getKeys` (overridable
 *  in tests) or the real `getKeys`. Lets a plain `account` string select a key set without
 *  changing the `signedRequest`/`publicRequest` `_deps.keys` contract. */
function resolveDeps(account, _deps = {}) {
  if (_deps.keys) return _deps;
  const get = _deps.getKeys || getKeys;
  return { ..._deps, keys: get(account) };
}

function sign(query, secret) {
  return crypto.createHmac('sha256', secret).update(query).digest('hex');
}

// ms to add to the local clock to match Binance's server clock. Starts at 0 and is
// corrected automatically if a signed request is rejected for clock skew (-1021).
let _timeOffset = 0;

const isFutures = (market) => market.startsWith('futures'); // USD-M only
const isCoinM = (market) => market.startsWith('coinm');     // COIN-M (coin-margined)
const isFuturesLike = (market) => isFutures(market) || isCoinM(market);
const futPrefix = (market) => (isCoinM(market) ? '/dapi' : '/fapi'); // REST prefix for the futures-like markets

/** Fetch Binance server time and return the offset (serverTime - local), round-trip adjusted. */
async function fetchTimeOffset({ market, fetchFn, now }) {
  const endpoint = isFuturesLike(market) ? `${futPrefix(market)}/v1/time` : '/api/v3/time';
  const before = now();
  const res = await fetchFn(BASES[market] + endpoint);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.serverTime) throw new Error(`Binance time sync failed (${res.status})`);
  const localMid = Math.round((before + now()) / 2); // midpoint compensates for round-trip latency
  return data.serverTime - localMid;
}

/** Perform a signed Binance request. Returns parsed JSON; throws on API error.
 *  Applies the cached clock offset and, on a -1021 (timestamp/recvWindow) error,
 *  resyncs the offset against server time and retries once. */
async function signedRequest({ market = 'futures', method = 'GET', endpoint, params = {}, _deps = {} }) {
  const fetchFn = _deps.fetch || fetch;
  const now = _deps.now || Date.now;
  const sleep = _deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const { key, secret } = _deps.keys || getKeys();
  // Route to the testnet host when the global switch is on (endpoint paths are unchanged).
  market = resolveMarket(market, _deps);
  const base = BASES[market];
  if (!base) throw new Error(`Unknown market "${market}". Use one of: ${Object.keys(BASES).join(', ')}`);

  const attempt = async () => {
    const query = new URLSearchParams({ ...params, recvWindow: '5000', timestamp: String(now() + _timeOffset) }).toString();
    const signature = sign(query, secret);
    const url = `${base}${endpoint}?${query}&signature=${signature}`;
    const res = await fetchFn(url, { method, headers: { 'X-MBX-APIKEY': key } });
    const data = await res.json().catch(() => ({}));
    return { res, data };
  };

  let { res, data } = await attempt();
  if (data && data.code === -1021) { // timestamp outside recvWindow → resync clock and retry once
    try { _timeOffset = await fetchTimeOffset({ market, fetchFn, now }); ({ res, data } = await attempt()); } catch { /* fall through to surface the original error */ }
  }
  // Rate-limit / IP-ban backoff: 429 (too many requests) and 418 (auto-banned). Honor Retry-After
  // when present, else exponential backoff. Retry up to 3 times before surfacing the error.
  for (let tries = 0; (res.status === 429 || res.status === 418) && tries < 3; tries++) {
    const retryAfter = Number(res.headers?.get?.('Retry-After')) || 0;
    await sleep(retryAfter > 0 ? retryAfter * 1000 : 500 * (2 ** tries));
    ({ res, data } = await attempt());
  }
  if (!res.ok || (data && data.code !== undefined && data.code < 0)) {
    throw new Error(`Binance ${res.status}: ${data?.msg || JSON.stringify(data)}${data?.code ? ` (code ${data.code})` : ''}`);
  }
  return data;
}

/** Diagnostic: report the current local-vs-server clock offset (and pre-sync it). */
export async function getServerTime({ market = 'futures', _deps = {} } = {}) {
  const fetchFn = _deps.fetch || fetch;
  const now = _deps.now || Date.now;
  const testnet = useTestnet(_deps);
  _timeOffset = await fetchTimeOffset({ market: resolveMarket(market, _deps), fetchFn, now });
  return {
    success: true, market, testnet, offsetMs: _timeOffset, localTime: now(),
    note: Math.abs(_timeOffset) > 1000
      ? `clock skew ${_timeOffset}ms — offset is now applied to all signed requests`
      : 'clock within 1s of Binance',
  };
}

/** Public (unsigned) request helper for endpoints that do not require signing */
async function publicRequest({ market = 'futures', method = 'GET', endpoint, params = {}, includeApiKey = false, _deps = {} } = {}) {
  const fetchFn = _deps.fetch || fetch;
  market = resolveMarket(market, _deps); // testnet switch routes to the testnet host
  const base = BASES[market];
  if (!base) throw new Error(`Unknown market "${market}". Use one of: ${Object.keys(BASES).join(', ')}`);
  const query = new URLSearchParams(params).toString();
  const url = base + endpoint + (query ? `?${query}` : '');
  const headers = {};
  if (includeApiKey) {
    // historicalTrades requires an API key header but is not signed
    const { key } = _deps.keys || getKeys();
    if (!key) throw new Error('BINANCE_API_KEY missing for public endpoint that requires key');
    headers['X-MBX-APIKEY'] = key;
  }
  const res = await fetchFn(url, { method, headers: Object.keys(headers).length ? headers : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Binance ${res.status}: ${data?.msg || JSON.stringify(data)}`);
  }
  return data;
}

/** Read account balances. Spot returns free/locked per asset; futures returns wallet/available. */
export async function getBalance({ market = 'futures', account = '1', _deps = {} } = {}) {
  const deps = resolveDeps(account, _deps);
  if (isFuturesLike(market)) {
    // USD-M: /fapi/v2/balance · COIN-M: /dapi/v1/balance (both expose asset/balance/availableBalance)
    const endpoint = isCoinM(market) ? '/dapi/v1/balance' : '/fapi/v2/balance';
    const data = await signedRequest({ market, endpoint, _deps: deps });
    const balances = data
      .filter((b) => Number(b.balance) !== 0 || Number(b.availableBalance) !== 0)
      .map((b) => ({ asset: b.asset, balance: b.balance, available: b.availableBalance }));
    return { success: true, market, balances };
  }
  const data = await signedRequest({ market, endpoint: '/api/v3/account', _deps: deps });
  const balances = (data.balances || [])
    .filter((b) => Number(b.free) + Number(b.locked) > 0)
    .map((b) => ({ asset: b.asset, free: b.free, locked: b.locked }));
  return { success: true, market, balances };
}

/** One-call futures account health snapshot: wallet/margin balance, unrealized PnL,
 *  available margin, and the computed margin ratio (maint margin / margin balance). */
export async function getAccountSummary({ market = 'futures', account = '1', _deps = {} } = {}) {
  if (!isFuturesLike(market)) throw new Error('getAccountSummary is futures-only');
  const deps = resolveDeps(account, _deps);
  // USD-M: /fapi/v2/account · COIN-M: /dapi/v1/account
  const endpoint = isCoinM(market) ? '/dapi/v1/account' : '/fapi/v2/account';
  const d = await signedRequest({ market, endpoint, _deps: deps });
  const marginBalance = Number(d.totalMarginBalance);
  const maintMargin = Number(d.totalMaintMargin);
  const marginRatio = Number.isFinite(marginBalance) && marginBalance > 0 && Number.isFinite(maintMargin)
    ? `${(maintMargin / marginBalance * 100).toFixed(2)}%` : undefined;
  return {
    success: true, market, account,
    totalWalletBalance: d.totalWalletBalance,
    totalUnrealizedPnl: d.totalUnrealizedProfit,
    totalMarginBalance: d.totalMarginBalance,
    availableBalance: d.availableBalance,
    totalInitialMargin: d.totalInitialMargin,
    totalMaintMargin: d.totalMaintMargin,
    maxWithdrawAmount: d.maxWithdrawAmount,
    marginRatio,
  };
}

/** Compact futures snapshot for monitoring: margin ratio, available, unrealized PnL, open-order
 *  counts, and per-position {side, qty, entry, mark, uPnl}. Drives `tv binance stream`. */
export async function getAccountSnapshot({ market = 'futures', symbol, account = '1', _deps = {} } = {}) {
  if (!isFuturesLike(market)) throw new Error('snapshot is futures-only');
  const deps = resolveDeps(account, _deps);
  const [sum, posRes, ooRes] = await Promise.all([
    getAccountSummary({ market, account, _deps: deps }),
    getPositions({ market, symbol, account, _deps: deps }),
    getOpenOrders({ market, symbol, account, _deps: deps }),
  ]);
  const positions = (posRes.positions || []).map((p) => ({
    symbol: p.symbol, side: p.side, qty: p.quantity, entry: p.entryPrice, mark: p.markPrice,
    uPnl: Number(Number(p.unrealizedPnl).toFixed(2)),
  }));
  return {
    success: true, market, account,
    marginRatio: sum.marginRatio, availableBalance: sum.availableBalance, totalUnrealizedPnl: sum.totalUnrealizedPnl,
    openOrders: (ooRes.orders || []).length, openAlgoOrders: (ooRes.algoOrders || []).length,
    positions,
  };
}

/** Risk-based position sizing: from entry, stop and a risk budget (riskAmount or riskPct of
 *  balance), compute the quantity whose loss-to-stop equals the budget, plus notional and
 *  required margin at `leverage`. Warns if the plan breaches the 3x rule or available margin. */
export async function calcPositionSize({
  market = 'futures', symbol, entry, stop, leverage = 3,
  side, atrMult, interval = '1h',
  riskAmount, riskPct, balance, account = '1', round = true, _deps = {},
} = {}) {
  const entryP = requireFinite(entry, 'entry');
  const lev = requireFinite(leverage, 'leverage');
  const deps = resolveDeps(account, _deps);
  // Stop comes either from an explicit price, or is derived from ATR (entry ± atrMult·ATR).
  // The ATR path needs the position side (so the stop sits on the right side) and a symbol.
  let stopP, atrInfo;
  if (stop != null) {
    stopP = requireFinite(stop, 'stop');
  } else if (atrMult != null) {
    const mult = requireFinite(atrMult, 'atrMult');
    if (!symbol) throw new Error('ATR-based stop needs a symbol to pull candles for');
    const sd = String(side || '').toUpperCase();
    const isLong = ['BUY', 'LONG'].includes(sd);
    const isShort = ['SELL', 'SHORT'].includes(sd);
    if (!isLong && !isShort) throw new Error('ATR-based stop needs side: BUY/LONG or SELL/SHORT');
    const tech = await getTechnicals({ market, symbol, interval: interval || '1h', _deps: deps });
    if (tech.atr == null) throw new Error('could not compute ATR (not enough candles) — pass an explicit stop instead');
    stopP = px(isLong ? entryP - mult * tech.atr : entryP + mult * tech.atr);
    atrInfo = { source: 'ATR', atr: tech.atr, atrMult: mult, interval: interval || '1h' };
  } else {
    throw new Error('pass stop, or atrMult (+side) to derive an ATR-based stop');
  }
  if (entryP === stopP) throw new Error('entry and stop must differ');
  if (riskAmount == null && riskPct == null) throw new Error('pass riskAmount ($) or riskPct (% of balance)');
  let bal = balance != null ? Number(balance) : undefined;
  let risk;
  if (riskAmount != null) {
    risk = requireFinite(riskAmount, 'riskAmount');
  } else {
    const pct = requireFinite(riskPct, 'riskPct');
    if (bal == null && isFuturesLike(market)) {
      try { bal = Number((await getAccountSummary({ market, account, _deps: deps })).totalMarginBalance); } catch { /* leave undefined */ }
    }
    if (bal == null || !Number.isFinite(bal)) throw new Error('riskPct needs a balance — pass balance, or use a futures account so it can be fetched');
    risk = bal * (pct / 100);
  }
  const riskPerUnit = Math.abs(entryP - stopP);
  let qty = risk / riskPerUnit;
  let info;
  if (round && symbol) {
    try { info = await getSymbolInfo({ market, symbol, _deps: deps }); qty = snap(qty, info.stepSize, 'floor'); } catch { /* skip rounding */ }
  }
  const notional = qty * entryP;
  const requiredMargin = notional / lev;
  const warnings = [];
  if (lev > 3) warnings.push(`leverage ${lev}x exceeds your 3x rule`);
  if (bal != null && notional / bal > 3.0001) warnings.push(`implied account leverage ${(notional / bal).toFixed(2)}x exceeds 3x`);
  if (bal != null && requiredMargin > bal) warnings.push('required margin exceeds balance');
  if (info && Number(info.minQty) && qty < Number(info.minQty)) warnings.push(`quantity ${qty} is below minQty ${info.minQty}`);
  return {
    success: true, market, symbol: symbol ? String(symbol).toUpperCase() : undefined,
    side: stopP < entryP ? 'LONG (BUY)' : 'SHORT (SELL)',
    entry: entryP, stop: stopP, leverage: lev,
    riskAmount: Number(risk.toFixed(2)), riskPerUnit: Number(riskPerUnit.toFixed(8)),
    quantity: Number(qty.toFixed(8)), notional: Number(notional.toFixed(2)), requiredMargin: Number(requiredMargin.toFixed(2)),
    balance: bal != null ? Number(bal.toFixed(2)) : undefined,
    impliedAccountLeverage: bal != null ? Number((notional / bal).toFixed(2)) : undefined,
    atrStop: atrInfo,
    warnings: warnings.length ? warnings : undefined,
  };
}

/** Portfolio risk report: per-position notional, liquidation price + distance-to-liq %, and
 *  % of equity, plus account-level gross exposure, exposure/equity, and margin ratio. */
export async function getRiskReport({ market = 'futures', account = '1', _deps = {} } = {}) {
  if (!isFuturesLike(market)) throw new Error('risk report is futures-only');
  const deps = resolveDeps(account, _deps);
  const [sum, posData] = await Promise.all([
    getAccountSummary({ market, account, _deps: deps }),
    signedRequest({ market, endpoint: isCoinM(market) ? '/dapi/v1/positionRisk' : '/fapi/v2/positionRisk', _deps: deps }),
  ]);
  const equity = Number(sum.totalMarginBalance);
  const positions = (Array.isArray(posData) ? posData : []).filter((p) => Number(p.positionAmt) !== 0).map((p) => {
    const amt = Number(p.positionAmt), mark = Number(p.markPrice), liq = Number(p.liquidationPrice);
    const notional = Math.abs(amt) * mark;
    const distToLiqPct = (mark && Number.isFinite(liq) && liq > 0) ? Math.abs(mark - liq) / mark * 100 : undefined;
    return {
      symbol: p.symbol, side: amt > 0 ? 'LONG' : 'SHORT', quantity: Math.abs(amt),
      entryPrice: p.entryPrice, markPrice: p.markPrice, liquidationPrice: p.liquidationPrice,
      leverage: p.leverage, unrealizedPnl: p.unRealizedProfit, notional: Number(notional.toFixed(2)),
      distanceToLiqPct: distToLiqPct != null ? Number(distToLiqPct.toFixed(2)) : undefined,
      pctOfEquity: equity ? Number((notional / equity * 100).toFixed(1)) : undefined,
    };
  });
  const grossExposure = positions.reduce((s, p) => s + p.notional, 0);
  return {
    success: true, market, account,
    equity: sum.totalMarginBalance, availableBalance: sum.availableBalance,
    totalUnrealizedPnl: sum.totalUnrealizedPnl, marginRatio: sum.marginRatio,
    grossExposure: Number(grossExposure.toFixed(2)),
    exposureToEquity: equity ? `${(grossExposure / equity).toFixed(2)}x` : undefined,
    positions,
  };
}

// ── Trade-math planners (pure, no network) ──────────────────────────────────
// Forward-looking counterparts to backtestStrategy's backward-looking metrics:
// the math of expectancy. Given a win rate and reward:risk, what should you
// expect per trade, what losing streak is coming, and what risk-% keeps the
// drawdown survivable. (Nick Radge's expectancy/losing-streak framework — the
// two spreadsheets from the "math of winning" material.) These are theory:
// fixed-risk, and they exclude commission, slippage and tax, which make real
// results worse. None of them touch the network or an account.

/** Expectancy from a win rate (%) and reward:risk ratio (rr = reward per 1 risked).
 *  Returns expectancy in R (per unit risked), the break-even win rate (1/(1+rr)),
 *  and — if a risk budget is given — $/% per-trade and over-`trades` projections
 *  (fixed-risk, no compounding). Pure. */
export function calcExpectancy({ winRate, rrRatio, riskPct, riskAmount, balance, trades = 100 } = {}) {
  const wr = requireFinite(winRate, 'winRate');
  const rr = requireFinite(rrRatio, 'rrRatio');
  if (wr < 0 || wr > 100) throw new Error('winRate is a percent 0–100');
  if (rr <= 0) throw new Error('rrRatio must be > 0');
  const p = wr / 100, q = 1 - p;
  const expectancyR = p * rr - q;                 // win p× of +rr, lose q× of -1, in R units
  const breakevenWinRate = 100 / (1 + rr);        // win% where expectancyR = 0
  const n = Math.max(1, Math.floor(requireFinite(trades, 'trades')));
  const result = {
    success: true,
    winRate: wr, rrRatio: rr,
    expectancyR: Number(expectancyR.toFixed(4)),
    breakevenWinRatePct: Number(breakevenWinRate.toFixed(2)),
    edge: expectancyR > 1e-9 ? 'positive' : expectancyR < -1e-9 ? 'negative' : 'breakeven',
    marginOverBreakevenPct: Number((wr - breakevenWinRate).toFixed(2)),
    trades: n,
  };
  let riskDollars;
  if (riskAmount != null) riskDollars = requireFinite(riskAmount, 'riskAmount');
  else if (riskPct != null && balance != null) riskDollars = requireFinite(balance, 'balance') * requireFinite(riskPct, 'riskPct') / 100;
  if (riskDollars != null) {
    result.riskPerTrade = Number(riskDollars.toFixed(2));
    result.expectancyPerTrade = Number((expectancyR * riskDollars).toFixed(2));
    result.expectedPnlOverTrades = Number((expectancyR * riskDollars * n).toFixed(2)); // fixed-risk
  }
  if (riskPct != null) {
    result.riskPct = requireFinite(riskPct, 'riskPct');
    result.expectancyPctPerTrade = Number((expectancyR * result.riskPct).toFixed(4));
  }
  result.note = 'Theoretical, fixed risk per trade — excludes commission, slippage, tax and compounding (compounding skews returns up, costs skew them down).';
  return result;
}

/** Estimate the longest losing streak to expect over a sample size, for a given
 *  win rate — the probabilistic estimate maxStreak ≈ ln(N)/ln(1/lossRate). Returns
 *  a table across sample sizes; if riskPct is given, also the drawdown that streak
 *  implies (fixed and compounded). Pure — an expectation, never a guarantee. */
export function estimateLosingStreak({ winRate, sampleSize = 1000, riskPct } = {}) {
  const wr = requireFinite(winRate, 'winRate');
  if (wr <= 0 || wr >= 100) throw new Error('winRate is a percent strictly between 0 and 100');
  const q = 1 - wr / 100;                          // loss probability
  const streakFor = (nn) => Math.max(1, Math.ceil(Math.log(nn) / Math.log(1 / q)));
  const sizes = [100, 1000, 10000, 100000, 1000000];
  const n = Math.max(1, Math.floor(requireFinite(sampleSize, 'sampleSize')));
  const maxLosingStreak = streakFor(n);
  const result = {
    success: true,
    winRate: wr, lossRatePct: Number((q * 100).toFixed(2)), sampleSize: n,
    maxLosingStreak,
    table: sizes.map((s) => ({ sampleSize: s, maxLosingStreak: streakFor(s) })),
    note: "Probabilistic estimate (Nick Radge): the longest run of consecutive losses you can reasonably expect to hit at least once over the sample — a ballpark, not a guarantee. Trades are independent (gambler's fallacy): a losing streak never makes the next trade more likely to win.",
  };
  if (riskPct != null) {
    const r = requireFinite(riskPct, 'riskPct');
    result.riskPct = r;
    result.streakDrawdownPctFixed = Number((maxLosingStreak * r).toFixed(2));               // linear, constant $ risk
    result.streakDrawdownPctCompounded = Number(((1 - Math.pow(1 - r / 100, maxLosingStreak)) * 100).toFixed(2)); // % risk
  }
  return result;
}

/** Monte Carlo equity simulation: run `runs` independent sequences of `trades`
 *  trades at the given win rate and reward:risk, risking riskPct of balance each
 *  (compounding by default), and aggregate final return, max drawdown, longest
 *  losing streak and ruin frequency across runs. The forward-looking "expectancy
 *  tab" of the framework. RNG is injectable via _deps.rng for deterministic tests.
 *  Pure (no network). */
export function simulateEquity({
  winRate, rrRatio, riskPct = 1, startBalance = 10000,
  trades = 1000, runs = 1000, compounding = true, ruinDrawdownPct = 50, _deps = {},
} = {}) {
  const wr = requireFinite(winRate, 'winRate');
  const rr = requireFinite(rrRatio, 'rrRatio');
  const r = requireFinite(riskPct, 'riskPct');
  if (wr < 0 || wr > 100) throw new Error('winRate is a percent 0–100');
  if (rr <= 0) throw new Error('rrRatio must be > 0');
  if (r <= 0) throw new Error('riskPct must be > 0');
  const startBal = requireFinite(startBalance, 'startBalance');
  const nTrades = Math.min(Math.max(1, Math.floor(requireFinite(trades, 'trades'))), 100000);
  const nRuns = Math.min(Math.max(1, Math.floor(requireFinite(runs, 'runs'))), 10000);
  const ruinDD = requireFinite(ruinDrawdownPct, 'ruinDrawdownPct');
  const rng = _deps.rng || Math.random;
  const p = wr / 100;
  const finals = [], maxDDs = [], streaks = [];
  let ruined = 0, profitable = 0;
  for (let run = 0; run < nRuns; run++) {
    let bal = startBal, peak = startBal, maxDD = 0, streak = 0, worstStreak = 0, hitRuin = false;
    for (let t = 0; t < nTrades; t++) {
      const risk = (compounding ? bal : startBal) * (r / 100);
      const win = rng() < p;
      bal += win ? risk * rr : -risk;
      if (win) streak = 0; else { streak += 1; if (streak > worstStreak) worstStreak = streak; }
      if (bal > peak) peak = bal;
      const dd = peak > 0 ? (peak - bal) / peak * 100 : 100;
      if (dd > maxDD) maxDD = dd;
      if (maxDD >= ruinDD) hitRuin = true;
      if (bal <= 0) { bal = 0; hitRuin = true; break; }
    }
    finals.push(bal); maxDDs.push(maxDD); streaks.push(worstStreak);
    if (hitRuin) ruined += 1;
    if (bal > startBal) profitable += 1;
  }
  const pctl = (arr, qq) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.round(qq * (s.length - 1))))]; };
  const ret = (b) => (b / startBal - 1) * 100;
  return {
    success: true,
    inputs: { winRate: wr, rrRatio: rr, riskPct: r, startBalance: startBal, trades: nTrades, runs: nRuns, compounding, ruinDrawdownPct: ruinDD },
    finalReturnPct: { median: Number(ret(pctl(finals, 0.5)).toFixed(1)), p10: Number(ret(pctl(finals, 0.1)).toFixed(1)), p90: Number(ret(pctl(finals, 0.9)).toFixed(1)) },
    maxDrawdownPct: { median: Number(pctl(maxDDs, 0.5).toFixed(1)), p90: Number(pctl(maxDDs, 0.9).toFixed(1)), worst: Number(pctl(maxDDs, 1).toFixed(1)) },
    longestLosingStreak: { median: pctl(streaks, 0.5), worst: pctl(streaks, 1) },
    profitableRunsPct: Number((profitable / nRuns * 100).toFixed(1)),
    ruinRunsPct: Number((ruined / nRuns * 100).toFixed(1)),
    note: `Monte Carlo: ${nRuns} runs × ${nTrades} trades. Ruin = peak-to-trough drawdown ≥ ${ruinDD}%. Theoretical — excludes commission, slippage and tax, so treat ruin % as a floor, not a ceiling.`,
  };
}

/** Read open futures positions (futures only). */
export async function getPositions({ market = 'futures', symbol, account = '1', _deps = {} } = {}) {
  if (!isFuturesLike(market)) throw new Error('getPositions is futures-only');
  const deps = resolveDeps(account, _deps);
  const params = symbol ? { symbol: String(symbol).toUpperCase() } : {};
  const endpoint = isCoinM(market) ? '/dapi/v1/positionRisk' : '/fapi/v2/positionRisk';
  const data = await signedRequest({ market, endpoint, params, _deps: deps });
  const positions = data
    .filter((p) => Number(p.positionAmt) !== 0)
    .map((p) => ({
      symbol: p.symbol,
      side: Number(p.positionAmt) > 0 ? 'LONG' : 'SHORT',
      quantity: Math.abs(Number(p.positionAmt)),
      entryPrice: p.entryPrice,
      markPrice: p.markPrice,
      unrealizedPnl: p.unRealizedProfit,
      leverage: p.leverage,
    }));
  return { success: true, market, positions };
}

/** List open orders. */
export async function getOpenOrders({ market = 'futures', symbol, account = '1', _deps = {} } = {}) {
  const deps = resolveDeps(account, _deps);
  const endpoint = isFuturesLike(market) ? `${futPrefix(market)}/v1/openOrders` : '/api/v3/openOrders';
  const params = symbol ? { symbol: String(symbol).toUpperCase() } : {};
  const data = await signedRequest({ market, endpoint, params, _deps: deps });
  // Conditional orders (stops/TPs) live in the Algo service since 2025-12-09 — fetch & merge them.
  let algoOrders = [];
  if (isFutures(market)) {
    try {
      const a = await signedRequest({ market, endpoint: `${futPrefix(market)}/v1/openAlgoOrders`, params, _deps: deps });
      algoOrders = Array.isArray(a) ? a : (a.orders || a.algoOrders || []);
    } catch { /* algo endpoint unavailable — leave empty */ }
  }
  return { success: true, market, count: data.length + algoOrders.length, orders: data, algoOrders };
}

/** Get a single order by orderId or origClientOrderId */
export async function getOrder({ market = 'futures', symbol, orderId, origClientOrderId, account = '1', _deps = {} } = {}) {
  if (!symbol) throw new Error('symbol is required');
  if (orderId === undefined && !origClientOrderId) throw new Error('orderId or origClientOrderId is required');
  const deps = resolveDeps(account, _deps);
  const endpoint = isFuturesLike(market) ? `${futPrefix(market)}/v1/order` : '/api/v3/order';
  const params = { symbol: String(symbol).toUpperCase() };
  if (orderId !== undefined) params.orderId = String(orderId);
  if (origClientOrderId) params.origClientOrderId = String(origClientOrderId);
  const data = await signedRequest({ market, endpoint, params, _deps: deps });
  return { success: true, market, order: data };
}

// Supported order types. Stop/TP types let the STOP and TP levels from a chart
// plan become real resting orders.
const ORDER_TYPES = ['MARKET', 'LIMIT', 'STOP', 'STOP_MARKET', 'TAKE_PROFIT', 'TAKE_PROFIT_MARKET'];
const STOP_TYPES = ['STOP', 'STOP_MARKET', 'TAKE_PROFIT', 'TAKE_PROFIT_MARKET'];
const LIMIT_TYPES = ['LIMIT', 'STOP', 'TAKE_PROFIT']; // require a limit price (can be maker)
const TAKER_TYPES = ['MARKET', 'STOP_MARKET', 'TAKE_PROFIT_MARKET']; // cross the book — always taker
const VALID_TIF = ['GTC', 'IOC', 'FOK', 'GTX']; // GTX = post-only (maker-only) on futures

/** Number of decimals implied by a Binance filter step string (e.g. "0.001" → 3). */
function stepDecimals(step) {
  const dec = (String(step).split('.')[1] || '').replace(/0+$/, '');
  return dec.length;
}
/** Snap a value to a Binance step/tick. mode 'floor' for quantity (never over-buy),
 *  'ceil' to guarantee a minimum (never under-fill), 'round' (nearest) for price.
 *  Returns the original value if step is missing/invalid. */
function snap(value, step, mode = 'round') {
  const v = Number(value);
  const s = Number(step);
  if (!s || !Number.isFinite(s)) return v;
  const n = mode === 'floor' ? Math.floor(v / s) : mode === 'ceil' ? Math.ceil(v / s) : Math.round(v / s);
  return Number((n * s).toFixed(stepDecimals(step)));
}

/**
 * Place an order. DRY-RUN by default — returns a preview and does NOT hit Binance
 * unless `confirm: true` is passed. This is intentional: it prevents accidental fills.
 *
 * @param {object} a
 * @param {string} a.market   spot | futures | spot-testnet | futures-testnet
 * @param {string} a.symbol   e.g. "BTCUSDT"
 * @param {string} a.side     "BUY" | "SELL"
 * @param {string} a.type     MARKET | LIMIT | STOP | STOP_MARKET | TAKE_PROFIT | TAKE_PROFIT_MARKET
 * @param {number} a.quantity base-asset quantity (omit when closePosition is true)
 * @param {number} [a.price]  required for LIMIT / STOP / TAKE_PROFIT
 * @param {number} [a.stopPrice] trigger price; required for any stop/TP type
 * @param {boolean} [a.closePosition] futures: stop/TP that closes the whole position
 * @param {boolean} [a.reduceOnly] futures: close-only
 * @param {boolean} [a.confirm] must be true to actually send the order
 */
export async function placeOrder({
  market = 'futures', symbol, side, type = 'MARKET', quantity, price, stopPrice,
  closePosition = false, reduceOnly = false, postOnly = true, allowTaker = false, timeInForce,
  positionSide, round = true, confirm = false, newClientOrderId, account = '1', _deps = {},
} = {}) {
  const deps = resolveDeps(account, _deps);
  const paperTrading = usePaperTrading(_deps); if (paperTrading) confirm = false; // global kill-switch
  if (!symbol) throw new Error('symbol is required (e.g. "BTCUSDT")');
  const sym = String(symbol).toUpperCase();
  const sd = String(side || '').toUpperCase();
  if (!['BUY', 'SELL'].includes(sd)) throw new Error('side must be "BUY" or "SELL"');
  const ty = String(type).toUpperCase();
  if (!ORDER_TYPES.includes(ty)) throw new Error(`type must be one of: ${ORDER_TYPES.join(', ')}`);
  const isStop = STOP_TYPES.includes(ty);
  const futures = isFuturesLike(market); // USD-M or COIN-M — both share order semantics/endpoints (only the prefix differs)
  const coinm = isCoinM(market);
  // Post-only is enforced by default; taker-only order types must be opted into explicitly.
  if (TAKER_TYPES.includes(ty) && !allowTaker) {
    throw new Error(`${ty} is a taker-only order (it crosses the book and cannot be post-only/maker). Pass allowTaker:true (CLI --allowTaker) to place it and accept the taker fee.`);
  }
  if (closePosition && !futures) throw new Error('closePosition is futures-only');
  if (closePosition && !isStop) throw new Error('closePosition is only valid with a stop/TP order type');

  const params = { symbol: sym, side: sd, type: ty };

  // Quantity: required unless this is a futures closePosition stop/TP (which closes the whole position).
  if (closePosition) {
    params.closePosition = 'true';
  } else {
    const qty = requireFinite(quantity, 'quantity');
    if (qty <= 0) throw new Error('quantity must be > 0');
    params.quantity = String(qty);
  }

  if (LIMIT_TYPES.includes(ty)) {
    params.price = String(requireFinite(price, 'price'));
    let tif = timeInForce ? String(timeInForce).toUpperCase() : null;
    if (tif && !VALID_TIF.includes(tif)) throw new Error(`timeInForce must be one of: ${VALID_TIF.join(', ')}`);
    if (postOnly) {
      if (futures) {
        tif = 'GTX'; // post-only / maker-only on Binance futures
      } else if (ty === 'LIMIT') {
        params.type = 'LIMIT_MAKER'; // spot post-only is a distinct order type, no timeInForce
        tif = null;
      } else {
        throw new Error('postOnly on spot is only supported for plain LIMIT orders (LIMIT_MAKER)');
      }
    }
    if (params.type !== 'LIMIT_MAKER') params.timeInForce = tif || 'GTC';
  }
  if (isStop) {
    params.stopPrice = String(requireFinite(stopPrice, 'stopPrice'));
  }
  if (newClientOrderId) params.newClientOrderId = String(newClientOrderId);
  // reduceOnly and closePosition are mutually exclusive on Binance.
  if (reduceOnly && futures && !closePosition) params.reduceOnly = 'true';

  // Hedge Mode: orders must carry positionSide (LONG/SHORT) and cannot use reduceOnly.
  let ps = positionSide ? String(positionSide).toUpperCase() : null;
  if (ps && !['LONG', 'SHORT', 'BOTH'].includes(ps)) throw new Error('positionSide must be LONG, SHORT, or BOTH');
  if (futures) {
    if (!ps && confirm) {
      const mode = await getPositionMode({ market, _deps: deps });
      if (mode.hedgeMode) throw new Error('Account is in Hedge Mode — pass positionSide:"LONG" or "SHORT" (CLI --positionSide) so the order targets the right position.');
    }
    if (ps && ps !== 'BOTH') {
      params.positionSide = ps;
      delete params.reduceOnly; // reduceOnly is rejected in hedge mode (positionSide implies it)
    } else if (ps === 'BOTH') {
      params.positionSide = 'BOTH';
    }
  }

  // Snap price/stopPrice/quantity to the symbol's tick/step so the order isn't rejected.
  let rounding_note;
  let contractSize;
  if (round) {
    try {
      const info = await getSymbolInfo({ market, symbol: sym, _deps: deps });
      contractSize = info.contractSize;
      if (params.price !== undefined) params.price = String(snap(params.price, info.tickSize, 'round'));
      if (params.stopPrice !== undefined) params.stopPrice = String(snap(params.stopPrice, info.tickSize, 'round'));
      if (params.quantity !== undefined) params.quantity = String(snap(params.quantity, info.stepSize, 'floor'));
    } catch (err) {
      if (confirm) throw new Error(`Could not load symbol filters to round price/qty (${err.message}). Pass round:false to place without rounding.`);
      rounding_note = `precision rounding skipped — filters unavailable (${err.message})`;
    }
  }

  // COIN-M sizes orders in CONTRACTS (fixed USD notional each), not coin amount — surface that.
  const coinm_note = coinm
    ? `COIN-M: quantity is in CONTRACTS, not coin amount${contractSize ? ` (1 contract = ${contractSize} USD)` : ' (see symbol-info contractSize)'}.`
    : undefined;

  // USD-M migrated conditional orders (STOP/TP/TRAILING) to the Algo endpoint (2025-12-09):
  // they POST to /fapi/v1/algoOrder with algoType=CONDITIONAL and `triggerPrice` (not stopPrice).
  const useAlgo = isStop && isFutures(market);
  let endpoint;
  if (useAlgo) {
    endpoint = `${futPrefix(market)}/v1/algoOrder`;
    params.algoType = 'CONDITIONAL';
    if (params.stopPrice !== undefined) { params.triggerPrice = params.stopPrice; delete params.stopPrice; }
    if (params.newClientOrderId !== undefined) { params.clientAlgoId = params.newClientOrderId; delete params.newClientOrderId; }
  } else {
    endpoint = futures ? `${futPrefix(market)}/v1/order` : '/api/v3/order';
  }

  const isLive = !resolveMarket(market, deps).includes('testnet');
  const preview = { market, endpoint, ...params, live_funds: isLive };

  if (!confirm) {
    return {
      success: false,
      dry_run: true,
      account,
      message: paperTrading
        ? `PAPER TRADING — would place a ${isLive ? 'LIVE (real funds)' : 'TESTNET'} ${useAlgo ? 'conditional (algo) order' : 'order'}; decision logged, nothing sent.`
        : `DRY RUN — no order sent. Pass confirm:true to place this ${isLive ? 'LIVE (real funds)' : 'TESTNET'} ${useAlgo ? 'conditional (algo) order' : 'order'}.`,
      ...paperFields(paperTrading),
      ...(coinm_note ? { coinm_note } : {}),
      ...(rounding_note ? { rounding_note } : {}),
      order_preview: preview,
    };
  }

  const data = await signedRequest({ market, method: 'POST', endpoint, params, _deps: deps });
  return { success: true, market, account, live_funds: isLive, algo: useAlgo, order: data };
}

/** Cancel an open order by orderId. */
export async function cancelOrder({ market = 'futures', symbol, orderId, origClientOrderId, account = '1', _deps = {} } = {}) {
  if (!symbol) throw new Error('symbol is required');
  if (orderId === undefined && !origClientOrderId) throw new Error('orderId or origClientOrderId is required');
  const deps = resolveDeps(account, _deps);
  const endpoint = isFuturesLike(market) ? `${futPrefix(market)}/v1/order` : '/api/v3/order';
  const params = { symbol: String(symbol).toUpperCase() };
  if (orderId !== undefined) params.orderId = String(orderId);
  if (origClientOrderId) params.origClientOrderId = String(origClientOrderId);
  const data = await signedRequest({ market, method: 'DELETE', endpoint, params, _deps: deps });
  return { success: true, market, canceled: data };
}

/** Amend a resting futures LIMIT order's price/quantity in place (PUT /fapi/v1/order),
 *  avoiding a cancel+replace. DRY-RUN preview unless confirm:true. Binance requires
 *  side + both price and quantity on a modify. */
export async function modifyOrder({
  market = 'futures', symbol, orderId, origClientOrderId, side, quantity, price,
  round = true, confirm = false, account = '1', _deps = {},
} = {}) {
  if (!isFuturesLike(market)) throw new Error('modifyOrder is futures-only');
  if (!symbol) throw new Error('symbol is required');
  if (orderId === undefined && !origClientOrderId) throw new Error('orderId or origClientOrderId is required');
  const sd = String(side || '').toUpperCase();
  if (!['BUY', 'SELL'].includes(sd)) throw new Error('side must be "BUY" or "SELL" (required by Binance modify)');
  const deps = resolveDeps(account, _deps);
  const paperTrading = usePaperTrading(_deps); if (paperTrading) confirm = false; // global kill-switch
  const params = { symbol: String(symbol).toUpperCase(), side: sd };
  if (orderId !== undefined) params.orderId = String(orderId);
  if (origClientOrderId) params.origClientOrderId = String(origClientOrderId);
  params.quantity = String(requireFinite(quantity, 'quantity'));
  params.price = String(requireFinite(price, 'price'));
  if (round) {
    try {
      const info = await getSymbolInfo({ market, symbol: params.symbol, _deps: deps });
      params.price = String(snap(params.price, info.tickSize, 'round'));
      params.quantity = String(snap(params.quantity, info.stepSize, 'floor'));
    } catch (err) {
      if (confirm) throw new Error(`Could not load symbol filters to round price/qty (${err.message}). Pass round:false to modify without rounding.`);
    }
  }
  const endpoint = `${futPrefix(market)}/v1/order`;
  if (!confirm) {
    return { success: false, dry_run: true, message: paperTrading ? 'PAPER TRADING — would amend this LIVE order; decision logged, nothing sent.' : 'DRY RUN — no modify sent. Pass confirm:true to amend this LIVE order.', ...paperFields(paperTrading), modify_preview: { market, endpoint, ...params } };
  }
  const data = await signedRequest({ market, method: 'PUT', endpoint, params, _deps: deps });
  return { success: true, market, modified: data };
}

/** Cancel a conditional (algo) order by algoId — USD-M futures, post-2025-12-09 migration. */
export async function cancelAlgoOrder({ market = 'futures', algoId, account = '1', _deps = {} } = {}) {
  if (!isFutures(market)) throw new Error('algo orders are USD-M futures only');
  if (algoId === undefined) throw new Error('algoId is required');
  const deps = resolveDeps(account, _deps);
  const data = await signedRequest({ market, method: 'DELETE', endpoint: `${futPrefix(market)}/v1/algoOrder`, params: { algoId: String(algoId) }, _deps: deps });
  return { success: true, market, canceled: data };
}

/** Get recent trades for a symbol (public endpoint, unsigned) */
export async function getRecentTrades({ market = 'futures', symbol, limit = 50, _deps = {} } = {}) {
  if (!symbol) throw new Error('symbol is required');
  const sym = String(symbol).toUpperCase();
  const lim = Math.max(1, Math.min(Number(limit) || 50, 1000));
  // endpoint differences: spot /api/v3/trades, USD-M /fapi/v1/trades, COIN-M /dapi/v1/trades
  const endpoint = isFuturesLike(market) ? `${futPrefix(market)}/v1/trades` : '/api/v3/trades';
  const data = await publicRequest({ market, endpoint, params: { symbol: sym, limit: String(lim) }, _deps });
  return { success: true, market, symbol: sym, count: data.length, trades: data };
}

/** Get aggregated trades (aggTrades) for a symbol (public) */
export async function getAggTrades({ market = 'futures', symbol, fromId, startTime, endTime, limit = 500, _deps = {} } = {}) {
  if (!symbol) throw new Error('symbol is required');
  const sym = String(symbol).toUpperCase();
  const params = { symbol: sym };
  if (fromId !== undefined) params.fromId = String(fromId);
  if (startTime !== undefined) params.startTime = String(requireFinite(startTime, 'startTime'));
  if (endTime !== undefined) params.endTime = String(requireFinite(endTime, 'endTime'));
  const lim = Math.max(1, Math.min(Number(limit) || 500, 1000));
  params.limit = String(lim);
  const endpoint = isFuturesLike(market) ? `${futPrefix(market)}/v1/aggTrades` : '/api/v3/aggTrades';
  const data = await publicRequest({ market, endpoint, params, _deps });
  return { success: true, market, symbol: sym, count: data.length, aggTrades: data };
}

/** Historical trades (spot only) — requires API key; we use signedRequest to include auth */
export async function getHistoricalTrades({ market = 'spot', symbol, fromId, limit = 500, account = '1', _deps = {} } = {}) {
  if (isFuturesLike(market)) throw new Error('historicalTrades is spot-only');
  if (!symbol) throw new Error('symbol is required');
  const sym = String(symbol).toUpperCase();
  const deps = resolveDeps(account, _deps);
  const params = { symbol: sym };
  if (fromId !== undefined) params.fromId = String(fromId);
  const lim = Math.max(1, Math.min(Number(limit) || 500, 1000));
  params.limit = String(lim);
  const endpoint = '/api/v3/historicalTrades';
  // historicalTrades requires an API key header but does not require signature
  const data = await publicRequest({ market, endpoint, params, includeApiKey: true, _deps: deps });
  return { success: true, market, symbol: sym, count: data.length, historicalTrades: data };
}

/** Account trade list (signed): user's trades for a symbol */
export async function getAccountTrades({ market = 'futures', symbol, fromId, limit = 500, account = '1', _deps = {} } = {}) {
  if (!symbol) throw new Error('symbol is required');
  const sym = String(symbol).toUpperCase();
  const deps = resolveDeps(account, _deps);
  const params = { symbol: sym };
  if (fromId !== undefined) params.fromId = String(fromId);
  const lim = Math.max(1, Math.min(Number(limit) || 500, 1000));
  params.limit = String(lim);
  const endpoint = isFuturesLike(market) ? `${futPrefix(market)}/v1/userTrades` : '/api/v3/myTrades';
  const data = await signedRequest({ market, endpoint, params, _deps: deps });
  return { success: true, market, symbol: sym, count: data.length, trades: data };
}

/** All orders for a symbol (signed): open, filled, and cancelled — not just resting ones. */
export async function getOrderHistory({ market = 'futures', symbol, orderId, startTime, endTime, limit = 500, account = '1', _deps = {} } = {}) {
  if (!symbol) throw new Error('symbol is required');
  const sym = String(symbol).toUpperCase();
  const deps = resolveDeps(account, _deps);
  const params = { symbol: sym };
  if (orderId !== undefined) params.orderId = String(orderId);
  if (startTime !== undefined) params.startTime = String(requireFinite(startTime, 'startTime'));
  if (endTime !== undefined) params.endTime = String(requireFinite(endTime, 'endTime'));
  params.limit = String(Math.max(1, Math.min(Number(limit) || 500, 1000)));
  const endpoint = isFuturesLike(market) ? `${futPrefix(market)}/v1/allOrders` : '/api/v3/allOrders';
  const data = await signedRequest({ market, endpoint, params, _deps: deps });
  return { success: true, market, symbol: sym, count: data.length, orders: data };
}

/** Futures income history (signed): realized PnL, funding fees, commissions, etc. — with a
 *  per-type summary. Filter by symbol/incomeType/time window. */
export async function getIncome({ market = 'futures', symbol, incomeType, startTime, endTime, limit = 100, account = '1', _deps = {} } = {}) {
  if (!isFuturesLike(market)) throw new Error('income history is futures-only');
  const deps = resolveDeps(account, _deps);
  const params = {};
  if (symbol) params.symbol = String(symbol).toUpperCase();
  if (incomeType) params.incomeType = String(incomeType).toUpperCase();
  if (startTime !== undefined) params.startTime = String(requireFinite(startTime, 'startTime'));
  if (endTime !== undefined) params.endTime = String(requireFinite(endTime, 'endTime'));
  params.limit = String(Math.max(1, Math.min(Number(limit) || 100, 1000)));
  const data = await signedRequest({ market, endpoint: `${futPrefix(market)}/v1/income`, params, _deps: deps });
  const summary = {};
  for (const r of (data || [])) summary[r.incomeType] = (summary[r.incomeType] || 0) + Number(r.income);
  for (const k of Object.keys(summary)) summary[k] = Number(summary[k].toFixed(8));
  return { success: true, market, account, count: (data || []).length, summary, income: data };
}

/** Forced-liquidation / ADL history (signed, futures only): the user's OWN positions that
 *  Binance force-closed. Filter by symbol, autoCloseType (LIQUIDATION | ADL) and time window
 *  (if startTime is omitted, Binance returns the 7 days before endTime). This is the
 *  backward-looking complement to getRiskReport's forward-looking distance-to-liquidation. */
export async function getLiquidationHistory({ market = 'futures', symbol, autoCloseType, startTime, endTime, limit = 50, account = '1', _deps = {} } = {}) {
  if (!isFuturesLike(market)) throw new Error('liquidation history is futures-only');
  const deps = resolveDeps(account, _deps);
  const params = {};
  if (symbol) params.symbol = String(symbol).toUpperCase();
  if (autoCloseType) {
    const t = String(autoCloseType).toUpperCase();
    if (!['LIQUIDATION', 'ADL'].includes(t)) throw new Error('autoCloseType must be LIQUIDATION or ADL');
    params.autoCloseType = t;
  }
  if (startTime !== undefined) params.startTime = String(requireFinite(startTime, 'startTime'));
  if (endTime !== undefined) params.endTime = String(requireFinite(endTime, 'endTime'));
  params.limit = String(Math.max(1, Math.min(Number(limit) || 50, 100)));
  const data = await signedRequest({ market, endpoint: `${futPrefix(market)}/v1/forceOrders`, params, _deps: deps });
  const orders = Array.isArray(data) ? data : [];
  return { success: true, market, account, count: orders.length, orders };
}

/** Latest price for a symbol (public). Handy for sizing before an order. */
export async function getTicker({ market = 'futures', symbol, _deps = {} } = {}) {
  if (!symbol) throw new Error('symbol is required');
  const sym = String(symbol).toUpperCase();
  const endpoint = isFuturesLike(market) ? `${futPrefix(market)}/v1/ticker/price` : '/api/v3/ticker/price';
  const data = await publicRequest({ market, endpoint, params: { symbol: sym }, _deps });
  // COIN-M returns an array (one per contract); USD-M/spot return a single object.
  const tick = Array.isArray(data) ? (data.find((t) => t.symbol === sym) || data[0] || {}) : data;
  return { success: true, market, symbol: tick.symbol || sym, price: tick.price };
}

/** Order book depth (public). */
export async function getOrderBook({ market = 'futures', symbol, limit = 20, _deps = {} } = {}) {
  if (!symbol) throw new Error('symbol is required');
  const sym = String(symbol).toUpperCase();
  const lim = Math.max(1, Math.min(Number(limit) || 20, 1000));
  const endpoint = isFuturesLike(market) ? `${futPrefix(market)}/v1/depth` : '/api/v3/depth';
  const data = await publicRequest({ market, endpoint, params: { symbol: sym, limit: String(lim) }, _deps });
  return {
    success: true, market, symbol: sym,
    bids: (data.bids || []).map(([p, q]) => ({ price: p, qty: q })),
    asks: (data.asks || []).map(([p, q]) => ({ price: p, qty: q })),
  };
}

// Klines/candlesticks come back as positional arrays; name the fields we expose.
const KLINE_INTERVALS = ['1s', '1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '3d', '1w', '1M'];

/** Candlesticks (klines) for a symbol (public). Pulls OHLCV for the EXACT Binance
 *  contract you trade (e.g. BTCUSDC futures), independent of any TradingView chart. */
export async function getKlines({ market = 'futures', symbol, interval = '1h', startTime, endTime, limit = 500, extended = false, _deps = {} } = {}) {
  if (!symbol) throw new Error('symbol is required');
  const sym = String(symbol).toUpperCase();
  const iv = String(interval);
  if (!KLINE_INTERVALS.includes(iv)) throw new Error(`interval must be one of: ${KLINE_INTERVALS.join(', ')}`);
  const params = { symbol: sym, interval: iv };
  if (startTime !== undefined) params.startTime = String(requireFinite(startTime, 'startTime'));
  if (endTime !== undefined) params.endTime = String(requireFinite(endTime, 'endTime'));
  // spot caps at 1000 bars/request, futures at 1500.
  const cap = isFuturesLike(market) ? 1500 : 1000;
  params.limit = String(Math.max(1, Math.min(Number(limit) || 500, cap)));
  const endpoint = isFuturesLike(market) ? `${futPrefix(market)}/v1/klines` : '/api/v3/klines';
  const data = await publicRequest({ market, endpoint, params, _deps });
  const candles = (data || []).map((k) => mapKline(k, extended));
  return { success: true, market, symbol: sym, interval: iv, count: candles.length, candles };
}

// Klines come back as positional arrays — name the fields we expose. With `extended`, also
// surface the order-flow columns Binance returns (quote volume, trade count, taker buys) —
// useful for flow analysis, off by default to keep payloads compact.
const mapKline = (k, extended = false) => {
  const c = { openTime: k[0], open: k[1], high: k[2], low: k[3], close: k[4], volume: k[5], closeTime: k[6] };
  if (extended) {
    c.quoteVolume = k[7];
    c.trades = k[8];
    c.takerBuyVolume = k[9];
    c.takerBuyQuoteVolume = k[10];
  }
  return c;
};

/** UI-optimized candlesticks (spot-only `/api/v3/uiKlines`) — same shape as getKlines but the
 *  bars are tuned by Binance for chart presentation (consistent spacing at boundaries). */
export async function getUiKlines({ market = 'spot', symbol, interval = '1h', startTime, endTime, limit = 500, extended = false, _deps = {} } = {}) {
  if (isFuturesLike(market)) throw new Error('uiKlines is spot-only (use getKlines for futures)');
  if (!symbol) throw new Error('symbol is required');
  const sym = String(symbol).toUpperCase();
  const iv = String(interval);
  if (!KLINE_INTERVALS.includes(iv)) throw new Error(`interval must be one of: ${KLINE_INTERVALS.join(', ')}`);
  const params = { symbol: sym, interval: iv };
  if (startTime !== undefined) params.startTime = String(requireFinite(startTime, 'startTime'));
  if (endTime !== undefined) params.endTime = String(requireFinite(endTime, 'endTime'));
  params.limit = String(Math.max(1, Math.min(Number(limit) || 500, 1000)));
  const data = await publicRequest({ market, endpoint: '/api/v3/uiKlines', params, _deps });
  const candles = (data || []).map((k) => mapKline(k, extended));
  return { success: true, market, symbol: sym, interval: iv, count: candles.length, candles };
}

// Shape a raw 24hr/tradingDay ticker row into our compact field set.
const map24hr = (t) => ({
  symbol: t.symbol,
  lastPrice: t.lastPrice, priceChange: t.priceChange, priceChangePercent: t.priceChangePercent,
  weightedAvgPrice: t.weightedAvgPrice, highPrice: t.highPrice, lowPrice: t.lowPrice,
  openPrice: t.openPrice, volume: t.volume, quoteVolume: t.quoteVolume,
});
// Shape a raw bookTicker row, computing the spread.
const mapBook = (t) => {
  const bid = Number(t.bidPrice), ask = Number(t.askPrice);
  const spread = Number.isFinite(bid) && Number.isFinite(ask) ? ask - bid : undefined;
  return {
    symbol: t.symbol, bidPrice: t.bidPrice, bidQty: t.bidQty, askPrice: t.askPrice, askQty: t.askQty,
    spread: spread !== undefined ? String(spread) : undefined,
    spreadPct: spread !== undefined && bid ? `${(spread / bid * 100).toFixed(4)}%` : undefined,
  };
};
// Keep only symbols ending in the given quote asset (e.g. "USDC") — for one-call screening.
const filterByQuote = (rows, quote) => {
  if (!quote) return rows;
  const q = String(quote).toUpperCase();
  return rows.filter((r) => (r.symbol || '').toUpperCase().endsWith(q));
};

/** 24-hour rolling price-change stats (public). Single symbol by default; pass `all:true` to
 *  return every symbol on the market (optionally narrowed to a `quote` asset, e.g. "USDC"). */
export async function get24hrTicker({ market = 'futures', symbol, all = false, quote, _deps = {} } = {}) {
  const endpoint = isFuturesLike(market) ? `${futPrefix(market)}/v1/ticker/24hr` : '/api/v3/ticker/24hr';
  if (all) {
    const data = await publicRequest({ market, endpoint, _deps }); // no symbol ⇒ array of all
    const tickers = filterByQuote((Array.isArray(data) ? data : []).map(map24hr), quote);
    return { success: true, market, all: true, quote: quote ? String(quote).toUpperCase() : undefined, count: tickers.length, tickers };
  }
  if (!symbol) throw new Error('symbol is required (or pass all:true)');
  const sym = String(symbol).toUpperCase();
  const data = await publicRequest({ market, endpoint, params: { symbol: sym }, _deps });
  // COIN-M returns an array (one row per contract); pick the matching symbol.
  const t = Array.isArray(data) ? (data.find((x) => x.symbol === sym) || data[0] || {}) : data;
  return { success: true, market, ...map24hr({ ...t, symbol: t.symbol || sym }) };
}

/** Best bid/ask (top of book) with computed spread (public). Single symbol by default; pass
 *  `all:true` for every symbol on the market (optionally narrowed to a `quote` asset). */
export async function getBookTicker({ market = 'futures', symbol, all = false, quote, _deps = {} } = {}) {
  const endpoint = isFuturesLike(market) ? `${futPrefix(market)}/v1/ticker/bookTicker` : '/api/v3/ticker/bookTicker';
  if (all) {
    const data = await publicRequest({ market, endpoint, _deps }); // no symbol ⇒ array of all
    const tickers = filterByQuote((Array.isArray(data) ? data : []).map(mapBook), quote);
    return { success: true, market, all: true, quote: quote ? String(quote).toUpperCase() : undefined, count: tickers.length, tickers };
  }
  if (!symbol) throw new Error('symbol is required (or pass all:true)');
  const sym = String(symbol).toUpperCase();
  const data = await publicRequest({ market, endpoint, params: { symbol: sym }, _deps });
  const t = Array.isArray(data) ? (data.find((x) => x.symbol === sym) || data[0] || {}) : data;
  return { success: true, market, ...mapBook({ ...t, symbol: t.symbol || sym }) };
}

/** Trading-day price-change stats (spot-only `/api/v3/ticker/tradingDay`) — like 24hr but
 *  anchored to the exchange trading day in `timeZone` (default 0/UTC). One `symbol`, or a
 *  `symbols` list (array or CSV) to scan several at once. */
export async function getTradingDayTicker({ market = 'spot', symbol, symbols, timeZone, _deps = {} } = {}) {
  if (isFuturesLike(market)) throw new Error('tradingDay ticker is spot-only');
  const list = Array.isArray(symbols) ? symbols : (typeof symbols === 'string' && symbols ? symbols.split(',') : null);
  const params = {};
  if (timeZone !== undefined) params.timeZone = String(timeZone);
  if (list && list.length) {
    params.symbols = JSON.stringify(list.map((s) => String(s).trim().toUpperCase()));
    const data = await publicRequest({ market, endpoint: '/api/v3/ticker/tradingDay', params, _deps });
    const tickers = (Array.isArray(data) ? data : [data]).map(map24hr);
    return { success: true, market, count: tickers.length, tickers };
  }
  if (!symbol) throw new Error('symbol or symbols is required');
  params.symbol = String(symbol).toUpperCase();
  const data = await publicRequest({ market, endpoint: '/api/v3/ticker/tradingDay', params, _deps });
  const t = Array.isArray(data) ? (data[0] || {}) : data;
  return { success: true, market, ...map24hr({ ...t, symbol: t.symbol || params.symbol }) };
}

/** Current average price over a short window (spot-only; Binance returns ~5-min avg). */
export async function getAvgPrice({ market = 'spot', symbol, _deps = {} } = {}) {
  if (isFuturesLike(market)) throw new Error('avgPrice is spot-only (use get24hrTicker.weightedAvgPrice for futures)');
  if (!symbol) throw new Error('symbol is required');
  const sym = String(symbol).toUpperCase();
  const data = await publicRequest({ market, endpoint: '/api/v3/avgPrice', params: { symbol: sym }, _deps });
  return { success: true, market, symbol: sym, mins: data.mins, price: data.price };
}

/** Rolling-window price-change stats with a custom window (spot-only; windowSize e.g. "1d", "4h").
 *  Binance's `/api/v3/ticker` has no bare "all" — scan several at once with a `symbols` list
 *  (array or CSV) instead. */
export async function getRollingWindowTicker({ market = 'spot', symbol, symbols, windowSize = '1d', _deps = {} } = {}) {
  if (isFuturesLike(market)) throw new Error('rolling-window ticker is spot-only (use get24hrTicker for futures)');
  const win = String(windowSize);
  const list = Array.isArray(symbols) ? symbols : (typeof symbols === 'string' && symbols ? symbols.split(',') : null);
  if (list && list.length) {
    const params = { symbols: JSON.stringify(list.map((s) => String(s).trim().toUpperCase())), windowSize: win };
    const data = await publicRequest({ market, endpoint: '/api/v3/ticker', params, _deps });
    const tickers = (Array.isArray(data) ? data : [data]).map((t) => ({ ...map24hr(t), windowSize: win }));
    return { success: true, market, windowSize: win, count: tickers.length, tickers };
  }
  if (!symbol) throw new Error('symbol or symbols is required');
  const sym = String(symbol).toUpperCase();
  const data = await publicRequest({ market, endpoint: '/api/v3/ticker', params: { symbol: sym, windowSize: win }, _deps });
  const t = Array.isArray(data) ? (data[0] || {}) : data;
  return { success: true, market, windowSize: win, ...map24hr({ ...t, symbol: t.symbol || sym }) };
}

const COMPARE_SORT_KEYS = ['priceChangePercent', 'priceChange', 'quoteVolume', 'volume', 'lastPrice'];

/** Compare several symbols side-by-side on 24-hour stats, ranked by one metric (public). Fetches
 *  each symbol's 24hr ticker (works on spot/futures/coinm), then returns a sorted, ranked table
 *  plus the leader/laggard. `symbols` is an array or CSV; `sortBy` is one of priceChangePercent
 *  (default), priceChange, quoteVolume, volume, lastPrice (descending). Unknown sortBy falls back
 *  to priceChangePercent. */
export async function compareSymbols({ market = 'futures', symbols, sortBy = 'priceChangePercent', _deps = {} } = {}) {
  const list = Array.isArray(symbols) ? symbols : (typeof symbols === 'string' && symbols ? symbols.split(',') : null);
  const syms = [...new Set((list || []).map((s) => String(s).trim().toUpperCase()).filter(Boolean))];
  if (!syms.length) throw new Error('symbols is required (array or CSV, e.g. "BTCUSDC,ETHUSDC")');
  const key = COMPARE_SORT_KEYS.includes(sortBy) ? sortBy : 'priceChangePercent';
  const rows = await Promise.all(syms.map(async (sym) => {
    const t = await get24hrTicker({ market, symbol: sym, _deps });
    return {
      symbol: sym, lastPrice: t.lastPrice,
      priceChange: t.priceChange, priceChangePercent: t.priceChangePercent,
      highPrice: t.highPrice, lowPrice: t.lowPrice,
      volume: t.volume, quoteVolume: t.quoteVolume,
    };
  }));
  rows.sort((a, b) => (Number(b[key]) || 0) - (Number(a[key]) || 0));
  rows.forEach((r, i) => { r.rank = i + 1; });
  return {
    success: true, market, sortBy: key, count: rows.length,
    leader: rows[0] ? rows[0].symbol : undefined,
    laggard: rows.length ? rows[rows.length - 1].symbol : undefined,
    comparison: rows,
  };
}

/** Funding rate for a perpetual (public). Default returns the current premium-index snapshot
 *  (mark/index price + last & next funding); history:true returns recent funding payments. */
export async function getFundingRate({ market = 'futures', symbol, history = false, limit = 10, _deps = {} } = {}) {
  if (!isFuturesLike(market)) throw new Error('funding rate is futures-only');
  if (!symbol) throw new Error('symbol is required');
  const sym = String(symbol).toUpperCase();
  if (history) {
    const lim = Math.max(1, Math.min(Number(limit) || 10, 1000));
    const data = await publicRequest({ market, endpoint: `${futPrefix(market)}/v1/fundingRate`, params: { symbol: sym, limit: String(lim) }, _deps });
    return {
      success: true, market, symbol: sym, count: data.length,
      fundingHistory: (data || []).map((f) => ({ fundingRate: f.fundingRate, fundingRatePct: `${(Number(f.fundingRate) * 100).toFixed(4)}%`, fundingTime: f.fundingTime })),
    };
  }
  const data = await publicRequest({ market, endpoint: `${futPrefix(market)}/v1/premiumIndex`, params: { symbol: sym }, _deps });
  const t = Array.isArray(data) ? (data.find((x) => x.symbol === sym) || data[0] || {}) : data;
  return {
    success: true, market, symbol: t.symbol || sym,
    markPrice: t.markPrice, indexPrice: t.indexPrice,
    lastFundingRate: t.lastFundingRate,
    lastFundingRatePct: t.lastFundingRate != null ? `${(Number(t.lastFundingRate) * 100).toFixed(4)}%` : undefined,
    nextFundingTime: t.nextFundingTime, interestRate: t.interestRate,
  };
}

// ── User-data stream (listenKey) ─────────────────────────────────────────────
// Powers real-time PUSH of order fills, position and balance changes over a WebSocket —
// the low-latency alternative to polling getAccountSnapshot. The REST calls here manage the
// listenKey lifecycle; the actual WS loop lives in the `tv binance user-stream` CLI subcommand
// (a long-running loop, like `tv binance stream`). Uses the API key header only (NOT signed).
const WS_BASES = {
  spot: 'wss://stream.binance.com:9443',
  futures: 'wss://fstream.binance.com',
  coinm: 'wss://dstream.binance.com',
  'spot-testnet': 'wss://stream.testnet.binance.vision',
  'futures-testnet': 'wss://stream.binancefuture.com',
  'coinm-testnet': 'wss://dstream.binancefuture.com',
};
const listenKeyEndpoint = (market) => (isFuturesLike(market) ? `${futPrefix(market)}/v1/listenKey` : '/api/v3/userDataStream');

/** Open a user-data stream: returns a `listenKey` and the `wsUrl` to connect to. The key
 *  expires ~60 min after creation unless refreshed via keepAliveUserStream. Per-account. */
export async function startUserStream({ market = 'futures', account = '1', _deps = {} } = {}) {
  const deps = resolveDeps(account, _deps);
  const data = await publicRequest({ market, method: 'POST', endpoint: listenKeyEndpoint(market), includeApiKey: true, _deps: deps });
  if (!data || !data.listenKey) throw new Error('Binance returned no listenKey');
  return { success: true, market, account, listenKey: data.listenKey, wsUrl: `${WS_BASES[resolveMarket(market, deps)]}/ws/${data.listenKey}` };
}

/** Refresh a user-data stream's 60-min expiry (call ~every 30 min). Futures key off the account;
 *  spot requires the listenKey as a parameter. */
export async function keepAliveUserStream({ market = 'futures', account = '1', listenKey, _deps = {} } = {}) {
  const deps = resolveDeps(account, _deps);
  const futuresLike = isFuturesLike(market);
  if (!futuresLike && !listenKey) throw new Error('listenKey is required to keep a spot stream alive');
  const params = futuresLike ? {} : { listenKey: String(listenKey) };
  await publicRequest({ market, method: 'PUT', endpoint: listenKeyEndpoint(market), params, includeApiKey: true, _deps: deps });
  return { success: true, market, account };
}

/** Close a user-data stream (best-effort cleanup on shutdown). */
export async function closeUserStream({ market = 'futures', account = '1', listenKey, _deps = {} } = {}) {
  const deps = resolveDeps(account, _deps);
  const futuresLike = isFuturesLike(market);
  const params = futuresLike ? {} : { listenKey: String(listenKey || '') };
  await publicRequest({ market, method: 'DELETE', endpoint: listenKeyEndpoint(market), params, includeApiKey: true, _deps: deps });
  return { success: true, market, account };
}

/** Watch a symbol's live trades over a public WebSocket for a bounded window, then return a
 *  compact summary (open/high/low/close + change, VWAP, volume, tick count). Public/unsigned —
 *  subscribes to the `<symbol>@aggTrade` stream (available on spot, USD-M and COIN-M). This is
 *  the bounded, request/response counterpart to the unbounded `tv binance stream` loop: an
 *  agent can ask "watch BTC for 15s and tell me what happened" and get one result back.
 *  `durationSec` is clamped to [1, 60]. If the socket closes early, whatever was collected is
 *  summarized. `_deps.WebSocket` / `_deps.setTimeout` / `_deps.clearTimeout` are injectable
 *  for testing (defaults to the runtime globals). */
export async function watchPrice({ market = 'futures', symbol, durationSec = 10, _deps = {} } = {}) {
  if (!symbol) throw new Error('symbol is required');
  const sym = String(symbol).toUpperCase();
  const dur = Math.max(1, Math.min(Number(durationSec) || 10, 60));
  const base = WS_BASES[resolveMarket(market, _deps)];
  if (!base) throw new Error(`unknown market ${market}`);
  const WS = _deps.WebSocket || (typeof WebSocket !== 'undefined' ? WebSocket : null);
  if (!WS) throw new Error('WebSocket is not available in this runtime');
  const setTimer = _deps.setTimeout || setTimeout;
  const clearTimer = _deps.clearTimeout || clearTimeout;
  const wsUrl = `${base}/ws/${sym.toLowerCase()}@aggTrade`;

  return new Promise((resolve, reject) => {
    const ticks = [];
    let settled = false, timer = null, ws;

    const summarize = () => {
      const n = ticks.length;
      if (!n) {
        return {
          success: true, market, symbol: sym, durationSec: dur, ticks: 0,
          note: 'No trades observed in the window (illiquid pair, wrong symbol/market, or window too short).',
        };
      }
      let high = -Infinity, low = Infinity, volume = 0, pv = 0;
      for (const t of ticks) {
        if (t.price > high) high = t.price;
        if (t.price < low) low = t.price;
        volume += t.qty;
        pv += t.price * t.qty;
      }
      const open = ticks[0].price, close = ticks[n - 1].price, change = close - open;
      return {
        success: true, market, symbol: sym, durationSec: dur, ticks: n,
        open, high, low, close, change,
        changePct: open ? `${((change / open) * 100).toFixed(4)}%` : undefined,
        vwap: volume > 0 ? Number((pv / volume).toFixed(8)) : undefined,
        volume: Number(volume.toFixed(8)),
        firstTradeTime: ticks[0].time, lastTradeTime: ticks[n - 1].time,
      };
    };

    const finish = (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimer(timer);
      try { ws && ws.close(); } catch { /* ignore */ }
      if (err) reject(err); else resolve(summarize());
    };

    try { ws = new WS(wsUrl); } catch (e) { return finish(e); }
    timer = setTimer(() => finish(), dur * 1000);
    ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      const price = Number(m.p), qty = Number(m.q);
      if (Number.isFinite(price)) ticks.push({ price, qty: Number.isFinite(qty) ? qty : 0, time: m.T });
    });
    ws.addEventListener('error', () => { /* a close event follows; we summarize there */ });
    ws.addEventListener('close', () => finish());
  });
}

// ── Public market-data stream (combined multiplex) ───────────────────────────
// Continuous PUSH of public market data — the unbounded, multi-symbol/multi-stream-type
// counterpart to the bounded watchPrice. buildMarketStream() builds the combined-stream URL
// (`/stream?streams=a@trade/b@bookTicker/…`) and is pure/DI-testable like startUserStream;
// the actual WS loop lives in the `tv binance market-stream` CLI subcommand. Unsigned/public.
const PUBLIC_STREAM_KINDS = new Set(['trade', 'aggTrade', 'ticker', 'bookTicker', 'kline', 'markPrice', 'funding']);

/** Map one stream spec → its Binance suffix. Specs are a kind, optionally `kind:arg`
 *  (only `kline:<interval>` uses the arg, defaulting to 1m). On futures, the `markPrice`
 *  stream already carries the funding rate + next funding time, so `funding` is an alias
 *  for it. markPrice/funding are futures-only. */
function streamSuffix(spec, market) {
  const [kind, arg] = String(spec).trim().split(':');
  if (!PUBLIC_STREAM_KINDS.has(kind))
    throw new Error(`unknown stream "${spec}" (use trade, aggTrade, ticker, bookTicker, kline[:1m], markPrice, funding)`);
  if ((kind === 'markPrice' || kind === 'funding') && !isFuturesLike(market))
    throw new Error(`${kind} stream is futures-only`);
  switch (kind) {
    case 'trade': return '@trade';
    case 'aggTrade': return '@aggTrade';
    case 'ticker': return '@ticker';
    case 'bookTicker': return '@bookTicker';
    case 'kline': return `@kline_${arg || '1m'}`;
    case 'markPrice':
    case 'funding': return '@markPrice@1s';
  }
}

/** Build the combined-stream WebSocket URL for one or more symbols × stream types. Returns the
 *  resolved market, the (de-duplicated) raw subscription names and the wsUrl to connect to —
 *  this is the testable seam; the CLI loop just opens the socket. `symbols`/`streams` are arrays
 *  or CSV strings; `streams` defaults to `trade`. */
export function buildMarketStream({ market = 'futures', symbols, streams = 'trade', _deps = {} } = {}) {
  const m = resolveMarket(market, _deps);
  const base = WS_BASES[m];
  if (!base) throw new Error(`unknown market ${market}`);
  const symList = [...new Set((Array.isArray(symbols) ? symbols : (typeof symbols === 'string' ? symbols.split(',') : []))
    .map((s) => String(s).trim().toUpperCase()).filter(Boolean))];
  if (!symList.length) throw new Error('symbols is required (array or CSV, e.g. "BTCUSDC,ETHUSDC")');
  const streamList = (Array.isArray(streams) ? streams : String(streams).split(','))
    .map((s) => String(s).trim()).filter(Boolean);
  if (!streamList.length) throw new Error('streams is required (e.g. "trade,bookTicker,markPrice")');
  const subscriptions = [];
  for (const sym of symList)
    for (const spec of streamList)
      subscriptions.push(`${sym.toLowerCase()}${streamSuffix(spec, m)}`);
  const uniq = [...new Set(subscriptions)];
  return {
    success: true, market: m, symbols: symList, streams: streamList,
    subscriptions: uniq, wsUrl: `${base}/stream?streams=${uniq.join('/')}`,
  };
}

/** Normalize a combined-stream message into a compact, uniform line. Accepts the wrapped
 *  `{ stream, data }` envelope (combined streams) or a bare event. Unknown events fall back to
 *  `{ event, stream, raw }`. Note: spot `bookTicker` carries no `e` field, so it's detected by
 *  its b/a/s shape. */
export function formatMarketEvent(msg) {
  const stream = msg && msg.stream;
  const d = (msg && msg.data) || msg || {};
  const e = d.e;
  if (e === 'trade' || e === 'aggTrade')
    return { event: e, symbol: d.s, price: Number(d.p), qty: Number(d.q), time: d.T, buyerMaker: d.m };
  if (e === '24hrTicker')
    return { event: 'ticker', symbol: d.s, last: Number(d.c), changePct: Number(d.P), high: Number(d.h), low: Number(d.l), volume: Number(d.v), quoteVolume: Number(d.q) };
  if (e === 'markPriceUpdate')
    return { event: 'markPrice', symbol: d.s, mark: Number(d.p), index: Number(d.i), fundingRate: Number(d.r), nextFundingTime: d.T, time: d.E };
  if (e === 'kline') {
    const k = d.k || {};
    return { event: 'kline', symbol: d.s, interval: k.i, open: Number(k.o), high: Number(k.h), low: Number(k.l), close: Number(k.c), volume: Number(k.v), closed: k.x, openTime: k.t, closeTime: k.T };
  }
  if (e === 'bookTicker' || (d.b !== undefined && d.a !== undefined && d.s))
    return { event: 'bookTicker', symbol: d.s, bid: Number(d.b), bidQty: Number(d.B), ask: Number(d.a), askQty: Number(d.A), time: d.T || d.E };
  return { event: e || 'unknown', stream, raw: d };
}

/** Symbol trading filters (tick size, step size, min notional) — use these to
 *  round price/quantity so orders aren't rejected for bad precision. */
export async function getSymbolInfo({ market = 'futures', symbol, _deps = {} } = {}) {
  if (!symbol) throw new Error('symbol is required');
  const sym = String(symbol).toUpperCase();
  const endpoint = isFuturesLike(market) ? `${futPrefix(market)}/v1/exchangeInfo` : '/api/v3/exchangeInfo';
  // Spot supports ?symbol=; futures (USD-M & COIN-M) return all symbols — filter client-side.
  const params = isFuturesLike(market) ? {} : { symbol: sym };
  const data = await publicRequest({ market, endpoint, params, _deps });
  const s = (data.symbols || []).find((x) => x.symbol === sym);
  if (!s) throw new Error(`symbol ${sym} not found on ${market}`);
  const f = (type) => (s.filters || []).find((x) => x.filterType === type) || {};
  return {
    success: true, market, symbol: sym, status: s.status,
    pricePrecision: s.pricePrecision, quantityPrecision: s.quantityPrecision,
    contractSize: s.contractSize, // COIN-M only: USD notional per contract
    tickSize: f('PRICE_FILTER').tickSize,
    stepSize: f('LOT_SIZE').stepSize,
    minQty: f('LOT_SIZE').minQty,
    minNotional: (f('MIN_NOTIONAL').notional || f('MIN_NOTIONAL').minNotional),
  };
}

/** Whether the futures account is in Hedge Mode (dualSidePosition) vs one-way. */
export async function getPositionMode({ market = 'futures', account = '1', _deps = {} } = {}) {
  if (!isFuturesLike(market)) throw new Error('position mode is futures-only');
  const deps = resolveDeps(account, _deps);
  const data = await signedRequest({ market, endpoint: `${futPrefix(market)}/v1/positionSide/dual`, _deps: deps });
  return { success: true, market, account, hedgeMode: !!data.dualSidePosition };
}

/** Switch the futures account between Hedge Mode (true) and one-way (false).
 *  Idempotent: Binance's "no need to change" (-4059) is treated as success. */
export async function setPositionMode({ market = 'futures', hedgeMode, account = '1', _deps = {} } = {}) {
  if (!isFuturesLike(market)) throw new Error('position mode is futures-only');
  if (typeof hedgeMode !== 'boolean') throw new Error('hedgeMode must be true (Hedge Mode) or false (one-way)');
  const deps = resolveDeps(account, _deps);
  const params = { dualSidePosition: hedgeMode ? 'true' : 'false' };
  try {
    await signedRequest({ market, method: 'POST', endpoint: `${futPrefix(market)}/v1/positionSide/dual`, params, _deps: deps });
    return { success: true, market, account, hedgeMode, changed: true };
  } catch (err) {
    // -4059: "No need to change position side." — already in the requested mode.
    if (/-4059|No need to change/i.test(err.message)) return { success: true, market, account, hedgeMode, changed: false };
    throw err;
  }
}

/** Maker/taker commission rate for a symbol — confirms a "0 maker fee" pair. */
export async function getCommissionRate({ market = 'futures', symbol, account = '1', _deps = {} } = {}) {
  if (!symbol) throw new Error('symbol is required');
  const sym = String(symbol).toUpperCase();
  const deps = resolveDeps(account, _deps);
  if (isFuturesLike(market)) {
    const d = await signedRequest({ market, endpoint: `${futPrefix(market)}/v1/commissionRate`, params: { symbol: sym }, _deps: deps });
    return { success: true, market, symbol: sym, makerCommissionRate: d.makerCommissionRate, takerCommissionRate: d.takerCommissionRate };
  }
  // Spot: commission rates come from the account/commission endpoint.
  const d = await signedRequest({ market, endpoint: '/api/v3/account/commission', params: { symbol: sym }, _deps: deps });
  return { success: true, market, symbol: sym, standardCommission: d.standardCommission, taxCommission: d.taxCommission };
}

/** Round a price/quantity to a symbol's tickSize/stepSize (reads exchangeInfo). */
export async function roundToFilters({ market = 'futures', symbol, price, quantity, stopPrice, _deps = {} } = {}) {
  const info = await getSymbolInfo({ market, symbol, _deps });
  const out = { success: true, market, symbol: info.symbol, tickSize: info.tickSize, stepSize: info.stepSize };
  if (price !== undefined) out.price = snap(price, info.tickSize, 'round');
  if (stopPrice !== undefined) out.stopPrice = snap(stopPrice, info.tickSize, 'round');
  if (quantity !== undefined) out.quantity = snap(quantity, info.stepSize, 'floor');
  return out;
}

/** Set leverage for a futures symbol (signed, futures-only). */
export async function setLeverage({ market = 'futures', symbol, leverage, account = '1', _deps = {} } = {}) {
  if (!isFuturesLike(market)) throw new Error('setLeverage is futures-only');
  if (!symbol) throw new Error('symbol is required');
  const lev = requireFinite(leverage, 'leverage');
  if (lev < 1 || lev > 125) throw new Error('leverage must be between 1 and 125');
  const deps = resolveDeps(account, _deps);
  const params = { symbol: String(symbol).toUpperCase(), leverage: String(Math.trunc(lev)) };
  const data = await signedRequest({ market, method: 'POST', endpoint: `${futPrefix(market)}/v1/leverage`, params, _deps: deps });
  return { success: true, market, leverage: data.leverage, maxNotionalValue: data.maxNotionalValue, symbol: data.symbol };
}

/** Set margin type ISOLATED|CROSSED for a futures symbol (signed, futures-only). */
export async function setMarginType({ market = 'futures', symbol, marginType, account = '1', _deps = {} } = {}) {
  if (!isFuturesLike(market)) throw new Error('setMarginType is futures-only');
  if (!symbol) throw new Error('symbol is required');
  const mt = String(marginType || '').toUpperCase();
  if (!['ISOLATED', 'CROSSED'].includes(mt)) throw new Error('marginType must be ISOLATED or CROSSED');
  const deps = resolveDeps(account, _deps);
  const params = { symbol: String(symbol).toUpperCase(), marginType: mt };
  // Binance returns code 200 {"code":200,"msg":"success"}; -4046 = "no need to change".
  const data = await signedRequest({ market, method: 'POST', endpoint: `${futPrefix(market)}/v1/marginType`, params, _deps: deps });
  return { success: true, market, marginType: mt, response: data };
}

/**
 * Add or remove margin on an ISOLATED futures position (POST /fapi|/dapi /v1/positionMargin).
 * Pushes the liquidation price further away (add) or frees collateral (remove) WITHOUT closing
 * the position. Only valid for a symbol in ISOLATED margin mode with an open position.
 *
 * DRY-RUN by default — it moves funds against a live position, so like the order helpers it
 * previews unless confirm:true. In Hedge Mode the target is ambiguous (LONG vs SHORT), so
 * positionSide is required; one-way mode defaults to BOTH. Futures only (USD-M and COIN-M).
 * Idea borrowed from muvon/mcp-binance-futures.
 */
export async function adjustIsolatedMargin({ market = 'futures', symbol, amount, direction = 'add', positionSide, account = '1', confirm = false, _deps = {} } = {}) {
  if (!isFuturesLike(market)) throw new Error('adjustIsolatedMargin is futures-only');
  if (!symbol) throw new Error('symbol is required');
  const dir = String(direction).toLowerCase();
  if (!['add', 'remove'].includes(dir)) throw new Error("direction must be 'add' or 'remove'");
  const amt = requireFinite(amount, 'amount');
  if (amt <= 0) throw new Error('amount must be > 0');
  const deps = resolveDeps(account, _deps);
  const paperTrading = usePaperTrading(_deps); if (paperTrading) confirm = false; // global kill-switch
  const sym = String(symbol).toUpperCase();
  const type = dir === 'add' ? 1 : 2; // Binance positionMargin `type`: 1 = add, 2 = remove
  const params = { symbol: sym, amount: String(amt), type: String(type) };
  let ps = positionSide ? String(positionSide).toUpperCase() : null;
  if (ps && !['LONG', 'SHORT', 'BOTH'].includes(ps)) throw new Error('positionSide must be LONG, SHORT, or BOTH');
  // Hedge Mode needs an explicit LONG/SHORT — refuse to guess which position to fund.
  if (!ps && confirm) {
    const mode = await getPositionMode({ market, _deps: deps });
    if (mode.hedgeMode) throw new Error('Account is in Hedge Mode — pass positionSide:"LONG" or "SHORT" (CLI --positionSide) so the margin change targets the right position.');
  }
  if (ps) params.positionSide = ps;
  const endpoint = `${futPrefix(market)}/v1/positionMargin`;
  const isLive = !market.includes('testnet');
  if (!confirm) {
    return {
      success: false, dry_run: true, market, account,
      message: paperTrading
        ? `PAPER TRADING — would ${dir} ${amt} ${dir === 'add' ? 'into' : 'out of'} the ISOLATED ${sym} position; decision logged, nothing sent.`
        : `DRY RUN — no margin moved. Pass confirm:true to ${dir} ${amt} ${dir === 'add' ? 'into' : 'out of'} the ISOLATED ${sym} position${isLive ? ' (real funds)' : ' (testnet)'}.`,
      ...paperFields(paperTrading),
      margin_preview: { market, endpoint, ...params, action: dir },
    };
  }
  const data = await signedRequest({ market, method: 'POST', endpoint, params, _deps: deps });
  return { success: true, market, account, symbol: sym, action: dir, amount: amt, positionSide: ps || 'BOTH', response: data };
}

/** Leverage/margin tiers (brackets) per notional for a symbol — shows max leverage
 *  and maintenance-margin steps. Backs risk decisions (and your 3x-max rule). */
export async function getLeverageBrackets({ market = 'futures', symbol, account = '1', _deps = {} } = {}) {
  if (!isFuturesLike(market)) throw new Error('leverage brackets are futures-only');
  const deps = resolveDeps(account, _deps);
  const params = symbol ? { symbol: String(symbol).toUpperCase() } : {};
  const data = await signedRequest({ market, endpoint: `${futPrefix(market)}/v1/leverageBracket`, params, _deps: deps });
  // USD-M returns [{ symbol, brackets:[...] }]; COIN-M keys by `pair`.
  const rows = (Array.isArray(data) ? data : [data]).map((r) => ({
    symbol: r.symbol || r.pair,
    brackets: (r.brackets || []).map((b) => ({
      bracket: b.bracket, initialLeverage: b.initialLeverage,
      notionalCap: b.notionalCap ?? b.qtyCap, notionalFloor: b.notionalFloor ?? b.qtyFloor,
      maintMarginRatio: b.maintMarginRatio,
    })),
  }));
  return { success: true, market, account, symbols: rows };
}

/**
 * Place a full bracket in one shot: optional entry + protective stop + take-profit(s).
 * Maps a chart trade plan (entry / STOP / TP1..TPn) onto real Binance orders.
 * DRY-RUN by default; with `confirm:true` it places each leg sequentially and
 * reports per-leg success (continuing past a failed leg so you see the full picture).
 *
 * `side` is the POSITION direction: "BUY" = long, "SELL" = short. The stop and
 * take-profits are placed on the opposite (closing) side as reduceOnly/closePosition.
 * Futures only.
 *
 * @param {object} a
 * @param {string} a.symbol            e.g. "BTCUSDC"
 * @param {string} a.side             "BUY" (long) | "SELL" (short)
 * @param {number} a.quantity          position size in base asset
 * @param {boolean} [a.includeEntry]   place the entry leg too (default true). Set false to
 *                                      attach a stop/TPs onto a position you already hold.
 * @param {string} [a.entryType]       "MARKET" | "LIMIT" (default MARKET)
 * @param {number} [a.entryPrice]      required when entryType is LIMIT
 * @param {number} [a.stopPrice]       protective STOP_MARKET trigger (closePosition)
 * @param {Array<{price:number,quantity?:number}>} [a.takeProfits] one or more TP legs
 * @param {boolean} [a.confirm]        must be true to actually place orders
 */
export async function placeBracket({
  market = 'futures', symbol, side, quantity,
  includeEntry = true, entryType = 'MARKET', entryPrice, postOnly = true, allowTaker = false,
  hedge, round = true, stopPrice, takeProfits = [], confirm = false, account = '1', _deps = {},
} = {}) {
  const deps = resolveDeps(account, _deps);
  const paperTrading = usePaperTrading(_deps); if (paperTrading) confirm = false; // global kill-switch
  if (!isFuturesLike(market)) throw new Error('placeBracket supports USD-M and COIN-M futures only');
  if (!symbol) throw new Error('symbol is required');
  const sym = String(symbol).toUpperCase();
  const sd = String(side || '').toUpperCase();
  if (!['BUY', 'SELL'].includes(sd)) throw new Error('side must be BUY (long) or SELL (short)');
  const exit = sd === 'BUY' ? 'SELL' : 'BUY'; // closing side for stop/TP
  const qty = requireFinite(quantity, 'quantity');
  if (qty <= 0) throw new Error('quantity must be > 0');

  const tps = (takeProfits || []).map((tp, i) => ({
    price: requireFinite(tp.price ?? tp, `takeProfits[${i}].price`),
    quantity: tp.quantity !== undefined ? requireFinite(tp.quantity, `takeProfits[${i}].quantity`) : undefined,
  }));
  if (tps.length > 1 && tps.some((tp) => tp.quantity === undefined)) {
    throw new Error('with multiple take-profits, each must have its own quantity (closePosition would close the whole position on the first fill)');
  }

  const legs = [];
  if (includeEntry) {
    const ety = String(entryType).toUpperCase();
    if (!['MARKET', 'LIMIT'].includes(ety)) throw new Error('entryType must be MARKET or LIMIT');
    const entry = { leg: 'entry', symbol: sym, side: sd, type: ety, quantity: String(qty) };
    if (ety === 'LIMIT') {
      entry.price = String(requireFinite(entryPrice, 'entryPrice'));
      entry.timeInForce = postOnly ? 'GTX' : 'GTC'; // GTX = post-only (maker-only)
    }
    // A MARKET entry is taker — gated by the allowTaker check below.
    legs.push(entry);
  }
  if (stopPrice !== undefined && stopPrice !== null) {
    legs.push({ leg: 'stop', symbol: sym, side: exit, type: 'STOP_MARKET', stopPrice: String(requireFinite(stopPrice, 'stopPrice')), closePosition: 'true' });
  }
  tps.forEach((tp, i) => {
    const o = { leg: `tp${i + 1}`, symbol: sym, side: exit, type: 'TAKE_PROFIT_MARKET', stopPrice: String(tp.price) };
    if (tp.quantity !== undefined) { o.quantity = String(tp.quantity); o.reduceOnly = 'true'; }
    else { o.closePosition = 'true'; }
    legs.push(o);
  });
  if (legs.length === 0) throw new Error('nothing to place: provide entry, stopPrice, and/or takeProfits');

  const takerLegs = legs.filter((l) => TAKER_TYPES.includes(l.type));
  if (takerLegs.length && !allowTaker) {
    throw new Error(`This bracket has taker-only legs (${takerLegs.map((l) => l.leg).join(', ')}) — stops and market take-profits (and a MARKET entry) cross the book and cannot be post-only. Pass allowTaker:true (CLI --allowTaker) to place them and accept taker fees on those legs.`);
  }

  // Hedge Mode: every leg carries positionSide (from the position direction) and drops reduceOnly.
  let hedgeMode = hedge;
  if (hedgeMode === undefined && confirm) {
    hedgeMode = (await getPositionMode({ market, _deps: deps })).hedgeMode;
  }
  if (hedgeMode) {
    const posSide = sd === 'BUY' ? 'LONG' : 'SHORT';
    for (const leg of legs) {
      leg.positionSide = posSide;
      delete leg.reduceOnly; // rejected in hedge mode (positionSide implies close intent)
    }
  }

  // Snap every leg's price/stopPrice/quantity to the symbol's tick/step.
  let rounding_note;
  if (round) {
    try {
      const info = await getSymbolInfo({ market, symbol: sym, _deps: deps });
      for (const leg of legs) {
        if (leg.price !== undefined) leg.price = String(snap(leg.price, info.tickSize, 'round'));
        if (leg.stopPrice !== undefined) leg.stopPrice = String(snap(leg.stopPrice, info.tickSize, 'round'));
        if (leg.quantity !== undefined) leg.quantity = String(snap(leg.quantity, info.stepSize, 'floor'));
      }
    } catch (err) {
      if (confirm) throw new Error(`Could not load symbol filters to round bracket legs (${err.message}). Pass round:false to place without rounding.`);
      rounding_note = `precision rounding skipped — filters unavailable (${err.message})`;
    }
  }

  const isLive = !resolveMarket(market, deps).includes('testnet');
  if (!confirm) {
    return {
      success: false, dry_run: true, market, account, live_funds: isLive, hedgeMode: !!hedgeMode,
      message: paperTrading
        ? `PAPER TRADING — would place this ${isLive ? 'LIVE (real funds)' : 'TESTNET'} bracket (${legs.length} legs: ${legs.map((l) => l.leg).join(', ')}); decision logged, nothing sent.`
        : `DRY RUN — ${legs.length} legs (${legs.map((l) => l.leg).join(', ')}). Pass confirm:true to place this ${isLive ? 'LIVE (real funds)' : 'TESTNET'} bracket.`,
      ...paperFields(paperTrading),
      ...(rounding_note ? { rounding_note } : {}),
      legs,
    };
  }

  const results = [];
  for (const { leg: name, ...params } of legs) {
    // Conditional legs (stop / TP-market) route to the Algo endpoint on USD-M (post-2025-12-09).
    const useAlgo = STOP_TYPES.includes(params.type) && isFutures(market);
    let endpoint = `${futPrefix(market)}/v1/order`;
    if (useAlgo) {
      endpoint = `${futPrefix(market)}/v1/algoOrder`;
      params.algoType = 'CONDITIONAL';
      if (params.stopPrice !== undefined) { params.triggerPrice = params.stopPrice; delete params.stopPrice; }
    }
    try {
      const data = await signedRequest({ market, method: 'POST', endpoint, params, _deps: deps });
      results.push({ leg: name, success: true, orderId: data.orderId ?? data.algoId, algo: useAlgo, params });
    } catch (err) {
      results.push({ leg: name, success: false, error: err.message, params });
    }
  }
  const placed = results.filter((r) => r.success).length;
  return { success: results.every((r) => r.success), market, account, live_funds: isLive, placed, total: results.length, legs: results };
}

/** Read the balance figure for `marginAsset` from a getBalance() result
 *  (futures rows expose `available`, spot rows expose `free`). */
function balanceFor(balResult, marginAsset) {
  const asset = String(marginAsset).toUpperCase();
  const row = (balResult.balances || []).find((b) => b.asset === asset);
  if (!row) return 0;
  return Number(row.available ?? row.free ?? row.balance) || 0;
}

/** Compute per-account balance-scaled, step-snapped sizing for mirroring `baseQty`.
 *  The base account (accounts[0]) always gets factor 1 / the original quantity; every other
 *  account gets quantity × (its balance / base balance), floored to the symbol's step size.
 *  Marks `belowMin` when the scaled quantity floors below the symbol's minQty. */
async function planMirrorSizing({ accounts, marginAsset, market, symbol, baseQty, _deps }) {
  const balances = {};
  for (const acct of accounts) {
    const bal = await getBalance({ market, account: acct, _deps });
    balances[acct] = balanceFor(bal, marginAsset);
  }
  const base = accounts[0];
  const baseBal = balances[base];
  if (!baseBal) throw new Error(`Base account "${base}" has no ${marginAsset} balance to size the mirror ratio from.`);

  // Trading filters are exchange-wide (account-independent) — fetch once to snap/min-check.
  let info = null;
  try { info = await getSymbolInfo({ market, symbol, _deps }); } catch { /* leave unsnapped; placeOrder will still try */ }

  return accounts.map((acct) => {
    const factor = acct === base ? 1 : balances[acct] / baseBal;
    let quantity = baseQty * factor;
    let belowMin = false;
    if (info) {
      quantity = snap(quantity, info.stepSize, 'floor');
      const minQty = Number(info.minQty) || 0;
      if (quantity <= 0 || (minQty && quantity < minQty)) belowMin = true;
    }
    return { account: acct, balance: balances[acct], factor: Number(factor.toFixed(6)), quantity, ...(belowMin ? { belowMin: true } : {}) };
  });
}

/** Submit up to 5 orders per request via the futures batchOrders endpoint.
 *  Returns a flat array of per-order results (each an order object or a {code,msg} error). */
async function batchPlaceOrders({ market, orders, deps }) {
  const results = [];
  for (let i = 0; i < orders.length; i += 5) {
    const chunk = orders.slice(i, i + 5);
    const data = await signedRequest({
      market, method: 'POST', endpoint: `${futPrefix(market)}/v1/batchOrders`,
      params: { batchOrders: JSON.stringify(chunk) }, _deps: deps,
    });
    for (const r of (Array.isArray(data) ? data : [data])) results.push(r);
  }
  return results;
}

/**
 * Scale into a position with a ladder of post-only LIMIT rungs evenly spaced across [lo, hi],
 * optionally seeded with a MARKET order and guarded by a closePosition stop. DRY-RUN by default —
 * returns the full plan and sends nothing unless confirm:true. On confirm: seed first, then the
 * stop, then the rungs via batchOrders (5/request). Inherits post-only/hedge/precision rules.
 * Provide exactly one of totalNotional (split evenly by $) or totalQuantity (split evenly by qty).
 */
export async function placeLadder({
  market = 'futures', symbol, side, lo, hi, count = 10,
  totalNotional, totalQuantity, positionSide,
  seedQuantity, stop, postOnly = true,
  round = true, account = '1', confirm = false, _deps = {},
} = {}) {
  if (!isFuturesLike(market)) throw new Error('placeLadder is futures-only');
  if (!symbol) throw new Error('symbol is required');
  const sd = String(side || '').toUpperCase();
  if (!['BUY', 'SELL'].includes(sd)) throw new Error('side must be "BUY" or "SELL"');
  const loN = requireFinite(lo, 'lo'), hiN = requireFinite(hi, 'hi');
  const n = Math.trunc(requireFinite(count, 'count'));
  if (n < 1) throw new Error('count must be >= 1');
  if ((totalNotional == null) === (totalQuantity == null)) throw new Error('pass exactly one of totalNotional or totalQuantity');
  const deps = resolveDeps(account, _deps);
  const paperTrading = usePaperTrading(_deps); if (paperTrading) confirm = false; // global kill-switch
  const sym = String(symbol).toUpperCase();
  const lowP = Math.min(loN, hiN), highP = Math.max(loN, hiN);

  // Hedge-mode positionSide resolution (mirrors placeOrder).
  let ps = positionSide ? String(positionSide).toUpperCase() : null;
  if (ps && !['LONG', 'SHORT', 'BOTH'].includes(ps)) throw new Error('positionSide must be LONG, SHORT, or BOTH');
  if (!ps && confirm) {
    const mode = await getPositionMode({ market, account, _deps: deps });
    if (mode.hedgeMode) throw new Error('Account is in Hedge Mode — pass positionSide:"LONG" or "SHORT".');
  }

  const info = round ? await getSymbolInfo({ market, symbol: sym, _deps: deps }) : null;
  const minQty = info ? Number(info.minQty) : 0;
  const step = n > 1 ? (highP - lowP) / (n - 1) : 0;
  const perNotional = totalNotional != null ? Number(totalNotional) / n : null;
  const perQty = totalQuantity != null ? Number(totalQuantity) / n : null;

  // Resolve a "min" seed to the smallest valid position for this symbol (LOT_SIZE minQty
  // AND MIN_NOTIONAL), so set-and-forget ladders can rest a closePosition stop without
  // over-seeding. We snap the notional-implied qty UP (never under-fill the min-notional).
  let seedQty = seedQuantity;
  if (typeof seedQuantity === 'string' && seedQuantity.trim().toLowerCase() === 'min') {
    const si = info || await getSymbolInfo({ market, symbol: sym, _deps: deps });
    const mq = Number(si.minQty) || 0;
    const mn = Number(si.minNotional) || 0;
    const stp = Number(si.stepSize) || mq || 0;
    let refPx = lowP; // conservative fallback: notional is qty×fillPrice, lower price ⇒ more qty needed
    try {
      const bt = await getBookTicker({ market, symbol: sym, _deps: deps });
      refPx = Number(bt.bidPrice) || Number(bt.askPrice) || lowP; // SELL seed fills near bid
    } catch { /* ticker unavailable — fall back to lowP */ }
    const byNotional = mn > 0 && refPx > 0 ? snap(mn / refPx, stp, 'ceil') : 0;
    seedQty = Math.max(mq, byNotional);
    if (!(seedQty > 0)) throw new Error('could not resolve a "min" seed — symbol filters unavailable; pass an explicit seedQuantity');
  }

  const rungs = [];
  let skipped = 0;
  for (let i = 0; i < n; i++) {
    let price = n > 1 ? lowP + step * i : lowP;
    let qty = perQty != null ? perQty : perNotional / price;
    if (info) { price = snap(price, info.tickSize, 'round'); qty = snap(qty, info.stepSize, 'floor'); }
    if (minQty && qty < minQty) { skipped++; continue; }
    rungs.push({ price, qty });
  }
  if (!rungs.length) throw new Error('no valid rungs — every rung floored below minQty; raise totalNotional or lower count');

  const totQty = rungs.reduce((s, r) => s + r.qty, 0);
  const totNotional = rungs.reduce((s, r) => s + r.qty * r.price, 0);
  const avgPrice = totNotional / totQty;
  // Best-effort 3x-rule guard: compare the ladder's total notional to account equity.
  let impliedAccountLeverage; const warnings = [];
  try {
    const eq = Number((await getAccountSummary({ market, account, _deps: deps })).totalMarginBalance);
    if (Number.isFinite(eq) && eq > 0) {
      impliedAccountLeverage = Number((totNotional / eq).toFixed(2));
      if (impliedAccountLeverage > 3.0001) warnings.push(`implied account leverage ${impliedAccountLeverage}x exceeds your 3x rule ($${totNotional.toFixed(0)} notional vs $${eq.toFixed(0)} equity)`);
    }
  } catch { /* equity unavailable — skip the guard */ }
  const plan = {
    market, symbol: sym, account, side: sd, positionSide: ps || undefined,
    rungs: rungs.length, range: { lo: lowP, hi: highP },
    perOrder: perNotional != null ? `~$${perNotional.toFixed(2)}` : `${perQty} ${sym}`,
    totalQuantity: Number(totQty.toFixed(8)), totalNotional: Number(totNotional.toFixed(2)),
    avgPrice: Number(avgPrice.toFixed(2)), impliedAccountLeverage, skippedBelowMin: skipped,
    timeInForce: postOnly ? 'GTX (post-only)' : 'GTC',
    seed: seedQty ? { type: 'MARKET', quantity: seedQty } : undefined,
    stop: stop != null ? { type: 'STOP_MARKET', closePosition: true, triggerPrice: stop } : undefined,
    ...(warnings.length ? { warnings } : {}),
  };

  if (!confirm) {
    return {
      success: false, dry_run: true,
      message: paperTrading
        ? `PAPER TRADING — would place ${rungs.length} ladder rungs${seedQty ? ` + seed (${seedQty})` : ''}${stop != null ? ' + stop' : ''}; decision logged, nothing sent.`
        : `DRY RUN — no orders sent. Pass confirm:true to place ${rungs.length} ladder rungs${seedQty ? ` + seed (${seedQty})` : ''}${stop != null ? ' + stop' : ''} (LIVE real funds).`,
      ...paperFields(paperTrading),
      ladder_preview: plan,
      sample_rungs: [...rungs.slice(0, 3), ...(rungs.length > 3 ? [rungs[rungs.length - 1]] : [])],
    };
  }

  // 1) optional seed market order — opens the position so a stop has something to guard.
  let seedResult;
  if (seedQty) {
    seedResult = await placeOrder({ market, symbol: sym, side: sd, type: 'MARKET', quantity: seedQty, positionSide: ps || undefined, allowTaker: true, round, account, confirm: true, _deps: deps });
  }
  // 2) optional protective closePosition stop.
  let stopResult;
  if (stop != null) {
    const closeSide = sd === 'BUY' ? 'SELL' : 'BUY';
    stopResult = await placeOrder({ market, symbol: sym, side: closeSide, type: 'STOP_MARKET', stopPrice: stop, closePosition: true, positionSide: ps || undefined, allowTaker: true, round, account, confirm: true, _deps: deps });
  }
  // 3) the rungs, batched 5/request.
  const orderObjs = rungs.map((r) => {
    const o = { symbol: sym, side: sd, type: 'LIMIT', quantity: String(r.qty), price: String(r.price), timeInForce: postOnly ? 'GTX' : 'GTC' };
    if (ps) o.positionSide = ps;
    return o;
  });
  const rungResults = await batchPlaceOrders({ market, orders: orderObjs, deps });
  const placed = rungResults.filter((r) => r && (r.orderId || r.clientOrderId)).length;
  const errors = rungResults.filter((r) => r && typeof r.code === 'number' && r.code < 0).map((r) => r.msg);
  return {
    success: true, market, symbol: sym, account, side: sd, positionSide: ps || undefined,
    placed, requested: rungs.length, failed: rungs.length - placed,
    totalQuantity: plan.totalQuantity, totalNotional: plan.totalNotional, avgPrice: plan.avgPrice,
    impliedAccountLeverage: plan.impliedAccountLeverage,
    seed: seedResult ? { orderId: seedResult.order?.orderId, status: seedResult.order?.status } : undefined,
    stop: stopResult ? { algoId: stopResult.order?.algoId, orderId: stopResult.order?.orderId } : undefined,
    errors: errors.length ? [...new Set(errors)].slice(0, 5) : undefined,
    ...(warnings.length ? { warnings } : {}),
  };
}

/**
 * Idempotently ensure a protective closePosition stop exists for an open futures position.
 * If a closePosition STOP order is already resting, does nothing. Otherwise (and if a position
 * exists) places a STOP_MARKET closePosition at `stop`. DRY-RUN unless confirm:true.
 */
export async function ensureProtectiveStop({ market = 'futures', symbol, stop, positionSide, account = '1', confirm = false, _deps = {} } = {}) {
  if (!isFuturesLike(market)) throw new Error('ensureProtectiveStop is futures-only');
  if (!symbol) throw new Error('symbol is required');
  const trigger = requireFinite(stop, 'stop');
  const deps = resolveDeps(account, _deps);
  const paperTrading = usePaperTrading(_deps); if (paperTrading) confirm = false; // global kill-switch
  const sym = String(symbol).toUpperCase();
  const oo = await getOpenOrders({ market, symbol: sym, account, _deps: deps });
  const isClosePosStop = (o) => /STOP/.test(o.orderType || o.type || '') && (o.closePosition === true || o.closePosition === 'true');
  const existing = [...(oo.algoOrders || []), ...(oo.orders || [])].filter(isClosePosStop);
  if (existing.length) {
    return { success: true, market, symbol: sym, account, action: 'none', exists: true, stops: existing.map((s) => ({ id: s.algoId || s.orderId, trigger: s.triggerPrice || s.stopPrice, positionSide: s.positionSide })) };
  }
  const posRes = await getPositions({ market, symbol: sym, account, _deps: deps });
  const pos = (posRes.positions || []).find((p) => p.symbol === sym);
  if (!pos) {
    return { success: false, market, symbol: sym, account, action: 'none', exists: false, warning: 'no open position to protect and no existing stop — nothing placed' };
  }
  const ps = positionSide ? String(positionSide).toUpperCase() : pos.side;
  const closeSide = pos.side === 'LONG' ? 'SELL' : 'BUY';
  if (!confirm) {
    return {
      success: false, dry_run: true, market, symbol: sym, account, action: 'would_place', exists: false,
      message: paperTrading
        ? `PAPER TRADING — the ${pos.side} ${sym} position has NO protective stop; would place a closePosition STOP_MARKET @ ${trigger}; decision logged, nothing sent.`
        : `DRY RUN — the ${pos.side} ${sym} position has NO protective stop. Pass confirm:true to place a closePosition STOP_MARKET @ ${trigger}.`,
      ...paperFields(paperTrading),
      stop_preview: { side: closeSide, type: 'STOP_MARKET', closePosition: true, triggerPrice: trigger, positionSide: ps },
    };
  }
  const placed = await placeOrder({ market, symbol: sym, side: closeSide, type: 'STOP_MARKET', stopPrice: trigger, closePosition: true, positionSide: ps, allowTaker: true, account, confirm: true, _deps: deps });
  return { success: true, market, symbol: sym, account, action: 'placed', exists: false, stop: { algoId: placed.order?.algoId, orderId: placed.order?.orderId, trigger } };
}

/**
 * Mirror a single order across multiple accounts, sized by balance ratio.
 * Fan-out on placement: the base account (accounts[0]) places `quantity`; every other account
 * places quantity × (its balance / base balance), snapped to the symbol's step size. DRY-RUN by
 * default — delegates to {@link placeOrder} per account, so post-only/hedge-mode/precision/algo
 * routing and the confirm gate are all inherited. On confirm the base order is placed FIRST; if it
 * fails (or its size floors below minQty), the mirrors are skipped so you never hold only a
 * mirrored position. Accounts whose scaled size is below minQty are skipped with an explicit note.
 *
 * @param {string[]} [a.accounts]   account ids; first = base/source of truth (default ["1","2"])
 * @param {string} [a.marginAsset]  asset whose balance drives the ratio (default "USDT")
 * @param {boolean} [a.confirm]     must be true to actually place orders
 *  …plus every {@link placeOrder} argument (symbol, side, type, quantity, price, …).
 */
export async function mirrorOrder({
  accounts = ['1', '2'], marginAsset = 'USDT', market = 'futures',
  symbol, quantity, confirm = false, _deps = {}, ...orderArgs
} = {}) {
  if (!Array.isArray(accounts) || accounts.length < 2) throw new Error('mirrorOrder needs at least two accounts, e.g. ["1","2"]');
  if (!symbol) throw new Error('symbol is required (e.g. "BTCUSDT")');
  const paperTrading = usePaperTrading(_deps); if (paperTrading) confirm = false; // global kill-switch (delegated placeOrder is also gated)
  const baseQty = requireFinite(quantity, 'quantity');
  if (baseQty <= 0) throw new Error('quantity must be > 0');

  const sizing = await planMirrorSizing({ accounts, marginAsset, market, symbol, baseQty, _deps });
  const base = accounts[0];

  const results = [];
  let baseFailed = false;
  for (const s of sizing) {
    const isBase = s.account === base;
    if (baseFailed) { results.push({ ...s, skipped: 'base order failed — mirror not placed' }); continue; }
    if (s.belowMin) {
      results.push({ ...s, skipped: `scaled quantity ${s.quantity} below minQty for ${symbol} — not placed on account ${s.account}` });
      if (isBase) baseFailed = true;
      continue;
    }
    let result;
    try { result = await placeOrder({ ...orderArgs, market, symbol, quantity: s.quantity, account: s.account, confirm, _deps }); }
    catch (err) { result = { success: false, error: err.message }; }
    results.push({ ...s, result });
    if (isBase && confirm && result.success === false) baseFailed = true;
  }

  const baseRes = results.find((r) => r.account === base);
  const basePlaced = !!(baseRes && baseRes.result && baseRes.result.success);
  const anyFailed = results.some((r) => r.result && r.result.success === false);
  return {
    success: confirm ? (basePlaced && !anyFailed) : false,
    dry_run: !confirm, base, marginAsset, market,
    ...paperFields(paperTrading),
    note: 'Leverage/margin-type are NOT mirrored — set them per account (setLeverage/setMarginType with account).',
    accounts: results,
  };
}

/**
 * Mirror a full bracket (entry + stop + take-profit(s)) across multiple accounts, sized by balance
 * ratio. Same fan-out/safety semantics as {@link mirrorOrder}, delegating to {@link placeBracket}
 * per account. Per-TP quantities are scaled by the same factor and snapped to the step size.
 */
export async function mirrorBracket({
  accounts = ['1', '2'], marginAsset = 'USDT', market = 'futures',
  symbol, quantity, takeProfits = [], confirm = false, _deps = {}, ...bracketArgs
} = {}) {
  if (!Array.isArray(accounts) || accounts.length < 2) throw new Error('mirrorBracket needs at least two accounts, e.g. ["1","2"]');
  if (!symbol) throw new Error('symbol is required');
  const paperTrading = usePaperTrading(_deps); if (paperTrading) confirm = false; // global kill-switch (delegated placeBracket is also gated)
  const baseQty = requireFinite(quantity, 'quantity');
  if (baseQty <= 0) throw new Error('quantity must be > 0');

  const sizing = await planMirrorSizing({ accounts, marginAsset, market, symbol, baseQty, _deps });
  const base = accounts[0];
  let info = null;
  try { info = await getSymbolInfo({ market, symbol, _deps }); } catch { /* placeBracket will still snap */ }

  const results = [];
  let baseFailed = false;
  for (const s of sizing) {
    const isBase = s.account === base;
    if (baseFailed) { results.push({ ...s, skipped: 'base bracket failed — mirror not placed' }); continue; }
    if (s.belowMin) {
      results.push({ ...s, skipped: `scaled quantity ${s.quantity} below minQty for ${symbol} — not placed on account ${s.account}` });
      if (isBase) baseFailed = true;
      continue;
    }
    const scaledTps = (takeProfits || []).map((tp) => {
      const price = (tp && tp.price !== undefined) ? tp.price : tp;
      if (tp && tp.quantity !== undefined) {
        let q = Number(tp.quantity) * s.factor;
        if (info) q = snap(q, info.stepSize, 'floor');
        return { price, quantity: q };
      }
      return { price };
    });
    let result;
    try { result = await placeBracket({ ...bracketArgs, market, symbol, quantity: s.quantity, takeProfits: scaledTps, account: s.account, confirm, _deps }); }
    catch (err) { result = { success: false, error: err.message }; }
    results.push({ ...s, result });
    if (isBase && confirm && result.success === false) baseFailed = true;
  }

  const baseRes = results.find((r) => r.account === base);
  const basePlaced = !!(baseRes && baseRes.result && baseRes.result.success);
  const anyFailed = results.some((r) => r.result && r.result.success === false);
  return {
    success: confirm ? (basePlaced && !anyFailed) : false,
    dry_run: !confirm, base, marginAsset, market,
    ...paperFields(paperTrading),
    note: 'Leverage/margin-type are NOT mirrored — set them per account (setLeverage/setMarginType with account).',
    accounts: results,
  };
}

/**
 * Cancel ALL open orders for a symbol. DRY-RUN by default — only fires with
 * `confirm: true`, since it's bulk-destructive.
 */
export async function cancelAllOrders({ market = 'futures', symbol, confirm = false, account = '1', _deps = {} } = {}) {
  if (!symbol) throw new Error('symbol is required');
  const sym = String(symbol).toUpperCase();
  const paperTrading = usePaperTrading(_deps); if (paperTrading) confirm = false; // global kill-switch
  if (!confirm) {
    return {
      success: false, dry_run: true, account,
      message: paperTrading
        ? `PAPER TRADING — would cancel ALL open orders for ${sym} on ${market}; decision logged, nothing sent.`
        : `DRY RUN — pass confirm:true to cancel ALL open orders for ${sym} on ${market}.`,
      ...paperFields(paperTrading),
    };
  }
  const deps = resolveDeps(account, _deps);
  if (isFuturesLike(market)) {
    const data = await signedRequest({ market, method: 'DELETE', endpoint: `${futPrefix(market)}/v1/allOpenOrders`, params: { symbol: sym }, _deps: deps });
    // Also clear conditional (algo) orders — they're a separate service since 2025-12-09.
    let algoCanceled = 0;
    if (isFutures(market)) {
      try {
        const a = await signedRequest({ market, endpoint: `${futPrefix(market)}/v1/openAlgoOrders`, params: { symbol: sym }, _deps: deps });
        const arr = Array.isArray(a) ? a : (a.orders || a.algoOrders || []);
        for (const o of arr) {
          if (o.algoId === undefined) continue;
          try { await signedRequest({ market, method: 'DELETE', endpoint: `${futPrefix(market)}/v1/algoOrder`, params: { algoId: String(o.algoId) }, _deps: deps }); algoCanceled++; } catch { /* skip */ }
        }
      } catch { /* no algo orders */ }
    }
    return { success: true, market, account, symbol: sym, response: data, algoCanceled };
  }
  const data = await signedRequest({ market, method: 'DELETE', endpoint: '/api/v3/openOrders', params: { symbol: sym }, _deps: deps });
  return { success: true, market, account, symbol: sym, canceled: data };
}

// Wallet → Binance Universal-Transfer code. One side must be MAIN (spot) for these pairs.
const WALLET_CODES = { spot: 'MAIN', main: 'MAIN', futures: 'UMFUTURE', usdm: 'UMFUTURE', coinm: 'CMFUTURE' };
function transferType(from, to) {
  const f = WALLET_CODES[from];
  const t = WALLET_CODES[to];
  if (!f || !t) throw new Error('from/to must be one of: spot, futures (usdm), coinm');
  if (f === t) throw new Error('from and to wallets must differ');
  if (f !== 'MAIN' && t !== 'MAIN') throw new Error('one side must be spot (transfers route through the spot wallet)');
  return `${f}_${t}`;
}

/**
 * Move an asset between wallets via Binance Universal Transfer (/sapi/v1/asset/transfer).
 * DRY-RUN by default — only executes with `confirm: true`. Always runs on the spot/sapi
 * host (mainnet); requires the API key to have "Permits Universal Transfer" enabled.
 *
 * @param {object} a
 * @param {string} a.asset   e.g. "USDC"
 * @param {number} a.amount  amount to move
 * @param {string} [a.from]  source wallet: spot | futures(usdm) | coinm (default futures)
 * @param {string} [a.to]    destination wallet (default spot)
 * @param {string} [a.type]  explicit Binance transfer type (overrides from/to)
 * @param {boolean} [a.confirm] must be true to actually transfer
 */
export async function transfer({ asset, amount, from = 'futures', to = 'spot', type, confirm = false, account = '1', _deps = {} } = {}) {
  if (!asset) throw new Error('asset is required (e.g. "USDC")');
  const amt = requireFinite(amount, 'amount');
  if (amt <= 0) throw new Error('amount must be > 0');
  const deps = resolveDeps(account, _deps);
  const paperTrading = usePaperTrading(_deps); if (paperTrading) confirm = false; // global kill-switch
  const ttype = type || transferType(String(from).toLowerCase(), String(to).toLowerCase());
  const params = { type: ttype, asset: String(asset).toUpperCase(), amount: String(amt) };

  if (!confirm) {
    return {
      success: false,
      dry_run: true,
      message: paperTrading
        ? `PAPER TRADING — would move ${amt} ${params.asset} (${ttype}); decision logged, nothing sent.`
        : `DRY RUN — no transfer sent. Pass confirm:true to move ${amt} ${params.asset} (${ttype}, REAL funds).`,
      ...paperFields(paperTrading),
      transfer_preview: { ...params, from, to, account },
    };
  }
  const data = await signedRequest({ market: 'spot', method: 'POST', endpoint: '/sapi/v1/asset/transfer', params, _deps: deps });
  return { success: true, tranId: data.tranId, ...params, from, to, account };
}

/** Recent universal transfers for a wallet pair (signed). */
export async function getTransferHistory({ from = 'futures', to = 'spot', type, size = 10, account = '1', _deps = {} } = {}) {
  const deps = resolveDeps(account, _deps);
  const ttype = type || transferType(String(from).toLowerCase(), String(to).toLowerCase());
  const params = { type: ttype, size: String(Math.max(1, Math.min(Number(size) || 10, 100))) };
  const data = await signedRequest({ market: 'spot', endpoint: '/sapi/v1/asset/transfer', params, _deps: deps });
  return { success: true, type: ttype, total: data.total || 0, rows: data.rows || [] };
}

// Wallet history / address endpoints live on the SAPI (spot host), like transfer — they are
// account-level, not per-market, and exist only on mainnet. All are READ-ONLY (GET), so no
// confirm gate is needed.

/** On-chain deposit history (signed, SAPI/spot host). Filter by coin, status (Binance numeric
 *  codes: 0 pending, 6 credited-but-cannot-withdraw, 1 success, …) and time window. Read-only. */
export async function getDepositHistory({ coin, status, startTime, endTime, offset, limit = 100, account = '1', _deps = {} } = {}) {
  const deps = resolveDeps(account, _deps);
  const params = {};
  if (coin) params.coin = String(coin).toUpperCase();
  if (status !== undefined) params.status = String(status);
  if (startTime !== undefined) params.startTime = String(requireFinite(startTime, 'startTime'));
  if (endTime !== undefined) params.endTime = String(requireFinite(endTime, 'endTime'));
  if (offset !== undefined) params.offset = String(offset);
  params.limit = String(Math.max(1, Math.min(Number(limit) || 100, 1000)));
  const data = await signedRequest({ market: 'spot', endpoint: '/sapi/v1/capital/deposit/hisrec', params, _deps: deps });
  const deposits = Array.isArray(data) ? data : [];
  return { success: true, account, count: deposits.length, deposits };
}

/** Withdrawal history (signed, SAPI/spot host). Filter by coin, status (Binance numeric codes:
 *  0 email-sent, 1 cancelled, 2 awaiting-approval, 4 processing, 5 failure, 6 completed) and
 *  time window. Read-only. */
export async function getWithdrawHistory({ coin, status, startTime, endTime, offset, limit = 100, account = '1', _deps = {} } = {}) {
  const deps = resolveDeps(account, _deps);
  const params = {};
  if (coin) params.coin = String(coin).toUpperCase();
  if (status !== undefined) params.status = String(status);
  if (startTime !== undefined) params.startTime = String(requireFinite(startTime, 'startTime'));
  if (endTime !== undefined) params.endTime = String(requireFinite(endTime, 'endTime'));
  if (offset !== undefined) params.offset = String(offset);
  params.limit = String(Math.max(1, Math.min(Number(limit) || 100, 1000)));
  const data = await signedRequest({ market: 'spot', endpoint: '/sapi/v1/capital/withdraw/history', params, _deps: deps });
  const withdrawals = Array.isArray(data) ? data : [];
  return { success: true, account, count: withdrawals.length, withdrawals };
}

/** Deposit address for a coin (signed, SAPI/spot host). `network` is optional (e.g. "BSC",
 *  "ETH", "TRX", "BNB"); omit to get the coin's default network. Read-only — returns the
 *  on-chain address, optional memo/tag, and a block-explorer url. */
export async function getDepositAddress({ coin, network, account = '1', _deps = {} } = {}) {
  if (!coin) throw new Error('coin is required (e.g. "USDC")');
  const deps = resolveDeps(account, _deps);
  const params = { coin: String(coin).toUpperCase() };
  if (network) params.network = String(network).toUpperCase();
  const data = await signedRequest({ market: 'spot', endpoint: '/sapi/v1/capital/deposit/address', params, _deps: deps });
  return { success: true, account, coin: data.coin, address: data.address, tag: data.tag, url: data.url, network: data.network || params.network };
}

// ── Technical analysis (computed off klines) ─────────────────────────────────
// Pure indicator math over OHLCV arrays — no network, no chart, no CDP. These power
// getTechnicals (one symbol) and correlateSymbols (a candidate set), and the ATR figure
// feeds calcPositionSize's ATR-based stop. Every helper returns null when there aren't
// enough bars, so callers degrade gracefully instead of throwing. The TradingView side
// has its own indicators; this is the headless path for the exact Binance contract.
// (Distinct from compareSymbols above, which is a quick 24hr-stats leaderboard.)

/** Round a price-like value to a precision that suits its magnitude (big numbers → fewer dp). */
function px(v) {
  if (v == null || !Number.isFinite(Number(v))) return null;
  const n = Number(v);
  const a = Math.abs(n);
  const dp = a >= 1000 ? 2 : a >= 1 ? 4 : a >= 0.01 ? 6 : 8;
  return Number(n.toFixed(dp));
}

/** Simple moving average of the last `period` values (null if too few). */
function sma(values, period) {
  if (!Array.isArray(values) || period < 1 || values.length < period) return null;
  let s = 0;
  for (let i = values.length - period; i < values.length; i++) s += values[i];
  return s / period;
}

/** EMA series aligned to `values` (entries are null until the SMA seed at index period-1). */
function emaSeries(values, period) {
  const out = new Array(values.length).fill(null);
  if (period < 1 || values.length < period) return out;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  let prev = seed / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Last EMA value (null if too few bars). */
function ema(values, period) {
  const s = emaSeries(values, period);
  return s[s.length - 1];
}

/** Wilder RSI over `period` (null if too few bars). */
function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let avgGain = gain / period, avgLoss = loss / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

/** Wilder ATR over `period` from highs/lows/closes (null if too few bars). */
function atr(highs, lows, closes, period = 14) {
  const n = closes.length;
  if (n < period + 1) return null;
  const tr = [];
  for (let i = 1; i < n; i++) {
    const h = highs[i], l = lows[i], pc = closes[i - 1];
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  let a = 0; // seed with SMA of the first `period` true ranges, then Wilder-smooth.
  for (let i = 0; i < period; i++) a += tr[i];
  a /= period;
  for (let i = period; i < tr.length; i++) a = (a * (period - 1) + tr[i]) / period;
  return a;
}

/** MACD line/signal/histogram (null if too few bars for the slow EMA + signal). */
function macd(closes, fast = 12, slow = 26, signalP = 9) {
  if (closes.length < slow + signalP) return null;
  const fastS = emaSeries(closes, fast);
  const slowS = emaSeries(closes, slow);
  const line = closes.map((_, i) => (fastS[i] != null && slowS[i] != null ? fastS[i] - slowS[i] : null));
  const defined = line.filter((v) => v != null);
  const signal = ema(defined, signalP);
  const macdLine = line[line.length - 1];
  if (macdLine == null || signal == null) return null;
  return { macd: macdLine, signal, hist: macdLine - signal };
}

/** Population standard deviation (null if fewer than 2 values). */
function stddev(values) {
  const n = values.length;
  if (n < 2) return null;
  const mean = values.reduce((s, v) => s + v, 0) / n;
  return Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / n);
}

/** Bollinger Bands (SMA middle ± mult·stddev) over `period` (null if too few bars). */
function bollinger(closes, period = 20, mult = 2) {
  if (closes.length < period) return null;
  const window = closes.slice(-period);
  const middle = window.reduce((s, v) => s + v, 0) / period;
  const sd = stddev(window);
  if (sd == null) return null;
  return { upper: middle + mult * sd, middle, lower: middle - mult * sd, width: middle ? (2 * mult * sd) / middle : 0 };
}

/** Cumulative VWAP over the whole window (typical price × volume). */
function vwap(highs, lows, closes, volumes) {
  let pv = 0, vol = 0;
  for (let i = 0; i < closes.length; i++) {
    const v = volumes[i] || 0;
    pv += ((highs[i] + lows[i] + closes[i]) / 3) * v;
    vol += v;
  }
  return vol > 0 ? pv / vol : null;
}

/** Close-to-close simple returns. */
function simpleReturns(closes) {
  const out = [];
  for (let i = 1; i < closes.length; i++) out.push(closes[i] / closes[i - 1] - 1);
  return out;
}

/** Pearson correlation of two arrays (uses the common tail; null if degenerate). */
function pearson(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 2) return null;
  const xa = a.slice(-n), xb = b.slice(-n);
  const ma = xa.reduce((s, v) => s + v, 0) / n;
  const mb = xb.reduce((s, v) => s + v, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = xa[i] - ma, y = xb[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  const den = Math.sqrt(da * db);
  return den === 0 ? null : num / den;
}

/** Pull named numeric OHLCV arrays out of getKlines() candle objects (strings → numbers). */
function ohlcvArrays(candles) {
  const highs = [], lows = [], closes = [], volumes = [];
  for (const k of (candles || [])) {
    highs.push(Number(k.high)); lows.push(Number(k.low));
    closes.push(Number(k.close)); volumes.push(Number(k.volume));
  }
  return { highs, lows, closes, volumes };
}

/** Coarse trend tag from close vs a reference MA and the MACD histogram sign. */
function classifyTrend(lastClose, trendRef, m) {
  if (trendRef == null) return 'neutral';
  if (m) {
    if (lastClose > trendRef && m.hist > 0) return 'bullish';
    if (lastClose < trendRef && m.hist < 0) return 'bearish';
    return 'neutral';
  }
  return lastClose > trendRef ? 'bullish' : lastClose < trendRef ? 'bearish' : 'neutral';
}

/**
 * Compute technical indicators directly off Binance klines — RSI(14), ATR(14), MACD(12/26/9),
 * SMA(20/50/200), EMA(12/26/50), Bollinger(20,2) and window VWAP — plus a coarse trend/momentum
 * classification. Headless: pulls OHLCV for the exact contract and runs the math locally (the
 * TradingView side has its own indicators). The ATR figure also backs calcPositionSize's ATR
 * stop. Any indicator without enough bars comes back null rather than failing the whole call.
 */
export async function getTechnicals({ market = 'futures', symbol, interval = '1h', limit = 300, _deps = {} } = {}) {
  if (!symbol) throw new Error('symbol is required');
  const lim = Math.max(30, Math.min(Number(limit) || 300, isFuturesLike(market) ? 1500 : 1000));
  const kl = await getKlines({ market, symbol, interval, limit: lim, _deps });
  const { highs, lows, closes, volumes } = ohlcvArrays(kl.candles);
  const n = closes.length;
  if (n < 2) throw new Error(`not enough candles to analyze (${n})`);
  const lastClose = closes[n - 1];

  const atrVal = atr(highs, lows, closes, 14);
  const rsiVal = rsi(closes, 14);
  const macdVal = macd(closes);
  const bb = bollinger(closes, 20, 2);
  const vwapVal = vwap(highs, lows, closes, volumes);
  const smaVals = {}; for (const p of [20, 50, 200]) { const v = sma(closes, p); if (v != null) smaVals[p] = px(v); }
  const emaVals = {}; for (const p of [12, 26, 50]) { const v = ema(closes, p); if (v != null) emaVals[p] = px(v); }

  const trend = classifyTrend(lastClose, sma(closes, 50) ?? sma(closes, 20), macdVal);
  const momentum = rsiVal == null ? 'neutral' : rsiVal >= 70 ? 'overbought' : rsiVal <= 30 ? 'oversold' : 'neutral';

  return {
    success: true, market, symbol: String(symbol).toUpperCase(), interval, bars: n,
    lastClose: px(lastClose),
    rsi: rsiVal != null ? Number(rsiVal.toFixed(2)) : null,
    atr: atrVal != null ? px(atrVal) : null,
    atrPct: atrVal != null && lastClose ? Number((atrVal / lastClose * 100).toFixed(2)) : null,
    macd: macdVal ? { macd: px(macdVal.macd), signal: px(macdVal.signal), hist: px(macdVal.hist) } : null,
    sma: Object.keys(smaVals).length ? smaVals : null,
    ema: Object.keys(emaVals).length ? emaVals : null,
    bollinger: bb ? { upper: px(bb.upper), middle: px(bb.middle), lower: px(bb.lower), widthPct: Number((bb.width * 100).toFixed(2)) } : null,
    vwap: vwapVal != null ? px(vwapVal) : null,
    classification: { trend, momentum },
  };
}

/**
 * Correlate and rank a candidate set of symbols on COMPUTED technicals: window return %, per-bar
 * volatility, a Sharpe-like ratio (mean/stddev of returns), ATR %, RSI and a trend tag — plus a
 * correlation matrix of their close-to-close returns and return/volatility rankings. Built for
 * portfolio-risk checks (don't stack correlated positions across accounts) and for ranking a
 * shortlist pulled from the 24hr screener. Fetches klines per symbol (one REST call each) — pass
 * a focused list, not the whole market. Capped at 10 symbols; per-symbol fetch errors are inline.
 * (Heavier, klines-based complement to compareSymbols, which only reads one 24hr ticker each.)
 */
export async function correlateSymbols({ market = 'futures', symbols, interval = '1h', limit = 200, _deps = {} } = {}) {
  const list = (Array.isArray(symbols) ? symbols : (typeof symbols === 'string' && symbols ? symbols.split(',') : []))
    .map((s) => String(s).trim().toUpperCase()).filter(Boolean);
  if (list.length < 2) throw new Error('pass at least two symbols to correlate (array or CSV)');
  const capped = [...new Set(list)].slice(0, 10);
  const lim = Math.max(30, Math.min(Number(limit) || 200, isFuturesLike(market) ? 1500 : 1000));

  const per = await Promise.all(capped.map(async (sym) => {
    try {
      const kl = await getKlines({ market, symbol: sym, interval, limit: lim, _deps });
      const { highs, lows, closes } = ohlcvArrays(kl.candles);
      const n = closes.length;
      if (n < 2) return { symbol: sym, error: 'not enough candles' };
      const rets = simpleReturns(closes);
      const sd = stddev(rets);
      const mean = rets.reduce((s, v) => s + v, 0) / rets.length;
      const atrVal = atr(highs, lows, closes, 14);
      const rsiVal = rsi(closes, 14);
      const lastClose = closes[n - 1];
      const trend = classifyTrend(lastClose, sma(closes, 50) ?? sma(closes, 20), macd(closes));
      return {
        symbol: sym, bars: n, lastClose: px(lastClose),
        returnPct: Number(((lastClose / closes[0] - 1) * 100).toFixed(2)),
        volatilityPct: sd != null ? Number((sd * 100).toFixed(3)) : null,
        sharpe: sd ? Number((mean / sd).toFixed(3)) : null,
        atrPct: atrVal != null && lastClose ? Number((atrVal / lastClose * 100).toFixed(2)) : null,
        rsi: rsiVal != null ? Number(rsiVal.toFixed(2)) : null,
        trend,
        _returns: rets,
      };
    } catch (err) { return { symbol: sym, error: err.message }; }
  }));

  // Correlation matrix over the common tail length of the symbols that fetched cleanly.
  const ok = per.filter((p) => !p.error && p._returns);
  let correlation = null;
  if (ok.length >= 2) {
    const minLen = Math.min(...ok.map((p) => p._returns.length));
    const aligned = ok.map((p) => p._returns.slice(-minLen));
    const matrix = aligned.map((a, i) => aligned.map((b, j) => {
      if (i === j) return 1;
      const c = pearson(a, b);
      return c == null ? null : Number(c.toFixed(3));
    }));
    correlation = { symbols: ok.map((p) => p.symbol), bars: minLen, matrix };
  }

  const clean = per.map(({ _returns, ...rest }) => rest);
  const ranked = clean.filter((p) => !p.error);
  return {
    success: true, market, interval, count: clean.length,
    ...(list.length > capped.length ? { note: `capped to first 10 of ${list.length} symbols` } : {}),
    symbols: clean,
    rankings: {
      byReturn: [...ranked].sort((a, b) => (b.returnPct ?? -Infinity) - (a.returnPct ?? -Infinity)).map((p) => p.symbol),
      byVolatility: [...ranked].sort((a, b) => (b.volatilityPct ?? -Infinity) - (a.volatilityPct ?? -Infinity)).map((p) => p.symbol),
    },
    correlation,
  };
}

// ── Indicator SERIES helpers (aligned arrays, for backtesting) ───────────────
// The helpers above return a single latest value; the backtester needs the WHOLE
// per-bar series (causal — entry index i only ever uses closes[0..i]). These mirror
// the point helpers' math but emit an array aligned to the input, null until warmed up.

/** SMA series (rolling); out[i] null until i >= period-1. */
function smaSeries(values, period) {
  const out = new Array(values.length).fill(null);
  if (period < 1) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** Wilder RSI series; out[i] null until i >= period. */
function rsiSeries(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let avgGain = gain / period, avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

/** Wilder ATR series; out[i] null until i >= period (seeded with the mean of the first `period` TRs). */
function atrSeries(highs, lows, closes, period = 14) {
  const n = closes.length;
  const out = new Array(n).fill(null);
  if (n < period + 1) return out;
  const tr = new Array(n).fill(null);
  for (let i = 1; i < n; i++) {
    tr[i] = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
  }
  let a = 0;
  for (let i = 1; i <= period; i++) a += tr[i];
  a /= period;
  out[period] = a;
  for (let i = period + 1; i < n; i++) { a = (a * (period - 1) + tr[i]) / period; out[i] = a; }
  return out;
}

/** MACD series: {line, signal, hist} aligned to closes (entries null until warmed up). */
function macdSeries(closes, fast = 12, slow = 26, signalP = 9) {
  const fastS = emaSeries(closes, fast);
  const slowS = emaSeries(closes, slow);
  const line = closes.map((_, i) => (fastS[i] != null && slowS[i] != null ? fastS[i] - slowS[i] : null));
  const signal = new Array(closes.length).fill(null);
  const first = line.findIndex((v) => v != null);
  if (first >= 0) {
    const sig = emaSeries(line.slice(first).map((v) => v ?? 0), signalP);
    for (let i = 0; i < sig.length; i++) signal[first + i] = sig[i];
  }
  const hist = line.map((v, i) => (v != null && signal[i] != null ? v - signal[i] : null));
  return { line, signal, hist };
}

/** Bollinger series: {upper, middle, lower} aligned to closes. */
function bollingerSeries(closes, period = 20, mult = 2) {
  const middle = smaSeries(closes, period);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    if (middle[i] == null) continue;
    const sd = stddev(closes.slice(i - period + 1, i + 1));
    if (sd == null) continue;
    upper[i] = middle[i] + mult * sd;
    lower[i] = middle[i] - mult * sd;
  }
  return { upper, middle, lower };
}

/** Supertrend direction series: dir[i] = +1 (price above the trend line) / -1 (below) / null until warmed up. */
function supertrendSeries(highs, lows, closes, period = 10, mult = 3) {
  const n = closes.length;
  const atrS = atrSeries(highs, lows, closes, period);
  const fUpper = new Array(n).fill(null), fLower = new Array(n).fill(null);
  const st = new Array(n).fill(null), dir = new Array(n).fill(null);
  const start = atrS.findIndex((v) => v != null);
  if (start < 0) return { dir };
  for (let i = start; i < n; i++) {
    const hl2 = (highs[i] + lows[i]) / 2;
    const bu = hl2 + mult * atrS[i], bl = hl2 - mult * atrS[i];
    if (i === start || fUpper[i - 1] == null) {
      fUpper[i] = bu; fLower[i] = bl;
      st[i] = closes[i] <= bu ? bu : bl;
      dir[i] = closes[i] <= bu ? -1 : 1;
      continue;
    }
    fUpper[i] = (bu < fUpper[i - 1] || closes[i - 1] > fUpper[i - 1]) ? bu : fUpper[i - 1];
    fLower[i] = (bl > fLower[i - 1] || closes[i - 1] < fLower[i - 1]) ? bl : fLower[i - 1];
    st[i] = (st[i - 1] === fUpper[i - 1])
      ? (closes[i] <= fUpper[i] ? fUpper[i] : fLower[i])
      : (closes[i] >= fLower[i] ? fLower[i] : fUpper[i]);
    dir[i] = closes[i] > st[i] ? 1 : -1;
  }
  return { dir };
}

/** Pull opens/highs/lows/closes/volumes/openTimes (numbers) out of getKlines candle objects. */
function ohlcvFull(candles) {
  const opens = [], highs = [], lows = [], closes = [], volumes = [], openTimes = [];
  for (const k of (candles || [])) {
    opens.push(Number(k.open)); highs.push(Number(k.high)); lows.push(Number(k.low));
    closes.push(Number(k.close)); volumes.push(Number(k.volume)); openTimes.push(k.openTime);
  }
  return { opens, highs, lows, closes, volumes, openTimes };
}

// ── Backtesting engine (computed off klines, public — no chart, no orders) ───
// Headless strategy backtesting over the EXACT Binance contract's klines. Pure math:
// each strategy turns OHLCV into a per-bar desired position (+1 long / -1 short / 0 flat)
// decided at a bar's close and ENTERED AT THE NEXT BAR'S OPEN (no lookahead). The simulator
// marks the book close-to-close, charges commission+slippage on turnover, and reports
// institutional metrics (Sharpe, Calmar, max drawdown, profit factor, expectancy, vs buy&hold).
// Strategy set + metric ideas borrowed from atilaahmettaner/tradingview-mcp.

const INTERVAL_MS = {
  '1s': 1e3, '1m': 6e4, '3m': 18e4, '5m': 3e5, '15m': 9e5, '30m': 18e5,
  '1h': 36e5, '2h': 72e5, '4h': 144e5, '6h': 216e5, '8h': 288e5, '12h': 432e5,
  '1d': 864e5, '3d': 2592e5, '1w': 6048e5, '1M': 2592e6,
};

// Each strategy: (bundle) => desired[]  where desired[i] ∈ {1,-1,0} is the position to hold
// going INTO bar i+1, decided from indicators known at the close of bar i. `longOnly` strategies
// never emit shorts. Indicator series are precomputed once and shared (cheap compareStrategies).
const STRATEGIES = {
  rsi: {
    name: 'RSI mean-reversion', desc: 'long < 30, short > 70, exit back through 50',
    fn: ({ closes, ind }) => {
      const r = ind.rsi14; const out = new Array(closes.length).fill(0); let cur = 0;
      for (let i = 0; i < closes.length; i++) {
        if (r[i] == null) { out[i] = cur; continue; }
        if (r[i] < 30) cur = 1; else if (r[i] > 70) cur = -1;
        else if (cur === 1 && r[i] >= 50) cur = 0; else if (cur === -1 && r[i] <= 50) cur = 0;
        out[i] = cur;
      }
      return out;
    },
  },
  bollinger: {
    name: 'Bollinger mean-reversion', desc: 'long below lower band, short above upper, exit at middle',
    fn: ({ closes, ind }) => {
      const { upper, middle, lower } = ind.boll; const out = new Array(closes.length).fill(0); let cur = 0;
      for (let i = 0; i < closes.length; i++) {
        if (middle[i] == null) { out[i] = cur; continue; }
        if (closes[i] < lower[i]) cur = 1; else if (closes[i] > upper[i]) cur = -1;
        else if (cur === 1 && closes[i] >= middle[i]) cur = 0; else if (cur === -1 && closes[i] <= middle[i]) cur = 0;
        out[i] = cur;
      }
      return out;
    },
  },
  macd: {
    name: 'MACD cross', desc: 'long while MACD line > signal, short while below',
    fn: ({ closes, ind }) => {
      const { line, signal } = ind.macd; const out = new Array(closes.length).fill(0); let cur = 0;
      for (let i = 0; i < closes.length; i++) {
        if (line[i] == null || signal[i] == null) { out[i] = cur; continue; }
        cur = line[i] > signal[i] ? 1 : line[i] < signal[i] ? -1 : cur;
        out[i] = cur;
      }
      return out;
    },
  },
  ema_cross: {
    name: 'EMA cross 20/50', desc: 'long while EMA20 > EMA50 (golden), short while below (death)',
    fn: ({ closes, ind }) => {
      const a = ind.ema20, b = ind.ema50; const out = new Array(closes.length).fill(0); let cur = 0;
      for (let i = 0; i < closes.length; i++) {
        if (a[i] == null || b[i] == null) { out[i] = cur; continue; }
        cur = a[i] > b[i] ? 1 : a[i] < b[i] ? -1 : cur;
        out[i] = cur;
      }
      return out;
    },
  },
  supertrend: {
    name: 'Supertrend (ATR)', desc: 'follow the ATR(10,3) trend direction',
    fn: ({ closes, ind }) => ind.superT.dir.map((d) => (d == null ? 0 : d)),
  },
  donchian: {
    name: 'Donchian breakout', desc: 'Turtle-style: long on 20-bar high break, short on 20-bar low break',
    fn: ({ highs, lows, closes }) => {
      const p = 20; const out = new Array(closes.length).fill(0); let cur = 0;
      for (let i = 0; i < closes.length; i++) {
        if (i < p) { out[i] = cur; continue; }
        let hh = -Infinity, ll = Infinity;
        for (let j = i - p; j < i; j++) { if (highs[j] > hh) hh = highs[j]; if (lows[j] < ll) ll = lows[j]; }
        if (closes[i] > hh) cur = 1; else if (closes[i] < ll) cur = -1;
        out[i] = cur;
      }
      return out;
    },
  },
  rsi_pullback: {
    name: 'RSI pullback (long-only)', desc: 'buy dips (RSI<40) while price > SMA200; exit on RSI>60 or trend loss',
    longOnly: true,
    fn: ({ closes, ind }) => {
      const r = ind.rsi14, s = ind.sma200; const out = new Array(closes.length).fill(0); let cur = 0;
      for (let i = 0; i < closes.length; i++) {
        if (r[i] == null || s[i] == null) { out[i] = cur; continue; }
        const up = closes[i] > s[i];
        if (cur === 0 && up && r[i] < 40) cur = 1; else if (cur === 1 && (r[i] > 60 || !up)) cur = 0;
        out[i] = cur;
      }
      return out;
    },
  },
  keltner: {
    name: 'Keltner breakout', desc: 'EMA20 ± 1.5·ATR(14) channel breakout',
    fn: ({ closes, ind }) => {
      const e = ind.ema20, a = ind.atr14, m = 1.5; const out = new Array(closes.length).fill(0); let cur = 0;
      for (let i = 0; i < closes.length; i++) {
        if (e[i] == null || a[i] == null) { out[i] = cur; continue; }
        if (closes[i] > e[i] + m * a[i]) cur = 1; else if (closes[i] < e[i] - m * a[i]) cur = -1;
        out[i] = cur;
      }
      return out;
    },
  },
  triple_ema: {
    name: 'Triple EMA + SMA200 filter', desc: 'EMA20/50 cross gated by the SMA200 trend filter',
    fn: ({ closes, ind }) => {
      const a = ind.ema20, b = ind.ema50, s = ind.sma200; const out = new Array(closes.length).fill(0); let cur = 0;
      for (let i = 0; i < closes.length; i++) {
        if (a[i] == null || b[i] == null || s[i] == null) { out[i] = cur; continue; }
        if (a[i] > b[i] && closes[i] > s[i]) cur = 1; else if (a[i] < b[i] && closes[i] < s[i]) cur = -1; else cur = 0;
        out[i] = cur;
      }
      return out;
    },
  },
};

/** Public list of backtestable strategy keys (drives the MCP enum + CLI help). */
export const STRATEGY_KEYS = Object.keys(STRATEGIES);

/** Precompute every indicator series the strategies might read — once per symbol. */
function indicatorBundle(highs, lows, closes) {
  return {
    rsi14: rsiSeries(closes, 14),
    ema20: emaSeries(closes, 20),
    ema50: emaSeries(closes, 50),
    sma200: smaSeries(closes, 200),
    macd: macdSeries(closes),
    boll: bollingerSeries(closes, 20, 2),
    atr14: atrSeries(highs, lows, closes, 14),
    superT: supertrendSeries(highs, lows, closes, 10, 3),
  };
}

/** Win/loss/risk metrics from a realized per-bar return series + the trade list (pure). */
function computeMetrics({ barRets, equity, maxDD, trades, closes, interval }) {
  const totalReturnPct = (equity - 1) * 100;
  const wins = trades.filter((t) => t.returnPct > 0);
  const losses = trades.filter((t) => t.returnPct < 0);
  const grossWin = wins.reduce((s, t) => s + t.returnPct, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.returnPct, 0));
  const mean = barRets.length ? barRets.reduce((s, v) => s + v, 0) / barRets.length : 0;
  const sd = stddev(barRets);
  const bpy = INTERVAL_MS[interval] ? (365.25 * 864e5) / INTERVAL_MS[interval] : null;
  const sharpe = sd && bpy ? (mean / sd) * Math.sqrt(bpy) : null;
  const years = bpy ? barRets.length / bpy : null;
  const annReturn = years && years > 0 && equity > 0 ? Math.pow(equity, 1 / years) - 1 : null;
  const calmar = annReturn != null && maxDD < 0 ? annReturn / Math.abs(maxDD) : null;
  const buyHold = closes.length > 1 ? (closes[closes.length - 1] / closes[0] - 1) * 100 : 0;
  const best = trades.reduce((m, t) => (t.returnPct > (m?.returnPct ?? -Infinity) ? t : m), null);
  const worst = trades.reduce((m, t) => (t.returnPct < (m?.returnPct ?? Infinity) ? t : m), null);
  const pf = grossLoss > 0 ? grossWin / grossLoss : null;
  return {
    totalReturnPct: Number(totalReturnPct.toFixed(2)),
    buyHoldReturnPct: Number(buyHold.toFixed(2)),
    vsBuyHoldPct: Number((totalReturnPct - buyHold).toFixed(2)),
    annualizedReturnPct: annReturn == null ? null : Number((annReturn * 100).toFixed(2)),
    tradeCount: trades.length,
    winRatePct: trades.length ? Number(((wins.length / trades.length) * 100).toFixed(1)) : 0,
    profitFactor: pf == null ? null : Number(pf.toFixed(2)),
    expectancyPct: trades.length ? Number((trades.reduce((s, t) => s + t.returnPct, 0) / trades.length).toFixed(3)) : 0,
    avgWinPct: wins.length ? Number((grossWin / wins.length).toFixed(3)) : null,
    avgLossPct: losses.length ? Number((-grossLoss / losses.length).toFixed(3)) : null,
    maxDrawdownPct: Number((maxDD * 100).toFixed(2)),
    sharpe: sharpe == null ? null : Number(sharpe.toFixed(2)),
    calmar: calmar == null ? null : Number(calmar.toFixed(2)),
    bestTradePct: best ? best.returnPct : null,
    worstTradePct: worst ? worst.returnPct : null,
  };
}

/** Simulate a desired-position series over OHLCV: enter at next bar's open, mark close-to-close,
 *  charge (commission+slippage) on each unit of turnover. Returns metrics + trades + equity curve. */
function runBacktest(data, desired, { commission = 0.0004, slippage = 0.0005, interval = '1h' } = {}) {
  const { opens, closes, openTimes } = data;
  const n = closes.length;
  const cost = (Number(commission) || 0) + (Number(slippage) || 0);

  // pos[i] = position held DURING bar i (decided at the close of bar i-1).
  const pos = new Array(n).fill(0);
  for (let i = 1; i < n; i++) pos[i] = desired[i - 1] == null ? 0 : desired[i - 1];

  let equity = 1, peak = 1, maxDD = 0;
  const barRets = [];
  const curve = [{ time: openTimes[0], equity: 1 }];
  for (let i = 1; i < n; i++) {
    let r = pos[i] * (closes[i] / closes[i - 1] - 1);
    const turnover = Math.abs(pos[i] - pos[i - 1]);
    if (turnover) r -= turnover * cost;
    equity *= 1 + r;
    barRets.push(r);
    if (equity > peak) peak = equity;
    const dd = equity / peak - 1;
    if (dd < maxDD) maxDD = dd;
    curve.push({ time: openTimes[i], equity: Number(equity.toFixed(6)) });
  }

  // Trades = maximal runs of a constant nonzero position; enter at the run's first open,
  // exit at the open of the bar after it ends (or the final close if it runs to the edge).
  const trades = [];
  let i = 1;
  while (i < n) {
    if (pos[i] !== 0) {
      const side = pos[i], start = i;
      while (i + 1 < n && pos[i + 1] === side) i++;
      const exitIdx = i + 1 < n ? i + 1 : i;
      const entryPrice = opens[start];
      const exitPrice = i + 1 < n ? opens[i + 1] : closes[i];
      const net = side * (exitPrice / entryPrice - 1) - 2 * cost;
      trades.push({
        side: side > 0 ? 'LONG' : 'SHORT',
        entryTime: openTimes[start], exitTime: openTimes[exitIdx],
        entryPrice: px(entryPrice), exitPrice: px(exitPrice),
        bars: exitIdx - start,
        returnPct: Number((net * 100).toFixed(3)),
      });
    }
    i++;
  }

  return { metrics: computeMetrics({ barRets, equity, maxDD, trades, closes, interval }), trades, curve, barRets, pos };
}

function resolveStrategy(strategy) {
  const key = String(strategy || '').toLowerCase();
  if (!STRATEGIES[key]) throw new Error(`unknown strategy "${strategy}". Available: ${STRATEGY_KEYS.join(', ')}`);
  return { key, strat: STRATEGIES[key] };
}

function desiredFor(strat, bundle, allowShort) {
  let desired = strat.fn(bundle);
  if (strat.longOnly || !allowShort) desired = desired.map((d) => Math.max(0, d ?? 0));
  return desired;
}

/**
 * Backtest one strategy over a symbol's klines and return institutional metrics: total &
 * annualized return, Sharpe, Calmar, max drawdown, win rate, profit factor, expectancy,
 * avg win/loss, best/worst trade — plus a buy-&-hold benchmark. Enters at the next bar's open
 * (no lookahead) and charges commission+slippage on turnover. `includeTrades`/`includeEquityCurve`
 * attach the full trade log / equity path (off by default — they can be large). Strategies:
 * rsi, bollinger, macd, ema_cross, supertrend, donchian, rsi_pullback, keltner, triple_ema.
 */
export async function backtestStrategy({ market = 'futures', symbol, interval = '1h', strategy = 'ema_cross', limit = 500, commission = 0.0004, slippage = 0.0005, allowShort = true, includeTrades = false, includeEquityCurve = false, _deps = {} } = {}) {
  if (!symbol) throw new Error('symbol is required');
  const { key, strat } = resolveStrategy(strategy);
  const lim = Math.max(60, Math.min(Number(limit) || 500, isFuturesLike(market) ? 1500 : 1000));
  const kl = await getKlines({ market, symbol, interval, limit: lim, _deps });
  const data = ohlcvFull(kl.candles);
  const n = data.closes.length;
  if (n < 60) throw new Error(`not enough candles to backtest (${n}); need at least 60`);
  const bundle = { ...data, ind: indicatorBundle(data.highs, data.lows, data.closes) };
  const desired = desiredFor(strat, bundle, allowShort);
  const { metrics, trades, curve } = runBacktest(data, desired, { commission, slippage, interval });
  return {
    success: true, market, symbol: String(symbol).toUpperCase(), interval,
    strategy: key, strategyName: strat.name, bars: n,
    longOnly: !!strat.longOnly || !allowShort,
    commission: Number(commission), slippage: Number(slippage),
    ...metrics,
    ...(includeTrades ? { trades } : {}),
    ...(includeEquityCurve ? { equityCurve: curve } : {}),
  };
}

/**
 * Run ALL strategies on one symbol (one klines fetch, indicators computed once) and return a
 * ranked table sorted by `sortBy` (totalReturnPct default / sharpe / calmar / winRatePct /
 * profitFactor / maxDrawdownPct). Quick way to see which approach fits the current regime.
 */
export async function compareStrategies({ market = 'futures', symbol, interval = '1h', limit = 500, commission = 0.0004, slippage = 0.0005, allowShort = true, sortBy = 'totalReturnPct', _deps = {} } = {}) {
  if (!symbol) throw new Error('symbol is required');
  const lim = Math.max(60, Math.min(Number(limit) || 500, isFuturesLike(market) ? 1500 : 1000));
  const kl = await getKlines({ market, symbol, interval, limit: lim, _deps });
  const data = ohlcvFull(kl.candles);
  const n = data.closes.length;
  if (n < 60) throw new Error(`not enough candles to backtest (${n}); need at least 60`);
  const bundle = { ...data, ind: indicatorBundle(data.highs, data.lows, data.closes) };
  const valid = ['totalReturnPct', 'annualizedReturnPct', 'sharpe', 'calmar', 'winRatePct', 'profitFactor', 'maxDrawdownPct', 'expectancyPct'];
  const key = valid.includes(sortBy) ? sortBy : 'totalReturnPct';

  const results = STRATEGY_KEYS.map((sk) => {
    const strat = STRATEGIES[sk];
    const desired = desiredFor(strat, bundle, allowShort);
    const { metrics } = runBacktest(data, desired, { commission, slippage, interval });
    return { strategy: sk, strategyName: strat.name, ...metrics };
  });
  // maxDrawdownPct is negative → "best" is closest to 0 (descending already does that); all others descending.
  const ranked = [...results].sort((a, b) => (b[key] ?? -Infinity) - (a[key] ?? -Infinity));
  return {
    success: true, market, symbol: String(symbol).toUpperCase(), interval, bars: n, sortBy: key,
    buyHoldReturnPct: results[0]?.buyHoldReturnPct ?? null,
    best: ranked[0]?.strategy ?? null,
    ranked,
  };
}

/**
 * Out-of-sample consistency check (train/test split). Backtests the strategy over the full series
 * once, then scores the in-sample (first `trainRatio`) and out-of-sample (the rest) windows
 * separately and emits an overfitting verdict from the OOS-vs-IS annualized-return ratio:
 * ROBUST / MODERATE / WEAK / OVERFITTED / UNPROFITABLE. NOTE: parameters are fixed (no grid
 * optimization), so this measures temporal robustness, not parameter-search overfitting.
 */
export async function walkForwardBacktest({ market = 'futures', symbol, interval = '1h', strategy = 'ema_cross', limit = 1000, trainRatio = 0.7, commission = 0.0004, slippage = 0.0005, allowShort = true, _deps = {} } = {}) {
  if (!symbol) throw new Error('symbol is required');
  const { key, strat } = resolveStrategy(strategy);
  const ratio = Number(trainRatio);
  if (!(ratio > 0.1 && ratio < 0.95)) throw new Error('trainRatio must be between 0.1 and 0.95');
  const lim = Math.max(120, Math.min(Number(limit) || 1000, isFuturesLike(market) ? 1500 : 1000));
  const kl = await getKlines({ market, symbol, interval, limit: lim, _deps });
  const data = ohlcvFull(kl.candles);
  const n = data.closes.length;
  if (n < 120) throw new Error(`not enough candles for walk-forward (${n}); need at least 120`);
  const bundle = { ...data, ind: indicatorBundle(data.highs, data.lows, data.closes) };
  const desired = desiredFor(strat, bundle, allowShort);
  const { barRets, trades } = runBacktest(data, desired, { commission, slippage, interval });

  const splitBar = Math.floor(n * ratio);          // index into closes/openTimes
  const splitTime = data.openTimes[splitBar];
  // barRets[k] is the return realized on bar k+1, so it aligns to closes index k+1.
  const window = (lo, hi) => {
    const rets = barRets.slice(Math.max(0, lo - 1), hi - 1);
    const eq = rets.reduce((e, r) => e * (1 + r), 1);
    let peak = 1, mdd = 0; let cur = 1;
    for (const r of rets) { cur *= 1 + r; if (cur > peak) peak = cur; const dd = cur / peak - 1; if (dd < mdd) mdd = dd; }
    const tr = trades.filter((t) => t.entryTime >= data.openTimes[lo] && t.entryTime < (hi < n ? data.openTimes[hi] : Infinity));
    return computeMetrics({ barRets: rets, equity: eq, maxDD: mdd, trades: tr, closes: data.closes.slice(lo, hi), interval });
  };
  const train = window(1, splitBar);
  const test = window(splitBar, n);

  const tr = train.annualizedReturnPct, te = test.annualizedReturnPct;
  let verdict;
  if (tr == null || te == null) verdict = 'INSUFFICIENT_DATA';
  else if (te <= 0 && tr > 0) verdict = 'OVERFITTED';
  else if (te <= 0) verdict = 'UNPROFITABLE';
  else if (tr <= 0) verdict = 'INCONCLUSIVE';            // test profitable, train wasn't
  else if (te >= 0.5 * tr) verdict = 'ROBUST';
  else if (te >= 0.2 * tr) verdict = 'MODERATE';
  else verdict = 'WEAK';

  return {
    success: true, market, symbol: String(symbol).toUpperCase(), interval,
    strategy: key, strategyName: strat.name, bars: n, trainRatio: ratio,
    splitTime, verdict,
    train, test,
    note: 'Fixed-parameter train/test consistency check — measures temporal robustness, not parameter-search overfitting.',
  };
}

// ── Multi-timeframe alignment ────────────────────────────────────────────────

/**
 * Fan getTechnicals across several timeframes and report trend/momentum confluence — do the
 * higher and lower timeframes agree? Returns each timeframe's trend/momentum/RSI plus a
 * confluence summary (bullish/bearish/neutral counts, a -1..1 score, a bias tag and an
 * `aligned` flag when every timeframe points the same way). Per-timeframe errors are inline.
 */
export async function getMultiTimeframe({ market = 'futures', symbol, intervals, _deps = {} } = {}) {
  if (!symbol) throw new Error('symbol is required');
  const ivs = (Array.isArray(intervals) && intervals.length
    ? intervals
    : (typeof intervals === 'string' && intervals ? intervals.split(',') : ['15m', '1h', '4h', '1d']))
    .map((s) => String(s).trim()).filter(Boolean);
  const per = await Promise.all(ivs.map(async (iv) => {
    try {
      const t = await getTechnicals({ market, symbol, interval: iv, _deps });
      return { interval: iv, trend: t.classification.trend, momentum: t.classification.momentum, rsi: t.rsi, lastClose: t.lastClose };
    } catch (err) { return { interval: iv, error: err.message }; }
  }));
  const ok = per.filter((p) => !p.error);
  const bull = ok.filter((p) => p.trend === 'bullish').length;
  const bear = ok.filter((p) => p.trend === 'bearish').length;
  const score = ok.length ? Number(((bull - bear) / ok.length).toFixed(2)) : 0;
  const bias = score >= 0.34 ? 'bullish' : score <= -0.34 ? 'bearish' : 'mixed';
  return {
    success: true, market, symbol: String(symbol).toUpperCase(),
    timeframes: per,
    confluence: { bullish: bull, bearish: bear, neutral: ok.length - bull - bear, score, bias, aligned: ok.length > 1 && (bull === ok.length || bear === ok.length) },
  };
}

// ── Signal scanner ───────────────────────────────────────────────────────────

const SCAN_SIGNALS = {
  oversold: (t) => t.rsi != null && t.rsi <= 30,
  overbought: (t) => t.rsi != null && t.rsi >= 70,
  bullish: (t) => t.classification.trend === 'bullish',
  bearish: (t) => t.classification.trend === 'bearish',
  breakout: (t) => t.bollinger && t.lastClose != null && t.lastClose > t.bollinger.upper,
  breakdown: (t) => t.bollinger && t.lastClose != null && t.lastClose < t.bollinger.lower,
};

/** Public list of scanner signals (drives the MCP enum + CLI help). */
export const SCAN_SIGNAL_KEYS = Object.keys(SCAN_SIGNALS);

/**
 * Scan a candidate list of symbols for a technical signal — oversold / overbought (RSI≤30 / ≥70),
 * bullish / bearish (trend classification), or breakout / breakdown (close beyond a Bollinger band).
 * One klines call per symbol (capped at 20 — pass a focused list). Returns the matching symbols
 * with their RSI/trend/lastClose, plus the scanned count and any per-symbol errors.
 */
export async function scanSignals({ market = 'futures', symbols, signal = 'oversold', interval = '1h', _deps = {} } = {}) {
  const sig = String(signal || '').toLowerCase();
  if (!SCAN_SIGNALS[sig]) throw new Error(`unknown signal "${signal}". Available: ${SCAN_SIGNAL_KEYS.join(', ')}`);
  const list = (Array.isArray(symbols) ? symbols : (typeof symbols === 'string' && symbols ? symbols.split(',') : []))
    .map((s) => String(s).trim().toUpperCase()).filter(Boolean);
  if (!list.length) throw new Error('pass at least one symbol to scan (array or CSV)');
  const capped = [...new Set(list)].slice(0, 20);
  const test = SCAN_SIGNALS[sig];

  const per = await Promise.all(capped.map(async (sym) => {
    try {
      const t = await getTechnicals({ market, symbol: sym, interval, _deps });
      return { symbol: sym, match: !!test(t), rsi: t.rsi, trend: t.classification.trend, momentum: t.classification.momentum, lastClose: t.lastClose };
    } catch (err) { return { symbol: sym, error: err.message }; }
  }));
  const matches = per.filter((p) => !p.error && p.match).map(({ match, ...rest }) => rest);
  const errors = per.filter((p) => p.error).map(({ symbol, error }) => ({ symbol, error }));
  return {
    success: true, market, interval, signal: sig,
    ...(list.length > capped.length ? { note: `capped to first 20 of ${list.length} symbols` } : {}),
    scanned: capped.length, matchCount: matches.length, matches,
    ...(errors.length ? { errors } : {}),
  };
}

// ── Candlestick pattern detection ────────────────────────────────────────────
// Pure single-/multi-bar pattern recognition off klines. Each detector reads only the bar at
// index i and a few before it (causal). Tolerances are fractions of the bar's range so they
// scale across price magnitudes. Returns the bias (bullish/bearish/neutral) of each pattern.

/** Detect candlestick patterns terminating at bar `i` (needs i ≥ 2 for the 3-bar patterns). */
function detectCandlestick(o, h, l, c, i) {
  const out = [];
  if (i < 0 || i >= c.length) return out;
  const body = Math.abs(c[i] - o[i]);
  const range = h[i] - l[i];
  if (range <= 0) return out;
  const upper = h[i] - Math.max(o[i], c[i]);
  const lower = Math.min(o[i], c[i]) - l[i];
  const bull = c[i] > o[i], bear = c[i] < o[i];
  const small = body <= 0.3 * range;
  // short-term context: are we coming off a down- or up-leg?
  const downCtx = i >= 3 && c[i] < c[i - 3];
  const upCtx = i >= 3 && c[i] > c[i - 3];

  if (body <= 0.1 * range) out.push({ pattern: 'doji', bias: 'neutral' });
  if (upper + lower <= 0.06 * range) out.push({ pattern: bull ? 'bullish_marubozu' : 'bearish_marubozu', bias: bull ? 'bullish' : 'bearish' });
  if (small && upper > body && lower > body) out.push({ pattern: 'spinning_top', bias: 'neutral' });

  // Hammer family (long lower wick, small upper)
  if (lower >= 2 * body && upper <= body && body > 0) {
    out.push(downCtx ? { pattern: 'hammer', bias: 'bullish' } : { pattern: 'hanging_man', bias: 'bearish' });
  }
  // Shooting-star family (long upper wick, small lower)
  if (upper >= 2 * body && lower <= body && body > 0) {
    out.push(upCtx ? { pattern: 'shooting_star', bias: 'bearish' } : { pattern: 'inverted_hammer', bias: 'bullish' });
  }

  if (i >= 1) {
    const pb = Math.abs(c[i - 1] - o[i - 1]);
    const pBull = c[i - 1] > o[i - 1], pBear = c[i - 1] < o[i - 1];
    // Engulfing
    if (pBear && bull && c[i] >= o[i - 1] && o[i] <= c[i - 1] && body > pb) out.push({ pattern: 'bullish_engulfing', bias: 'bullish' });
    if (pBull && bear && o[i] >= c[i - 1] && c[i] <= o[i - 1] && body > pb) out.push({ pattern: 'bearish_engulfing', bias: 'bearish' });
    // Harami (small body inside the prior big body)
    if (pBear && bull && body < pb && Math.max(o[i], c[i]) <= o[i - 1] && Math.min(o[i], c[i]) >= c[i - 1]) out.push({ pattern: 'bullish_harami', bias: 'bullish' });
    if (pBull && bear && body < pb && Math.max(o[i], c[i]) <= c[i - 1] && Math.min(o[i], c[i]) >= o[i - 1]) out.push({ pattern: 'bearish_harami', bias: 'bearish' });
    // Piercing line / dark cloud cover
    const pMid = (o[i - 1] + c[i - 1]) / 2;
    if (pBear && bull && o[i] < c[i - 1] && c[i] > pMid && c[i] < o[i - 1]) out.push({ pattern: 'piercing_line', bias: 'bullish' });
    if (pBull && bear && o[i] > c[i - 1] && c[i] < pMid && c[i] > o[i - 1]) out.push({ pattern: 'dark_cloud_cover', bias: 'bearish' });
    // Tweezers (near-equal extremes, color flip)
    const eps = 0.001 * c[i];
    if (Math.abs(l[i] - l[i - 1]) <= eps && pBear && bull) out.push({ pattern: 'tweezer_bottom', bias: 'bullish' });
    if (Math.abs(h[i] - h[i - 1]) <= eps && pBull && bear) out.push({ pattern: 'tweezer_top', bias: 'bearish' });
  }

  if (i >= 2) {
    const b1Bull = c[i - 2] > o[i - 2], b1Bear = c[i - 2] < o[i - 2];
    const b2Body = Math.abs(c[i - 1] - o[i - 1]);
    const b1Body = Math.abs(c[i - 2] - o[i - 2]);
    const b1Mid = (o[i - 2] + c[i - 2]) / 2;
    // Morning / evening star (big, small, big-opposite closing past the midpoint)
    if (b1Bear && b2Body < b1Body * 0.5 && bull && c[i] > b1Mid) out.push({ pattern: 'morning_star', bias: 'bullish' });
    if (b1Bull && b2Body < b1Body * 0.5 && bear && c[i] < b1Mid) out.push({ pattern: 'evening_star', bias: 'bearish' });
    // Three white soldiers / black crows
    const allBull = bull && pBullAt(o, c, i - 1) && pBullAt(o, c, i - 2);
    const allBear = bear && pBearAt(o, c, i - 1) && pBearAt(o, c, i - 2);
    if (allBull && c[i] > c[i - 1] && c[i - 1] > c[i - 2]) out.push({ pattern: 'three_white_soldiers', bias: 'bullish' });
    if (allBear && c[i] < c[i - 1] && c[i - 1] < c[i - 2]) out.push({ pattern: 'three_black_crows', bias: 'bearish' });
  }
  return out;
}
const pBullAt = (o, c, i) => c[i] > o[i];
const pBearAt = (o, c, i) => c[i] < o[i];

/**
 * Detect candlestick patterns off a symbol's recent klines (no chart). Returns the patterns on
 * the latest completed bar plus any that fired over the last `lookback` bars, each tagged
 * bullish/bearish/neutral. Recognizes doji, hammer/hanging-man, shooting-star/inverted-hammer,
 * marubozu, spinning-top, engulfing, harami, piercing-line/dark-cloud, tweezers, morning/evening
 * star, and three-soldiers/crows.
 */
export async function detectCandlestickPatterns({ market = 'futures', symbol, interval = '1h', limit = 100, lookback = 5, _deps = {} } = {}) {
  if (!symbol) throw new Error('symbol is required');
  const lim = Math.max(10, Math.min(Number(limit) || 100, isFuturesLike(market) ? 1500 : 1000));
  const kl = await getKlines({ market, symbol, interval, limit: lim, _deps });
  const { opens, highs, lows, closes, openTimes } = ohlcvFull(kl.candles);
  const n = closes.length;
  if (n < 3) throw new Error(`need at least 3 candles to detect patterns (${n})`);
  const back = Math.max(1, Math.min(Number(lookback) || 5, n - 2));
  const recent = [];
  for (let i = n - back; i < n; i++) {
    const p = detectCandlestick(opens, highs, lows, closes, i);
    if (p.length) recent.push({ time: openTimes[i], bar: { open: px(opens[i]), high: px(highs[i]), low: px(lows[i]), close: px(closes[i]) }, patterns: p });
  }
  return {
    success: true, market, symbol: String(symbol).toUpperCase(), interval, bars: n,
    lastBar: { time: openTimes[n - 1], patterns: detectCandlestick(opens, highs, lows, closes, n - 1) },
    recent,
  };
}

// ── Composite decision signal ────────────────────────────────────────────────
// Aggregate the indicators getTechnicals already computes into ONE weighted BUY/SELL/HOLD
// verdict with a -1..1 score, a confidence read, and human-readable reasons — no new data, no
// orders. Factors are framed as trend-following (price vs MAs, MACD, momentum) so they don't
// contradict each other; RSI extremes are surfaced as cautions that dampen confidence rather
// than flipping the score. `mtf:true` folds in getMultiTimeframe's cross-timeframe confluence.
// (Decision-engine idea borrowed from atilaahmettaner/tradingview-mcp's combined_analysis,
// minus its sentiment/news inputs.)

const clamp1 = (x) => Math.max(-1, Math.min(1, x));

/**
 * Composite BUY/SELL/HOLD signal for a symbol, scored off getTechnicals: price vs SMA200 (long
 * trend) and EMA50 (mid trend), MACD histogram, RSI momentum, price vs VWAP, and Bollinger %B —
 * each a weighted -1..1 factor, combined into an overall score, a signal, a confidence read and a
 * `reasons` list. RSI overbought/oversold and a wide/narrow band are flagged as `cautions` (they
 * lower confidence, never flip the call). `mtf:true` also pulls getMultiTimeframe and folds its
 * confluence score in as an extra factor (costs a few more klines calls). Pure aggregation — no
 * orders, no new data sources.
 */
export async function getSignal({ market = 'futures', symbol, interval = '1h', limit, mtf = false, _deps = {} } = {}) {
  if (!symbol) throw new Error('symbol is required');
  const tech = await getTechnicals({ market, symbol, interval, ...(limit != null ? { limit } : {}), _deps });
  const c = tech.lastClose;
  const factors = [];
  const add = (name, score, weight, label) => {
    if (score == null || !Number.isFinite(score)) return;
    factors.push({ name, score: clamp1(score), weight, label });
  };

  // Trend-following factor set (all share the same +bullish / -bearish convention).
  if (tech.sma?.['200'] != null && c != null) {
    const s = c > tech.sma['200'] ? 1 : c < tech.sma['200'] ? -1 : 0;
    add('trend_sma200', s, 1.0, `price ${s >= 0 ? 'above' : 'below'} SMA200 — ${s >= 0 ? 'bullish' : 'bearish'} long-term trend`);
  }
  if (tech.ema?.['50'] != null && c != null) {
    const s = c > tech.ema['50'] ? 1 : c < tech.ema['50'] ? -1 : 0;
    add('trend_ema50', s, 0.7, `price ${s >= 0 ? 'above' : 'below'} EMA50 — ${s >= 0 ? 'bullish' : 'bearish'} mid-term trend`);
  }
  if (tech.macd?.hist != null) {
    const s = tech.macd.hist > 0 ? 1 : tech.macd.hist < 0 ? -1 : 0;
    add('macd_hist', s, 0.8, `MACD histogram ${s >= 0 ? 'positive' : 'negative'} — momentum ${s >= 0 ? 'up' : 'down'}`);
  }
  if (tech.rsi != null) {
    add('rsi_momentum', clamp1((tech.rsi - 50) / 20), 0.6, `RSI ${tech.rsi} — momentum ${tech.rsi >= 50 ? 'up' : 'down'}`);
  }
  if (tech.vwap != null && c != null) {
    const s = c > tech.vwap ? 1 : c < tech.vwap ? -1 : 0;
    add('vs_vwap', s, 0.5, `price ${s >= 0 ? 'above' : 'below'} VWAP`);
  }
  if (tech.bollinger?.upper != null && tech.bollinger.lower != null && c != null) {
    const span = tech.bollinger.upper - tech.bollinger.lower;
    if (span > 0) {
      const pctB = (c - tech.bollinger.lower) / span; // 0 = lower band, 1 = upper band
      add('bollinger_pctb', clamp1((pctB - 0.5) * 2), 0.4, `Bollinger %B ${(pctB * 100).toFixed(0)}% — ${pctB >= 0.5 ? 'upper' : 'lower'} half of the band`);
    }
  }

  let mtfSummary = null;
  if (mtf) {
    try {
      const m = await getMultiTimeframe({ market, symbol, _deps });
      mtfSummary = { ...m.confluence, timeframes: m.timeframes.map((t) => ({ interval: t.interval, trend: t.trend })) };
      add('mtf_confluence', m.confluence.score, 1.0, `multi-timeframe ${m.confluence.bias} (${m.confluence.bullish}↑/${m.confluence.bearish}↓ of ${m.timeframes.length})`);
    } catch (err) { mtfSummary = { error: err.message }; }
  }

  // Weighted, normalized score over the factors that were available.
  const totalW = factors.reduce((s, f) => s + f.weight, 0);
  const score = totalW > 0 ? factors.reduce((s, f) => s + f.score * f.weight, 0) / totalW : 0;
  const sign = score > 0 ? 1 : score < 0 ? -1 : 0;

  // Agreement: share of (weighted, non-flat) factors pointing the same way as the verdict.
  const active = factors.filter((f) => f.score !== 0);
  const activeW = active.reduce((s, f) => s + f.weight, 0);
  const agreeW = active.filter((f) => Math.sign(f.score) === sign).reduce((s, f) => s + f.weight, 0);
  const agreement = activeW > 0 ? agreeW / activeW : 0;

  const cautions = [];
  if (tech.rsi != null && tech.rsi >= 70) cautions.push(`RSI ${tech.rsi} overbought — pullback risk on longs`);
  if (tech.rsi != null && tech.rsi <= 30) cautions.push(`RSI ${tech.rsi} oversold — bounce risk on shorts`);
  if (tech.bollinger?.widthPct != null && tech.bollinger.widthPct < 2) cautions.push(`Bollinger bands narrow (${tech.bollinger.widthPct}%) — low volatility, breakout pending`);
  if (factors.length < 4) cautions.push(`only ${factors.length} indicators available (too few bars?) — signal is low-confidence`);

  const abs = Math.abs(score);
  const signal = score >= 0.3 ? 'BUY' : score <= -0.3 ? 'SELL' : 'HOLD';
  const strength = abs >= 0.6 ? 'strong' : abs >= 0.3 ? 'moderate' : 'weak';
  // Confidence blends magnitude + agreement, knocked down a notch when a caution is in play.
  let confidence = (abs >= 0.5 && agreement >= 0.7) ? 'high' : (abs >= 0.3 && agreement >= 0.55) ? 'moderate' : 'low';
  if (confidence === 'high' && cautions.length) confidence = 'moderate';

  const reasons = factors
    .filter((f) => f.score !== 0)
    .sort((a, b) => Math.abs(b.score * b.weight) - Math.abs(a.score * a.weight))
    .map((f) => f.label);

  return {
    success: true, market, symbol: String(symbol).toUpperCase(), interval,
    lastClose: c,
    signal, score: Number(score.toFixed(3)), strength, confidence,
    agreement: Number(agreement.toFixed(2)),
    bullishFactors: factors.filter((f) => f.score > 0).length,
    bearishFactors: factors.filter((f) => f.score < 0).length,
    reasons,
    ...(cautions.length ? { cautions } : {}),
    technicals: { rsi: tech.rsi, macdHist: tech.macd?.hist ?? null, sma200: tech.sma?.['200'] ?? null, ema50: tech.ema?.['50'] ?? null, vwap: tech.vwap, trend: tech.classification.trend, momentum: tech.classification.momentum },
    ...(mtfSummary ? { multiTimeframe: mtfSummary } : {}),
  };
}

