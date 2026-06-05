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
  const key = process.env[`BINANCE_API_KEY${suffix}`];
  const secret = process.env[`BINANCE_API_SECRET${suffix}`];
  if (!key || !secret) {
    throw new Error(
      `Binance credentials missing for account "${account}". Set BINANCE_API_KEY${suffix} and ` +
      `BINANCE_API_SECRET${suffix} (in your environment or a gitignored .env at the project root).`
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
  _timeOffset = await fetchTimeOffset({ market, fetchFn, now });
  return {
    success: true, market, offsetMs: _timeOffset, localTime: now(),
    note: Math.abs(_timeOffset) > 1000
      ? `clock skew ${_timeOffset}ms — offset is now applied to all signed requests`
      : 'clock within 1s of Binance',
  };
}

/** Public (unsigned) request helper for endpoints that do not require signing */
async function publicRequest({ market = 'futures', method = 'GET', endpoint, params = {}, includeApiKey = false, _deps = {} } = {}) {
  const fetchFn = _deps.fetch || fetch;
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
  riskAmount, riskPct, balance, account = '1', round = true, _deps = {},
} = {}) {
  const entryP = requireFinite(entry, 'entry');
  const stopP = requireFinite(stop, 'stop');
  const lev = requireFinite(leverage, 'leverage');
  if (entryP === stopP) throw new Error('entry and stop must differ');
  if (riskAmount == null && riskPct == null) throw new Error('pass riskAmount ($) or riskPct (% of balance)');
  const deps = resolveDeps(account, _deps);
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
 *  'round' (nearest) for price. Returns the original value if step is missing/invalid. */
function snap(value, step, mode = 'round') {
  const v = Number(value);
  const s = Number(step);
  if (!s || !Number.isFinite(s)) return v;
  const n = mode === 'floor' ? Math.floor(v / s) : Math.round(v / s);
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

  const isLive = !market.includes('testnet');
  const preview = { market, endpoint, ...params, live_funds: isLive };

  if (!confirm) {
    return {
      success: false,
      dry_run: true,
      account,
      message: `DRY RUN — no order sent. Pass confirm:true to place this ${isLive ? 'LIVE (real funds)' : 'TESTNET'} ${useAlgo ? 'conditional (algo) order' : 'order'}.`,
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
    return { success: false, dry_run: true, message: 'DRY RUN — no modify sent. Pass confirm:true to amend this LIVE order.', modify_preview: { market, endpoint, ...params } };
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
export async function getKlines({ market = 'futures', symbol, interval = '1h', startTime, endTime, limit = 500, _deps = {} } = {}) {
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
  const candles = (data || []).map((k) => ({
    openTime: k[0], open: k[1], high: k[2], low: k[3], close: k[4], volume: k[5], closeTime: k[6],
  }));
  return { success: true, market, symbol: sym, interval: iv, count: candles.length, candles };
}

/** 24-hour rolling price-change stats for a symbol (public). */
export async function get24hrTicker({ market = 'futures', symbol, _deps = {} } = {}) {
  if (!symbol) throw new Error('symbol is required');
  const sym = String(symbol).toUpperCase();
  const endpoint = isFuturesLike(market) ? `${futPrefix(market)}/v1/ticker/24hr` : '/api/v3/ticker/24hr';
  const data = await publicRequest({ market, endpoint, params: { symbol: sym }, _deps });
  // COIN-M returns an array (one row per contract); pick the matching symbol.
  const t = Array.isArray(data) ? (data.find((x) => x.symbol === sym) || data[0] || {}) : data;
  return {
    success: true, market, symbol: t.symbol || sym,
    lastPrice: t.lastPrice, priceChange: t.priceChange, priceChangePercent: t.priceChangePercent,
    weightedAvgPrice: t.weightedAvgPrice, highPrice: t.highPrice, lowPrice: t.lowPrice,
    openPrice: t.openPrice, volume: t.volume, quoteVolume: t.quoteVolume,
  };
}

/** Best bid/ask (top of book) for a symbol (public) — includes the computed spread. */
export async function getBookTicker({ market = 'futures', symbol, _deps = {} } = {}) {
  if (!symbol) throw new Error('symbol is required');
  const sym = String(symbol).toUpperCase();
  const endpoint = isFuturesLike(market) ? `${futPrefix(market)}/v1/ticker/bookTicker` : '/api/v3/ticker/bookTicker';
  const data = await publicRequest({ market, endpoint, params: { symbol: sym }, _deps });
  const t = Array.isArray(data) ? (data.find((x) => x.symbol === sym) || data[0] || {}) : data;
  const bid = Number(t.bidPrice), ask = Number(t.askPrice);
  const spread = Number.isFinite(bid) && Number.isFinite(ask) ? ask - bid : undefined;
  return {
    success: true, market, symbol: t.symbol || sym,
    bidPrice: t.bidPrice, bidQty: t.bidQty, askPrice: t.askPrice, askQty: t.askQty,
    spread: spread !== undefined ? String(spread) : undefined,
    spreadPct: spread !== undefined && bid ? `${(spread / bid * 100).toFixed(4)}%` : undefined,
  };
}

/** Current average price over a short window (spot-only; Binance returns ~5-min avg). */
export async function getAvgPrice({ market = 'spot', symbol, _deps = {} } = {}) {
  if (isFuturesLike(market)) throw new Error('avgPrice is spot-only (use get24hrTicker.weightedAvgPrice for futures)');
  if (!symbol) throw new Error('symbol is required');
  const sym = String(symbol).toUpperCase();
  const data = await publicRequest({ market, endpoint: '/api/v3/avgPrice', params: { symbol: sym }, _deps });
  return { success: true, market, symbol: sym, mins: data.mins, price: data.price };
}

/** Rolling-window price-change stats with a custom window (spot-only; windowSize e.g. "1d", "4h"). */
export async function getRollingWindowTicker({ market = 'spot', symbol, windowSize = '1d', _deps = {} } = {}) {
  if (isFuturesLike(market)) throw new Error('rolling-window ticker is spot-only (use get24hrTicker for futures)');
  if (!symbol) throw new Error('symbol is required');
  const sym = String(symbol).toUpperCase();
  const data = await publicRequest({ market, endpoint: '/api/v3/ticker', params: { symbol: sym, windowSize: String(windowSize) }, _deps });
  const t = Array.isArray(data) ? (data[0] || {}) : data;
  return {
    success: true, market, symbol: t.symbol || sym, windowSize: String(windowSize),
    lastPrice: t.lastPrice, priceChange: t.priceChange, priceChangePercent: t.priceChangePercent,
    weightedAvgPrice: t.weightedAvgPrice, highPrice: t.highPrice, lowPrice: t.lowPrice,
    openPrice: t.openPrice, volume: t.volume, quoteVolume: t.quoteVolume,
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

  const isLive = !market.includes('testnet');
  if (!confirm) {
    return {
      success: false, dry_run: true, market, account, live_funds: isLive, hedgeMode: !!hedgeMode,
      message: `DRY RUN — ${legs.length} legs (${legs.map((l) => l.leg).join(', ')}). Pass confirm:true to place this ${isLive ? 'LIVE (real funds)' : 'TESTNET'} bracket.`,
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
    seed: seedQuantity ? { type: 'MARKET', quantity: seedQuantity } : undefined,
    stop: stop != null ? { type: 'STOP_MARKET', closePosition: true, triggerPrice: stop } : undefined,
    ...(warnings.length ? { warnings } : {}),
  };

  if (!confirm) {
    return {
      success: false, dry_run: true,
      message: `DRY RUN — no orders sent. Pass confirm:true to place ${rungs.length} ladder rungs${seedQuantity ? ' + seed' : ''}${stop != null ? ' + stop' : ''} (LIVE real funds).`,
      ladder_preview: plan,
      sample_rungs: [...rungs.slice(0, 3), ...(rungs.length > 3 ? [rungs[rungs.length - 1]] : [])],
    };
  }

  // 1) optional seed market order — opens the position so a stop has something to guard.
  let seedResult;
  if (seedQuantity) {
    seedResult = await placeOrder({ market, symbol: sym, side: sd, type: 'MARKET', quantity: seedQuantity, positionSide: ps || undefined, allowTaker: true, round, account, confirm: true, _deps: deps });
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
      message: `DRY RUN — the ${pos.side} ${sym} position has NO protective stop. Pass confirm:true to place a closePosition STOP_MARKET @ ${trigger}.`,
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
  if (!confirm) {
    return {
      success: false, dry_run: true, account,
      message: `DRY RUN — pass confirm:true to cancel ALL open orders for ${sym} on ${market}.`,
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
  const ttype = type || transferType(String(from).toLowerCase(), String(to).toLowerCase());
  const params = { type: ttype, asset: String(asset).toUpperCase(), amount: String(amt) };

  if (!confirm) {
    return {
      success: false,
      dry_run: true,
      message: `DRY RUN — no transfer sent. Pass confirm:true to move ${amt} ${params.asset} (${ttype}, REAL funds).`,
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

