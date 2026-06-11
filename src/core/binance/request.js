// Binance core — env/key loading, host & market resolution, signing, request
// plumbing, and the shared order/precision constants. Lowest layer of the
// binance module: every sibling imports from here; this imports from none of them.
import crypto from 'node:crypto';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../');

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
export function usePaperTrading(_deps = {}) {
    if (_deps && _deps.paperTrading !== undefined) return !!_deps.paperTrading;
    loadDotEnv();
    const v = String(process.env.BINANCE_PAPER_TRADING ?? process.env.PAPER_TRADING ?? '').trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

const PAPER_NOTE = 'PAPER_TRADING is ON — decision logged, nothing sent (even with confirm:true). Unset BINANCE_PAPER_TRADING / PAPER_TRADING to trade live.';
/** Extra fields merged into a dry-run response when the global paper-trading switch suppressed it. */
export const paperFields = (on) => (on ? {paper_trading: true, paper_note: PAPER_NOTE} : {});

/** Map a logical market to its effective host market. With the testnet switch on, "futures"
 *  becomes "futures-testnet" (etc.); an already-explicit "*-testnet" market is left alone, as is
 *  any market with no testnet variant. Endpoint paths are host-independent, so only the base
 *  host changes — the logical market is still echoed in responses. */
export function resolveMarket(market, _deps = {}) {
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
    return {key, secret};
}

/** Resolve a `_deps` object with the right credentials for `account`. An explicit `_deps.keys`
 *  still wins (the test/DI convention); otherwise keys are loaded via `_deps.getKeys` (overridable
 *  in tests) or the real `getKeys`. Lets a plain `account` string select a key set without
 *  changing the `signedRequest`/`publicRequest` `_deps.keys` contract. */
export function resolveDeps(account, _deps = {}) {
    if (_deps.keys) return _deps;
    const get = _deps.getKeys || getKeys;
    return {..._deps, keys: get(account)};
}

function sign(query, secret) {
    return crypto.createHmac('sha256', secret).update(query).digest('hex');
}

// Hard cap on any single REST round-trip so a stalled Binance endpoint can't hang
// a bot indefinitely. Injected mocks ignore the extra `signal` option.
const FETCH_TIMEOUT_MS = 15000;

async function timedFetch(fetchFn, url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetchFn(url, {...options, signal: controller.signal});
    } catch (err) {
        if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
            throw new Error(`Binance request timed out after ${timeoutMs}ms: ${url.split('?')[0]}`);
        }
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

// ms to add to the local clock to match Binance's server clock. Starts at 0 and is
// corrected automatically if a signed request is rejected for clock skew (-1021).
let _timeOffset = 0;

export const isFutures = (market) => market.startsWith('futures'); // USD-M only
export const isCoinM = (market) => market.startsWith('coinm');     // COIN-M (coin-margined)
export const isFuturesLike = (market) => isFutures(market) || isCoinM(market);
export const futPrefix = (market) => (isCoinM(market) ? '/dapi' : '/fapi'); // REST prefix for the futures-like markets

/** Rewrite plain-order params into Algo-endpoint params (algoType=CONDITIONAL,
 *  stopPrice→triggerPrice, newClientOrderId→clientAlgoId). Shared by placeOrder,
 *  placeBracket, and the COIN-M -4120 fallback. */
export function toAlgoParams(params) {
    const p = {...params, algoType: 'CONDITIONAL'};
    if (p.stopPrice !== undefined) {
        p.triggerPrice = p.stopPrice;
        delete p.stopPrice;
    }
    if (p.newClientOrderId !== undefined) {
        p.clientAlgoId = p.newClientOrderId;
        delete p.newClientOrderId;
    }
    return p;
}

/** True when a rejected conditional order should be retried on the Algo endpoint:
 *  COIN-M still uses /dapi/v1/order (Binance has NOT migrated dapi as of 2026-06 — verified
 *  against the official change log). If Binance ever migrates COIN-M the way it migrated
 *  USD-M (2025-12-09), the old endpoint will start returning -4120; this detects that. */
export const isAlgoMigrationError = (err) => /code -4120/.test(err?.message || '');

/** Fetch Binance server time and return the offset (serverTime - local), round-trip adjusted. */
async function fetchTimeOffset({market, fetchFn, now}) {
    const endpoint = isFuturesLike(market) ? `${futPrefix(market)}/v1/time` : '/api/v3/time';
    const before = now();
    const res = await timedFetch(fetchFn, BASES[market] + endpoint);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.serverTime) throw new Error(`Binance time sync failed (${res.status})`);
    const localMid = Math.round((before + now()) / 2); // midpoint compensates for round-trip latency
    return data.serverTime - localMid;
}

/** Perform a signed Binance request. Returns parsed JSON; throws on API error.
 *  Applies the cached clock offset and, on a -1021 (timestamp/recvWindow) error,
 *  resyncs the offset against server time and retries once. */
export async function signedRequest({market = 'futures', method = 'GET', endpoint, params = {}, _deps = {}}) {
    const fetchFn = _deps.fetch || fetch;
    const now = _deps.now || Date.now;
    const sleep = _deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const {key, secret} = _deps.keys || getKeys();
    // Route to the testnet host when the global switch is on (endpoint paths are unchanged).
    market = resolveMarket(market, _deps);
    const base = BASES[market];
    if (!base) throw new Error(`Unknown market "${market}". Use one of: ${Object.keys(BASES).join(', ')}`);

    const attempt = async () => {
        const query = new URLSearchParams({...params, recvWindow: '5000', timestamp: String(now() + _timeOffset)}).toString();
        const signature = sign(query, secret);
        const url = `${base}${endpoint}?${query}&signature=${signature}`;
        const res = await timedFetch(fetchFn, url, {method, headers: {'X-MBX-APIKEY': key}});
        const data = await res.json().catch(() => ({}));
        return {res, data};
    };

    let {res, data} = await attempt();
    if (data && data.code === -1021) { // timestamp outside recvWindow → resync clock and retry once
        try {
            _timeOffset = await fetchTimeOffset({market, fetchFn, now});
            ({res, data} = await attempt());
        } catch { /* fall through to surface the original error */
        }
    }
    // Rate-limit / IP-ban backoff: 429 (too many requests) and 418 (auto-banned). Honor Retry-After
    // when present, else exponential backoff. Retry up to 3 times before surfacing the error.
    for (let tries = 0; (res.status === 429 || res.status === 418) && tries < 3; tries++) {
        const retryAfter = Number(res.headers?.get?.('Retry-After')) || 0;
        await sleep(retryAfter > 0 ? retryAfter * 1000 : 500 * (2 ** tries));
        ({res, data} = await attempt());
    }
    if (!res.ok || (data && data.code !== undefined && data.code < 0)) {
        const codeNote = data?.code ? ` (code ${data.code})` : '';
        throw new Error(`Binance ${res.status}: ${data?.msg || JSON.stringify(data)}${codeNote}`);
    }
    return data;
}

/** Diagnostic: report the current local-vs-server clock offset (and pre-sync it). */
export async function getServerTime({market = 'futures', _deps = {}} = {}) {
    const fetchFn = _deps.fetch || fetch;
    const now = _deps.now || Date.now;
    const testnet = useTestnet(_deps);
    _timeOffset = await fetchTimeOffset({market: resolveMarket(market, _deps), fetchFn, now});
    return {
        success: true, market, testnet, offsetMs: _timeOffset, localTime: now(),
        note: Math.abs(_timeOffset) > 1000
            ? `clock skew ${_timeOffset}ms — offset is now applied to all signed requests`
            : 'clock within 1s of Binance',
    };
}

/** Public (unsigned) request helper for endpoints that do not require signing */
export async function publicRequest({market = 'futures', method = 'GET', endpoint, params = {}, includeApiKey = false, _deps = {}} = {}) {
    const fetchFn = _deps.fetch || fetch;
    market = resolveMarket(market, _deps); // testnet switch routes to the testnet host
    const base = BASES[market];
    if (!base) throw new Error(`Unknown market "${market}". Use one of: ${Object.keys(BASES).join(', ')}`);
    const query = new URLSearchParams(params).toString();
    const url = base + endpoint + (query ? `?${query}` : '');
    const headers = {};
    if (includeApiKey) {
        // historicalTrades requires an API key header but is not signed
        const {key} = _deps.keys || getKeys();
        if (!key) throw new Error('BINANCE_API_KEY missing for public endpoint that requires key');
        headers['X-MBX-APIKEY'] = key;
    }
    const res = await timedFetch(fetchFn, url, {method, headers: Object.keys(headers).length ? headers : undefined});
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw new Error(`Binance ${res.status}: ${data?.msg || JSON.stringify(data)}`);
    }
    return data;
}

// Supported order types. Stop/TP types let the STOP and TP levels from a chart
// plan become real resting orders.
export const ORDER_TYPES = ['MARKET', 'LIMIT', 'STOP', 'STOP_MARKET', 'TAKE_PROFIT', 'TAKE_PROFIT_MARKET'];
export const STOP_TYPES = ['STOP', 'STOP_MARKET', 'TAKE_PROFIT', 'TAKE_PROFIT_MARKET'];
export const LIMIT_TYPES = ['LIMIT', 'STOP', 'TAKE_PROFIT']; // require a limit price (can be maker)
export const TAKER_TYPES = ['MARKET', 'STOP_MARKET', 'TAKE_PROFIT_MARKET']; // cross the book — always taker
export const VALID_TIF = ['GTC', 'IOC', 'FOK', 'GTX']; // GTX = post-only (maker-only) on futures

/** Number of decimals implied by a Binance filter step string (e.g. "0.001" → 3). */
function stepDecimals(step) {
    const dec = (String(step).split('.')[1] || '').replace(/0+$/, '');
    return dec.length;
}

/** Snap a value to a Binance step/tick. mode 'floor' for quantity (never over-buy),
 *  'ceil' to guarantee a minimum (never under-fill), 'round' (nearest) for price.
 *  Returns the original value if step is missing/invalid. */
export function snap(value, step, mode = 'round') {
    const v = Number(value);
    const s = Number(step);
    if (!s || !Number.isFinite(s)) return v;
    const ROUNDERS = {floor: Math.floor, ceil: Math.ceil};
    const rounder = ROUNDERS[mode] || Math.round;
    const n = rounder(v / s);
    return Number((n * s).toFixed(stepDecimals(step)));
}
