// Binance core — market sentiment & scheduled-event awareness. Deliberately tiny:
// the crypto Fear & Greed index (one free, keyless API call to alternative.me — NOT
// a Binance endpoint) and a static calendar of the scheduled US macro events that
// reliably move crypto (FOMC rate decisions, CPI releases). No news scraping, no
// social sentiment — those stay out of scope. Like the rest of the module, every
// function takes `_deps` ({fetch, now}) for DI testing.

const FNG_URL = 'https://api.alternative.me/fng/';
const FETCH_TIMEOUT_MS = 15000;

function fngRead(value) {
    if (value <= 25) return 'extreme fear — contrarian-bullish zone (capitulation territory)';
    if (value <= 45) return 'fear — sentiment depressed';
    if (value < 55) return 'neutral';
    if (value < 75) return 'greed — sentiment elevated';
    return 'extreme greed — contrarian-bearish zone (euphoria territory)';
}

/** Crypto Fear & Greed index (alternative.me, free/keyless). 0 = extreme fear,
 *  100 = extreme greed. Market-wide (BTC-weighted volatility/momentum/social/dominance),
 *  classically read contrarian at the extremes. `limit` > 1 returns recent daily history. */
export async function getFearGreed({limit = 1, _deps = {}} = {}) {
    const fetchFn = _deps.fetch || fetch;
    const lim = Math.max(1, Math.min(Number(limit) || 1, 90));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res;
    try {
        res = await fetchFn(`${FNG_URL}?limit=${lim}&format=json`, {signal: controller.signal});
    } catch (err) {
        if (err?.name === 'AbortError') throw new Error(`Fear & Greed request timed out after ${FETCH_TIMEOUT_MS}ms`);
        throw err;
    } finally {
        clearTimeout(timer);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !Array.isArray(data.data) || !data.data.length) {
        throw new Error(`Fear & Greed fetch failed (${res.status}): ${data?.metadata?.error || 'no data'}`);
    }
    const rows = data.data.map((r) => ({
        value: Number(r.value), classification: r.value_classification, timestamp: Number(r.timestamp) * 1000,
    }));
    const latest = rows[0];
    return {
        success: true, source: 'alternative.me crypto Fear & Greed (market-wide, BTC-weighted)',
        value: latest.value, classification: latest.classification, read: fngRead(latest.value),
        timestamp: latest.timestamp,
        ...(rows.length > 1 ? {history: rows} : {}),
    };
}

// ── Scheduled US macro events (static calendar) ──────────────────────────────
// The two release types that reliably move crypto on the clock. STATIC DATA —
// verified against federalreserve.gov and bls.gov for 2026; extend yearly.
// FOMC date = decision day (statement 14:00 ET, presser 14:30 ET). `dotPlot`
// marks meetings with the Summary of Economic Projections. CPI = 08:30 ET.
const MACRO_EVENTS = [
    ...['2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17', '2026-07-29', '2026-09-16', '2026-10-28', '2026-12-09']
        .map((date, i) => ({date, type: 'FOMC', name: 'FOMC rate decision', time: '14:00 ET', dotPlot: [1, 3, 5, 7].includes(i)})),
    ...['2026-01-13', '2026-02-11', '2026-03-11', '2026-04-10', '2026-05-12', '2026-06-10', '2026-07-14', '2026-08-12', '2026-09-11', '2026-10-14', '2026-11-10', '2026-12-10']
        .map((date) => ({date, type: 'CPI', name: 'US CPI release', time: '08:30 ET'})),
].sort((a, b) => a.date.localeCompare(b.date));

const DAY_MS = 86400000;
const lastEventDate = MACRO_EVENTS.at(-1).date;

/** Days from `nowMs` until midnight UTC of an ISO date (negative = past). Day-level
 *  precision is deliberate — the calendar answers "is an event close?", not "in how many hours". */
const daysUntil = (isoDate, nowMs) => Math.ceil((Date.parse(`${isoDate}T00:00:00Z`) - nowMs) / DAY_MS);

/** "FOMC rate decision in 2 days (2026-06-17, 14:00 ET) — includes dot-plot projections" */
function imminentWarning(e) {
    let when = `in ${e.daysUntil} days`;
    if (e.daysUntil === 0) when = 'TODAY';
    else if (e.daysUntil === 1) when = 'in 1 day';
    const dot = e.dotPlot ? ' — includes dot-plot projections' : '';
    return `${e.name} ${when} (${e.date}, ${e.time})${dot}`;
}

/** Upcoming scheduled macro events (FOMC, CPI) within `daysAhead` days — pure, no network.
 *  Volatility compressions (narrow Bollinger bands) often resolve on these releases; check
 *  this before positioning into a squeeze. Static calendar: verify against
 *  federalreserve.gov/monetarypolicy/fomccalendars.htm and bls.gov/schedule when in doubt. */
export function getMarketEvents({daysAhead = 14, _deps = {}} = {}) {
    const now = _deps.now || Date.now;
    const nowMs = now();
    const horizon = Math.max(1, Math.min(Number(daysAhead) || 14, 365));
    const upcoming = MACRO_EVENTS
        .map((e) => ({...e, daysUntil: daysUntil(e.date, nowMs)}))
        .filter((e) => e.daysUntil >= 0 && e.daysUntil <= horizon);
    const next = upcoming[0] || null;
    const imminent = upcoming.filter((e) => e.daysUntil <= 2);
    const stale = nowMs > Date.parse(`${lastEventDate}T00:00:00Z`);
    return {
        success: true, daysAhead: horizon, count: upcoming.length,
        next, events: upcoming,
        ...(imminent.length ? {warning: imminent.map((e) => imminentWarning(e))} : {}),
        ...(stale ? {note: `calendar ends ${lastEventDate} — extend MACRO_EVENTS in src/core/binance/sentiment.js with the next year's schedule`} : {}),
        source: 'Static calendar (federalreserve.gov FOMC schedule + bls.gov CPI schedule, 2026). Statement 14:00 ET / CPI 08:30 ET.',
    };
}
