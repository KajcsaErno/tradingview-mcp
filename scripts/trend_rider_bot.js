#!/usr/bin/env node
// Adaptive Trend Rider bot — automates strategies/adaptive_trend_rider.pine on Binance futures.
//
// One run = one decision: fetch klines, evaluate the last CLOSED bar, act, exit.
// Schedule it (Task Scheduler / cron) at a few minutes past the hour; it no-ops
// unless a new bar of the configured interval has closed since the last run.
//
// SAFETY: paper mode is the default. Without --live this process sets PAPER_TRADING=1,
// so every order call logs its full preview but sends NOTHING (the core kill-switch).
// Paper fills are simulated in the state file so the lifecycle (entries, adds, stops,
// flips) can be reviewed in strategies/trend-rider-log.jsonl before going live.
//
// Usage: node scripts/trend_rider_bot.js [--live] [--symbol BTCUSDC] [--interval 4h]
//        [--account 1] [--risk 2.25]
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ── Pure indicator math (Wilder smoothing, matches Pine ta.* semantics) ──────
export function emaSeries(values, period) {
    const out = new Array(values.length).fill(null);
    if (values.length < period) return out;
    let sum = 0;
    for (let i = 0; i < period; i++) sum += values[i];
    let ema = sum / period;
    out[period - 1] = ema;
    const k = 2 / (period + 1);
    for (let i = period; i < values.length; i++) {
        ema = values[i] * k + ema * (1 - k);
        out[i] = ema;
    }
    return out;
}

function trueRanges(highs, lows, closes) {
    const tr = new Array(highs.length).fill(null);
    for (let i = 0; i < highs.length; i++) {
        tr[i] = i === 0 ? highs[i] - lows[i]
            : Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
    }
    return tr;
}

function wilderSeries(values, period, startIdx = 0) {
    // Wilder RMA: SMA seed over the first `period` values, then rma = (prev*(p-1)+v)/p
    const out = new Array(values.length).fill(null);
    let sum = 0, n = 0, rma = null;
    for (let i = startIdx; i < values.length; i++) {
        if (values[i] === null) continue;
        if (rma === null) {
            sum += values[i];
            n++;
            if (n === period) {
                rma = sum / period;
                out[i] = rma;
            }
        } else {
            rma = (rma * (period - 1) + values[i]) / period;
            out[i] = rma;
        }
    }
    return out;
}

export function atrSeries(highs, lows, closes, period = 14) {
    return wilderSeries(trueRanges(highs, lows, closes), period);
}

export function adxSeries(highs, lows, closes, period = 14) {
    const len = highs.length;
    const plusDM = new Array(len).fill(null);
    const minusDM = new Array(len).fill(null);
    for (let i = 1; i < len; i++) {
        const up = highs[i] - highs[i - 1];
        const down = lows[i - 1] - lows[i];
        plusDM[i] = up > down && up > 0 ? up : 0;
        minusDM[i] = down > up && down > 0 ? down : 0;
    }
    const atr = wilderSeries(trueRanges(highs, lows, closes).slice(1).map((v) => v), period);
    const smPlus = wilderSeries(plusDM.slice(1), period);
    const smMinus = wilderSeries(minusDM.slice(1), period);
    const dx = new Array(len - 1).fill(null);
    for (let i = 0; i < len - 1; i++) {
        if (smPlus[i] === null || smMinus[i] === null || atr[i] === null || atr[i] === 0) continue;
        const diP = 100 * smPlus[i] / atr[i];
        const diM = 100 * smMinus[i] / atr[i];
        const denom = diP + diM;
        dx[i] = denom === 0 ? 0 : 100 * Math.abs(diP - diM) / denom;
    }
    const adxShifted = wilderSeries(dx, period);
    // re-align to candle indexing (we dropped index 0 for DM math)
    const out = new Array(len).fill(null);
    for (let i = 0; i < adxShifted.length; i++) out[i + 1] = adxShifted[i];
    return out;
}

export const DEFAULT_CFG = {
    emaFastLen: 20, emaSlowLen: 50, emaTrendLen: 200,
    atrLen: 14, adxLen: 14, adxThresh: 25,
    kcMult: 2.0, atrStopMult: 2.5, maxAdds: 3,
    riskPct: 2.25, maxLev: 3.0,
};

/** Evaluate the strategy on the last CLOSED candle. Pure — no network, no state writes.
 *  candles: ascending [{openTime, open, high, low, close}] (numbers), CLOSED bars only.
 *  position: null or {qty, adds, stop} — the currently open long (live or paper).
 *  lastEntryTime: openTime of the bar of the most recent entry/add (for the re-arm gate). */
export function computeDecision({ candles, position = null, lastEntryTime = null, cfg = DEFAULT_CFG }) {
    const closes = candles.map((c) => Number(c.close));
    const highs = candles.map((c) => Number(c.high));
    const lows = candles.map((c) => Number(c.low));
    const i = candles.length - 1;
    const emaF = emaSeries(closes, cfg.emaFastLen);
    const emaS = emaSeries(closes, cfg.emaSlowLen);
    const emaT = emaSeries(closes, cfg.emaTrendLen);
    const atr = atrSeries(highs, lows, closes, cfg.atrLen);
    const adx = adxSeries(highs, lows, closes, cfg.adxLen);
    if ([emaF[i], emaS[i], emaT[i], atr[i], adx[i]].some((v) => v === null) || i < 1) {
        return { action: 'none', reason: 'indicator_warmup', indicators: null };
    }
    const upperKC = emaF[i] + cfg.kcMult * atr[i];
    const trendUp = emaF[i] > emaS[i] && closes[i] > emaT[i];
    const strongTrend = adx[i] > cfg.adxThresh;
    const breakout = closes[i] > upperKC;
    const flipDown = emaF[i - 1] >= emaS[i - 1] && emaF[i] < emaS[i];
    // Re-arm gate: a bar AFTER the last entry must have closed back at/below the fast EMA.
    let armed = lastEntryTime === null;
    if (!armed) {
        for (let j = i; j >= 0 && candles[j].openTime > lastEntryTime; j--) {
            if (closes[j] < emaF[j]) { armed = true; break; }
        }
    }
    const indicators = {
        barTime: new Date(candles[i].openTime).toISOString(),
        close: closes[i],
        emaFast: round2(emaF[i]), emaSlow: round2(emaS[i]), emaTrend: round2(emaT[i]),
        atr: round2(atr[i]), adx: round2(adx[i]), upperKC: round2(upperKC),
        trendUp, strongTrend, breakout, armed,
    };
    const signal = trendUp && strongTrend && breakout && armed;
    const stopForBar = closes[i] - cfg.atrStopMult * atr[i];
    if (position) {
        if (flipDown) return { action: 'exit', reason: 'trend_flip', indicators };
        if (signal && position.adds < cfg.maxAdds) {
            // stop ratchets: never lower than the current one
            const stop = Math.max(position.stop ?? -Infinity, stopForBar);
            return { action: 'add', reason: 'pyramid_breakout', stop: round2(stop), indicators };
        }
        return { action: 'none', reason: 'holding', indicators };
    }
    if (signal) return { action: 'enter', reason: 'breakout', stop: round2(stopForBar), indicators };
    return { action: 'none', reason: 'no_signal', indicators };
}

/** Risk-based sizing identical to the Pine: risk% of equity over the stop distance,
 *  with TOTAL notional (existing position + new entry) capped at maxLev × equity. */
export function sizeEntry({ equity, price, atr, existingQty = 0, cfg = DEFAULT_CFG }) {
    const stopDist = cfg.atrStopMult * atr;
    const riskQty = (equity * cfg.riskPct / 100) / stopDist;
    const capQty = Math.max(0, (equity * cfg.maxLev) / price - existingQty);
    return Math.min(riskQty, capQty);
}

const round2 = (v) => Math.round(v * 100) / 100;

// ── State & log ──────────────────────────────────────────────────────────────
const STATE_PATH = path.join(ROOT, 'strategies', 'trend-rider-state.json');
const LOG_PATH = path.join(ROOT, 'strategies', 'trend-rider-log.jsonl');

function loadState() {
    try {
        return JSON.parse(readFileSync(STATE_PATH, 'utf8'));
    } catch {
        return { lastProcessedBarTime: 0, lastEntryTime: null, adds: 0, stop: null, paper: { position: null, equity: null } };
    }
}

function saveState(state) {
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function logLine(entry) {
    appendFileSync(LOG_PATH, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
}

// ── Main ─────────────────────────────────────────────────────────────────────
function flag(name, def) {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : def;
}
const has = (name) => process.argv.includes(`--${name}`);

async function main() {
    const live = has('live');
    if (!live) process.env.PAPER_TRADING = '1'; // master kill-switch: previews only

    const symbol = String(flag('symbol', 'BTCUSDC')).toUpperCase();
    const interval = flag('interval', '4h');
    const account = flag('account', '1');
    const cfg = { ...DEFAULT_CFG, riskPct: Number(flag('risk', DEFAULT_CFG.riskPct)) };
    const mode = live ? 'LIVE' : 'PAPER';

    const binance = await import('../src/core/binance.js');
    const state = loadState();

    // 1. Klines — enough for EMA200 + ADX warmup, drop the in-progress bar.
    const kl = await binance.getKlines({ symbol, interval, limit: 350 });
    const now = Date.now();
    const closed = kl.candles.filter((c) => Number(c.closeTime) <= now).map((c) => ({
        openTime: Number(c.openTime), open: Number(c.open), high: Number(c.high),
        low: Number(c.low), close: Number(c.close), closeTime: Number(c.closeTime),
    }));
    const lastBar = closed[closed.length - 1];
    if (!lastBar) throw new Error('no closed candles returned');
    if (lastBar.openTime <= state.lastProcessedBarTime) {
        console.log(JSON.stringify({ mode, action: 'none', reason: 'no_new_bar', bar: new Date(lastBar.openTime).toISOString() }));
        return;
    }

    // 2. Current position — exchange in live mode, simulated in paper mode.
    let position = null;
    if (live) {
        const posRes = await binance.getPositions({ symbol, account });
        const p = (posRes.positions || []).find((x) => x.symbol === symbol && x.side === 'LONG');
        if (p) position = { qty: Number(p.quantity), adds: state.adds || 1, stop: state.stop, avgPrice: Number(p.entryPrice) };
        else if (state.adds > 0) {
            logLine({ mode, event: 'position_gone', note: 'exchange position closed since last run (stop hit or manual close) — state reset' });
            state.adds = 0; state.stop = null;
        }
    } else {
        position = state.paper.position;
        // simulate resting stop: did any closed bar since last run trade through it?
        if (position && position.stop != null) {
            const newBars = closed.filter((c) => c.openTime > state.lastProcessedBarTime);
            const hit = newBars.find((c) => c.low <= position.stop);
            if (hit) {
                const pnl = (position.stop - position.avgPrice) * position.qty;
                state.paper.equity = (state.paper.equity ?? 10000) + pnl;
                logLine({ mode, event: 'paper_stop_hit', bar: new Date(hit.openTime).toISOString(), stop: position.stop, pnl: round2(pnl), equity: round2(state.paper.equity) });
                position = null;
                state.paper.position = null;
                state.adds = 0; state.stop = null;
            }
        }
    }

    // 3. Decide on the last closed bar.
    const decision = computeDecision({ candles: closed, position, lastEntryTime: state.lastEntryTime, cfg });
    state.lastProcessedBarTime = lastBar.openTime;

    // 4. Act.
    const price = lastBar.close;
    let result = null;
    if (decision.action === 'enter' || decision.action === 'add') {
        let equity;
        if (live) {
            const sum = await binance.getAccountSummary({ account });
            equity = Number(sum.totalMarginBalance);
        } else {
            if (state.paper.equity == null) {
                try {
                    const sum = await binance.getAccountSummary({ account });
                    state.paper.equity = Number(sum.totalMarginBalance);
                } catch { state.paper.equity = 10000; }
            }
            equity = state.paper.equity;
        }
        const atrVal = (price - decision.stop) / cfg.atrStopMult; // back out ATR from the stop distance
        const qty = sizeEntry({ equity, price, atr: atrVal, existingQty: position ? position.qty : 0, cfg });
        if (qty * price < 5) {
            result = { skipped: 'qty below min notional' };
        } else {
            const order = await binance.placeOrder({
                symbol, side: 'BUY', type: 'MARKET', quantity: qty,
                positionSide: 'LONG', allowTaker: true, confirm: true, account,
            });
            result = { order };
            // protective stop: cancel existing closePosition stops, place the new (ratcheted) one
            if (live) {
                const oo = await binance.getOpenOrders({ symbol, account });
                for (const a of (oo.algoOrders || [])) {
                    if (/STOP/.test(a.orderType || a.type || '') && (a.closePosition === true || a.closePosition === 'true')) {
                        await binance.cancelAlgoOrder({ algoId: a.algoId, account });
                    }
                }
                result.stopOrder = await binance.ensureProtectiveStop({ symbol, stop: decision.stop, positionSide: 'LONG', confirm: true, account });
            } else {
                const prev = position || { qty: 0, adds: 0, avgPrice: 0 };
                const newQty = prev.qty + qty;
                const avgPrice = (prev.avgPrice * prev.qty + price * qty) / newQty;
                state.paper.position = { qty: round6(newQty), adds: prev.adds + 1, avgPrice: round2(avgPrice), stop: decision.stop };
                result.paper_fill = { qty: round6(qty), price, stop: decision.stop };
            }
            state.adds = (position ? position.adds : 0) + 1;
            state.stop = decision.stop;
            state.lastEntryTime = lastBar.openTime;
        }
    } else if (decision.action === 'exit' && position) {
        if (live) {
            const order = await binance.placeOrder({
                symbol, side: 'SELL', type: 'MARKET', quantity: position.qty,
                positionSide: 'LONG', allowTaker: true, confirm: true, account,
            });
            const oo = await binance.getOpenOrders({ symbol, account });
            for (const a of (oo.algoOrders || [])) {
                if (/STOP/.test(a.orderType || a.type || '') && (a.closePosition === true || a.closePosition === 'true')) {
                    await binance.cancelAlgoOrder({ algoId: a.algoId, account });
                }
            }
            result = { order };
        } else {
            const pnl = (price - position.avgPrice) * position.qty;
            state.paper.equity = (state.paper.equity ?? 10000) + pnl;
            result = { paper_exit: { price, pnl: round2(pnl), equity: round2(state.paper.equity) } };
            state.paper.position = null;
        }
        state.adds = 0; state.stop = null;
    }

    saveState(state);
    const summary = { mode, symbol, interval, bar: decision.indicators?.barTime, action: decision.action, reason: decision.reason, stop: decision.stop ?? state.stop, indicators: decision.indicators, result };
    logLine(summary);
    console.log(JSON.stringify(summary, null, 2));
}

const round6 = (v) => Math.round(v * 1e6) / 1e6;

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    main().catch((err) => {
        logLine({ event: 'error', error: err.message });
        console.error(JSON.stringify({ error: err.message }));
        process.exitCode = 1;
    });
}
