// Binance core — order placement and management: placeOrder/Bracket/Ladder,
// modify/cancel, protective stops, multi-account mirroring, position sizing.
import {requireFinite} from '../../connection.js';
import {
    futPrefix,
    isAlgoMigrationError,
    isCoinM,
    isFutures,
    isFuturesLike,
    LIMIT_TYPES,
    ORDER_TYPES,
    paperFields,
    resolveDeps,
    resolveMarket,
    signedRequest,
    snap,
    STOP_TYPES,
    TAKER_TYPES,
    toAlgoParams,
    usePaperTrading,
    VALID_TIF,
} from './request.js';
import {getBookTicker, getSymbolInfo} from './market.js';
import {getTechnicals, px} from './analysis.js';
import {getAccountSummary, getBalance, getOpenOrders, getPositionMode, getPositions} from './account.js';

/** Resolve calcPositionSize's stop: either the explicit `stop` price, or an ATR-derived stop
 *  at entry ∓ atrMult·ATR(14) (below entry for a long, above for a short). */
async function resolveSizingStop({market, symbol, entryP, stop, atrMult, side, interval, deps}) {
    if (stop != null) return {stopP: requireFinite(stop, 'stop')};
    if (atrMult == null) throw new Error('pass stop, or atrMult (+side) to derive an ATR-based stop');
    const mult = requireFinite(atrMult, 'atrMult');
    if (!symbol) throw new Error('ATR-based stop needs a symbol to pull candles for');
    const sd = String(side || '').toUpperCase();
    const isLong = ['BUY', 'LONG'].includes(sd);
    const isShort = ['SELL', 'SHORT'].includes(sd);
    if (!isLong && !isShort) throw new Error('ATR-based stop needs side: BUY/LONG or SELL/SHORT');
    const tech = await getTechnicals({market, symbol, interval: interval || '1h', _deps: deps});
    if (tech.atr == null) throw new Error('could not compute ATR (not enough candles) — pass an explicit stop instead');
    const stopP = px(isLong ? entryP - mult * tech.atr : entryP + mult * tech.atr);
    return {stopP, atrInfo: {source: 'ATR', atr: tech.atr, atrMult: mult, interval: interval || '1h'}};
}

/** Resolve the per-trade risk budget ($), plus the balance it was derived from (if any). */
async function resolveRiskBudget({market, account, riskAmount, riskPct, balance, deps}) {
    let bal = balance == null ? undefined : Number(balance);
    if (riskAmount != null) return {risk: requireFinite(riskAmount, 'riskAmount'), bal};
    const pct = requireFinite(riskPct, 'riskPct');
    if (bal == null && isFuturesLike(market)) {
        try {
            bal = Number((await getAccountSummary({market, account, _deps: deps})).totalMarginBalance);
        } catch { /* leave undefined */
        }
    }
    if (bal == null || !Number.isFinite(bal)) throw new Error('riskPct needs a balance — pass balance, or use a futures account so it can be fetched');
    return {risk: bal * (pct / 100), bal};
}

/** Collect sizing warnings: 3x-rule breaches, margin vs balance, minQty floor. */
function sizingWarnings({lev, bal, notional, requiredMargin, info, qty}) {
    const warnings = [];
    if (lev > 3) warnings.push(`leverage ${lev}x exceeds your 3x rule`);
    if (bal != null && notional / bal > 3.0001) warnings.push(`implied account leverage ${(notional / bal).toFixed(2)}x exceeds 3x`);
    if (bal != null && requiredMargin > bal) warnings.push('required margin exceeds balance');
    if (info && Number(info.minQty) && qty < Number(info.minQty)) warnings.push(`quantity ${qty} is below minQty ${info.minQty}`);
    return warnings;
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
    const {stopP, atrInfo} = await resolveSizingStop({market, symbol, entryP, stop, atrMult, side, interval, deps});
    if (entryP === stopP) throw new Error('entry and stop must differ');
    if (riskAmount == null && riskPct == null) throw new Error('pass riskAmount ($) or riskPct (% of balance)');
    const {risk, bal} = await resolveRiskBudget({market, account, riskAmount, riskPct, balance, deps});
    const riskPerUnit = Math.abs(entryP - stopP);
    let qty = risk / riskPerUnit;
    let info;
    if (round && symbol) {
        try {
            info = await getSymbolInfo({market, symbol, _deps: deps});
            qty = snap(qty, info.stepSize, 'floor');
        } catch { /* skip rounding */
        }
    }
    const notional = qty * entryP;
    const requiredMargin = notional / lev;
    const warnings = sizingWarnings({lev, bal, notional, requiredMargin, info, qty});
    return {
        success: true, market, symbol: symbol ? String(symbol).toUpperCase() : undefined,
        side: stopP < entryP ? 'LONG (BUY)' : 'SHORT (SELL)',
        entry: entryP, stop: stopP, leverage: lev,
        riskAmount: Number(risk.toFixed(2)), riskPerUnit: Number(riskPerUnit.toFixed(8)),
        quantity: Number(qty.toFixed(8)), notional: Number(notional.toFixed(2)), requiredMargin: Number(requiredMargin.toFixed(2)),
        balance: bal == null ? undefined : Number(bal.toFixed(2)),
        impliedAccountLeverage: bal == null ? undefined : Number((notional / bal).toFixed(2)),
        atrStop: atrInfo,
        warnings: warnings.length ? warnings : undefined,
    };
}

/** Get a single order by orderId or origClientOrderId */
export async function getOrder({market = 'futures', symbol, orderId, origClientOrderId, account = '1', _deps = {}} = {}) {
    if (!symbol) throw new Error('symbol is required');
    if (orderId === undefined && !origClientOrderId) throw new Error('orderId or origClientOrderId is required');
    const deps = resolveDeps(account, _deps);
    const endpoint = isFuturesLike(market) ? `${futPrefix(market)}/v1/order` : '/api/v3/order';
    const params = {symbol: String(symbol).toUpperCase()};
    if (orderId !== undefined) params.orderId = String(orderId);
    if (origClientOrderId) params.origClientOrderId = String(origClientOrderId);
    const data = await signedRequest({market, endpoint, params, _deps: deps});
    return {success: true, market, order: data};
}

/** Shared symbol/side validation for the order builders. Returns { sym, sd } (the uppercased
 *  symbol and side). Call sites pass their own exact error-message variants so the thrown
 *  text stays byte-identical to the original inline checks. */
function validateOrderInputs({symbol, side, symbolMsg = 'symbol is required', sideMsg = 'side must be "BUY" or "SELL"'}) {
    if (!symbol) throw new Error(symbolMsg);
    const sym = String(symbol).toUpperCase();
    const sd = String(side || '').toUpperCase();
    if (!['BUY', 'SELL'].includes(sd)) throw new Error(sideMsg);
    return {sym, sd};
}

/** Standard dry-run preview envelope shared by the money-moving helpers:
 *  { success:false, dry_run:true, ...extra, message, ...paperFields(paperTrading), ...tail }.
 *  `paperMsg`/`dryMsg` are the two message variants, kept byte-identical per call site. */
function dryRunResponse({paperTrading, paperMsg, dryMsg, extra = {}, tail = {}}) {
    return {
        success: false,
        dry_run: true,
        ...extra,
        message: paperTrading ? paperMsg : dryMsg,
        ...paperFields(paperTrading),
        ...tail,
    };
}

/** Validate placeOrder's symbol/side/type/flag combination. Returns the normalized
 *  {sym, sd, ty} plus the {isStop, futures, coinm} routing facts. */
function validatePlaceOrderInputs({market, symbol, side, type, allowTaker, closePosition}) {
    const {sym, sd} = validateOrderInputs({symbol, side, symbolMsg: 'symbol is required (e.g. "BTCUSDT")'});
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
    return {sym, sd, ty, isStop, futures, coinm};
}

/** LIMIT-family pricing: set price and timeInForce, mapping post-only to GTX on futures
 *  or the distinct LIMIT_MAKER order type on spot. */
function applyLimitPricing({params, ty, futures, price, postOnly, timeInForce}) {
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

/** Assemble the base order params: quantity / closePosition, LIMIT pricing, stop trigger,
 *  client id, and reduceOnly (mutually exclusive with closePosition on Binance). */
function buildOrderParams({sym, sd, ty, isStop, futures, quantity, price, stopPrice, closePosition, reduceOnly, postOnly, timeInForce, newClientOrderId}) {
    const params = {symbol: sym, side: sd, type: ty};
    // Quantity: required unless this is a futures closePosition stop/TP (which closes the whole position).
    if (closePosition) {
        params.closePosition = 'true';
    } else {
        const qty = requireFinite(quantity, 'quantity');
        if (qty <= 0) throw new Error('quantity must be > 0');
        params.quantity = String(qty);
    }
    if (LIMIT_TYPES.includes(ty)) applyLimitPricing({params, ty, futures, price, postOnly, timeInForce});
    if (isStop) {
        params.stopPrice = String(requireFinite(stopPrice, 'stopPrice'));
    }
    if (newClientOrderId) params.newClientOrderId = String(newClientOrderId);
    // reduceOnly and closePosition are mutually exclusive on Binance.
    if (reduceOnly && futures && !closePosition) params.reduceOnly = 'true';
    return params;
}

/** Hedge Mode handling: validate/apply positionSide. On confirm with no positionSide on a
 *  futures order, detect hedge mode and refuse to guess which position to target. */
async function applyPositionSide({params, market, positionSide, futures, confirm, deps}) {
    const ps = positionSide ? String(positionSide).toUpperCase() : null;
    if (ps && !['LONG', 'SHORT', 'BOTH'].includes(ps)) throw new Error('positionSide must be LONG, SHORT, or BOTH');
    if (!futures) return;
    if (!ps && confirm) {
        const mode = await getPositionMode({market, _deps: deps});
        if (mode.hedgeMode) throw new Error('Account is in Hedge Mode — pass positionSide:"LONG" or "SHORT" (CLI --positionSide) so the order targets the right position.');
    }
    if (ps && ps !== 'BOTH') {
        params.positionSide = ps;
        delete params.reduceOnly; // reduceOnly is rejected in hedge mode (positionSide implies it)
    } else if (ps === 'BOTH') {
        params.positionSide = 'BOTH';
    }
}

/** Snap price/stopPrice/quantity to the symbol's tick/step so the order isn't rejected.
 *  Returns {contractSize} on success; on filter-load failure throws when confirming
 *  (the live order would risk rejection) or returns a {rounding_note} on a dry run. */
async function roundOrderParams({params, market, sym, confirm, deps}) {
    try {
        const info = await getSymbolInfo({market, symbol: sym, _deps: deps});
        if (params.price !== undefined) params.price = String(snap(params.price, info.tickSize, 'round'));
        if (params.stopPrice !== undefined) params.stopPrice = String(snap(params.stopPrice, info.tickSize, 'round'));
        if (params.quantity !== undefined) params.quantity = String(snap(params.quantity, info.stepSize, 'floor'));
        return {contractSize: info.contractSize};
    } catch (err) {
        if (confirm) throw new Error(`Could not load symbol filters to round price/qty (${err.message}). Pass round:false to place without rounding.`);
        return {rounding_note: `precision rounding skipped — filters unavailable (${err.message})`};
    }
}

/** COIN-M sizes orders in CONTRACTS (fixed USD notional each), not coin amount — surface that. */
function coinmQuantityNote(coinm, contractSize) {
    if (!coinm) return undefined;
    const sizeNote = contractSize ? ` (1 contract = ${contractSize} USD)` : ' (see symbol-info contractSize)';
    return `COIN-M: quantity is in CONTRACTS, not coin amount${sizeNote}.`;
}

/** Route the order to the right endpoint. USD-M migrated conditional orders (STOP/TP/TRAILING)
 *  to the Algo endpoint (2025-12-09): they POST to /fapi/v1/algoOrder with algoType=CONDITIONAL
 *  and `triggerPrice` (not stopPrice). COIN-M (dapi) is intentionally NOT routed here — Binance
 *  has not migrated it (verified 2026-06); the -4120 fallback on send self-heals if that changes. */
function resolveOrderEndpoint({params, market, isStop, futures}) {
    if (isStop && isFutures(market)) {
        Object.assign(params, toAlgoParams(params));
        delete params.stopPrice;
        delete params.newClientOrderId;
        return {endpoint: `${futPrefix(market)}/v1/algoOrder`, useAlgo: true};
    }
    return {endpoint: futures ? `${futPrefix(market)}/v1/order` : '/api/v3/order', useAlgo: false};
}

/** POST the order; self-heal if Binance migrates COIN-M conditionals to the Algo service
 *  like USD-M (the -4120 rejection retries on the Algo endpoint). */
async function sendOrderWithAlgoFallback({market, account, endpoint, params, isStop, useAlgo, isLive, deps}) {
    try {
        const data = await signedRequest({market, method: 'POST', endpoint, params, _deps: deps});
        return {success: true, market, account, live_funds: isLive, algo: useAlgo, order: data};
    } catch (err) {
        if (isStop && isCoinM(market) && isAlgoMigrationError(err)) {
            const data = await signedRequest({
                market, method: 'POST', endpoint: `${futPrefix(market)}/v1/algoOrder`,
                params: toAlgoParams(params), _deps: deps,
            });
            return {success: true, market, account, live_funds: isLive, algo: true, algo_fallback: true, order: data};
        }
        throw err;
    }
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
    const paperTrading = usePaperTrading(_deps);
    if (paperTrading) confirm = false; // global kill-switch
    const {sym, sd, ty, isStop, futures, coinm} = validatePlaceOrderInputs({market, symbol, side, type, allowTaker, closePosition});
    const params = buildOrderParams({
        sym,
        sd,
        ty,
        isStop,
        futures,
        quantity,
        price,
        stopPrice,
        closePosition,
        reduceOnly,
        postOnly,
        timeInForce,
        newClientOrderId
    });

    // Hedge Mode: orders must carry positionSide (LONG/SHORT) and cannot use reduceOnly.
    await applyPositionSide({params, market, positionSide, futures, confirm, deps});

    const {rounding_note, contractSize} = round ? await roundOrderParams({params, market, sym, confirm, deps}) : {};
    const coinm_note = coinmQuantityNote(coinm, contractSize);
    const {endpoint, useAlgo} = resolveOrderEndpoint({params, market, isStop, futures});

    const isLive = !resolveMarket(market, deps).includes('testnet');
    const preview = {market, endpoint, ...params, live_funds: isLive};

    if (!confirm) {
        const env = isLive ? 'LIVE (real funds)' : 'TESTNET';
        const kind = useAlgo ? 'conditional (algo) order' : 'order';
        return dryRunResponse({
            paperTrading,
            paperMsg: `PAPER TRADING — would place a ${env} ${kind}; decision logged, nothing sent.`,
            dryMsg: `DRY RUN — no order sent. Pass confirm:true to place this ${env} ${kind}.`,
            extra: {account},
            tail: {
                ...(coinm_note ? {coinm_note} : {}),
                ...(rounding_note ? {rounding_note} : {}),
                order_preview: preview,
            },
        });
    }

    return sendOrderWithAlgoFallback({market, account, endpoint, params, isStop, useAlgo, isLive, deps});
}

/** Cancel an open order by orderId.
 *  INTENTIONALLY not gated by confirm/paper-trading: cancelling cannot open exposure or
 *  spend funds, and a kill-switch must always be able to pull live orders. */
export async function cancelOrder({market = 'futures', symbol, orderId, origClientOrderId, account = '1', _deps = {}} = {}) {
    if (!symbol) throw new Error('symbol is required');
    if (orderId === undefined && !origClientOrderId) throw new Error('orderId or origClientOrderId is required');
    const deps = resolveDeps(account, _deps);
    const endpoint = isFuturesLike(market) ? `${futPrefix(market)}/v1/order` : '/api/v3/order';
    const params = {symbol: String(symbol).toUpperCase()};
    if (orderId !== undefined) params.orderId = String(orderId);
    if (origClientOrderId) params.origClientOrderId = String(origClientOrderId);
    const data = await signedRequest({market, method: 'DELETE', endpoint, params, _deps: deps});
    return {success: true, market, canceled: data};
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
    const paperTrading = usePaperTrading(_deps);
    if (paperTrading) confirm = false; // global kill-switch
    const params = {symbol: String(symbol).toUpperCase(), side: sd};
    if (orderId !== undefined) params.orderId = String(orderId);
    if (origClientOrderId) params.origClientOrderId = String(origClientOrderId);
    params.quantity = String(requireFinite(quantity, 'quantity'));
    params.price = String(requireFinite(price, 'price'));
    if (round) {
        try {
            const info = await getSymbolInfo({market, symbol: params.symbol, _deps: deps});
            params.price = String(snap(params.price, info.tickSize, 'round'));
            params.quantity = String(snap(params.quantity, info.stepSize, 'floor'));
        } catch (err) {
            if (confirm) throw new Error(`Could not load symbol filters to round price/qty (${err.message}). Pass round:false to modify without rounding.`);
        }
    }
    const endpoint = `${futPrefix(market)}/v1/order`;
    if (!confirm) {
        return dryRunResponse({
            paperTrading,
            paperMsg: 'PAPER TRADING — would amend this LIVE order; decision logged, nothing sent.',
            dryMsg: 'DRY RUN — no modify sent. Pass confirm:true to amend this LIVE order.',
            tail: {modify_preview: {market, endpoint, ...params}},
        });
    }
    const data = await signedRequest({market, method: 'PUT', endpoint, params, _deps: deps});
    return {success: true, market, modified: data};
}

/** Cancel a conditional (algo) order by algoId — USD-M futures, post-2025-12-09 migration.
 *  Like cancelOrder, INTENTIONALLY not gated by confirm/paper-trading (cancels are always safe). */
export async function cancelAlgoOrder({market = 'futures', algoId, account = '1', _deps = {}} = {}) {
    if (!isFutures(market)) throw new Error('algo orders are USD-M futures only');
    if (algoId === undefined) throw new Error('algoId is required');
    const deps = resolveDeps(account, _deps);
    const data = await signedRequest({market, method: 'DELETE', endpoint: `${futPrefix(market)}/v1/algoOrder`, params: {algoId: String(algoId)}, _deps: deps});
    return {success: true, market, canceled: data};
}

/** All orders for a symbol (signed): open, filled, and cancelled — not just resting ones. */
export async function getOrderHistory({market = 'futures', symbol, orderId, startTime, endTime, limit = 500, account = '1', _deps = {}} = {}) {
    if (!symbol) throw new Error('symbol is required');
    const sym = String(symbol).toUpperCase();
    const deps = resolveDeps(account, _deps);
    const params = {symbol: sym};
    if (orderId !== undefined) params.orderId = String(orderId);
    if (startTime !== undefined) params.startTime = String(requireFinite(startTime, 'startTime'));
    if (endTime !== undefined) params.endTime = String(requireFinite(endTime, 'endTime'));
    params.limit = String(Math.max(1, Math.min(Number(limit) || 500, 1000)));
    const endpoint = isFuturesLike(market) ? `${futPrefix(market)}/v1/allOrders` : '/api/v3/allOrders';
    const data = await signedRequest({market, endpoint, params, _deps: deps});
    return {success: true, market, symbol: sym, count: data.length, orders: data};
}

/** Normalize takeProfits into {price, quantity} legs; with multiple TPs each needs a quantity. */
function normalizeTakeProfits(takeProfits) {
    const tps = (takeProfits || []).map((tp, i) => ({
        price: requireFinite(tp.price ?? tp, `takeProfits[${i}].price`),
        quantity: tp.quantity === undefined ? undefined : requireFinite(tp.quantity, `takeProfits[${i}].quantity`),
    }));
    if (tps.length > 1 && tps.some((tp) => tp.quantity === undefined)) {
        throw new Error('with multiple take-profits, each must have its own quantity (closePosition would close the whole position on the first fill)');
    }
    return tps;
}

/** Build the bracket's legs: optional entry, optional closePosition stop, and TP legs
 *  (per-TP quantity → reduceOnly; no quantity → closePosition). */
function buildBracketLegs({sym, sd, exit, qty, includeEntry, entryType, entryPrice, postOnly, stopPrice, tps}) {
    const legs = [];
    if (includeEntry) {
        const ety = String(entryType).toUpperCase();
        if (!['MARKET', 'LIMIT'].includes(ety)) throw new Error('entryType must be MARKET or LIMIT');
        const entry = {leg: 'entry', symbol: sym, side: sd, type: ety, quantity: String(qty)};
        if (ety === 'LIMIT') {
            entry.price = String(requireFinite(entryPrice, 'entryPrice'));
            entry.timeInForce = postOnly ? 'GTX' : 'GTC'; // GTX = post-only (maker-only)
        }
        // A MARKET entry is taker — gated by the allowTaker check in placeBracket.
        legs.push(entry);
    }
    if (stopPrice !== undefined && stopPrice !== null) {
        legs.push({leg: 'stop', symbol: sym, side: exit, type: 'STOP_MARKET', stopPrice: String(requireFinite(stopPrice, 'stopPrice')), closePosition: 'true'});
    }
    tps.forEach((tp, i) => {
        const o = {leg: `tp${i + 1}`, symbol: sym, side: exit, type: 'TAKE_PROFIT_MARKET', stopPrice: String(tp.price)};
        if (tp.quantity === undefined) {
            o.closePosition = 'true';
        } else {
            o.quantity = String(tp.quantity);
            o.reduceOnly = 'true';
        }
        legs.push(o);
    });
    if (legs.length === 0) throw new Error('nothing to place: provide entry, stopPrice, and/or takeProfits');
    return legs;
}

/** Refuse taker legs unless explicitly allowed (post-only by default). */
function assertBracketMakerOnly(legs, allowTaker) {
    const takerLegs = legs.filter((l) => TAKER_TYPES.includes(l.type));
    if (takerLegs.length && !allowTaker) {
        throw new Error(`This bracket has taker-only legs (${takerLegs.map((l) => l.leg).join(', ')}) — stops and market take-profits (and a MARKET entry) cross the book and cannot be post-only. Pass allowTaker:true (CLI --allowTaker) to place them and accept taker fees on those legs.`);
    }
}

/** Hedge Mode: every leg carries positionSide (from the position direction) and drops
 *  reduceOnly. With `hedge` unset on confirm, the account's position mode is detected. */
async function applyBracketHedgeMode({legs, market, sd, hedge, confirm, deps}) {
    let hedgeMode = hedge;
    if (hedgeMode === undefined && confirm) {
        hedgeMode = (await getPositionMode({market, _deps: deps})).hedgeMode;
    }
    if (hedgeMode) {
        const posSide = sd === 'BUY' ? 'LONG' : 'SHORT';
        for (const leg of legs) {
            leg.positionSide = posSide;
            delete leg.reduceOnly; // rejected in hedge mode (positionSide implies close intent)
        }
    }
    return hedgeMode;
}

/** Snap every leg's price/stopPrice/quantity to the symbol's tick/step. Returns a rounding
 *  note when filters are unavailable on a dry run; throws when confirming. */
async function roundBracketLegs({legs, market, sym, confirm, deps}) {
    try {
        const info = await getSymbolInfo({market, symbol: sym, _deps: deps});
        for (const leg of legs) {
            if (leg.price !== undefined) leg.price = String(snap(leg.price, info.tickSize, 'round'));
            if (leg.stopPrice !== undefined) leg.stopPrice = String(snap(leg.stopPrice, info.tickSize, 'round'));
            if (leg.quantity !== undefined) leg.quantity = String(snap(leg.quantity, info.stepSize, 'floor'));
        }
        return undefined;
    } catch (err) {
        if (confirm) throw new Error(`Could not load symbol filters to round bracket legs (${err.message}). Pass round:false to place without rounding.`);
        return `precision rounding skipped — filters unavailable (${err.message})`;
    }
}

/** Place one bracket leg. Conditional legs (stop / TP-market) route to the Algo endpoint on
 *  USD-M (post-2025-12-09); COIN-M legs stay on /dapi/v1/order (not migrated as of 2026-06)
 *  with the -4120 fallback to self-heal. Never throws — returns a per-leg success/error
 *  record so the caller sees the full picture. */
async function placeBracketLeg({market, name, rawParams, deps}) {
    const isStopLeg = STOP_TYPES.includes(rawParams.type);
    const useAlgo = isStopLeg && isFutures(market);
    const endpoint = useAlgo ? `${futPrefix(market)}/v1/algoOrder` : `${futPrefix(market)}/v1/order`;
    const params = useAlgo ? toAlgoParams(rawParams) : rawParams;
    try {
        const data = await signedRequest({market, method: 'POST', endpoint, params, _deps: deps});
        return {leg: name, success: true, orderId: data.orderId ?? data.algoId, algo: useAlgo, params};
    } catch (err) {
        if (isStopLeg && isCoinM(market) && isAlgoMigrationError(err)) {
            try {
                const data = await signedRequest({
                    market, method: 'POST', endpoint: `${futPrefix(market)}/v1/algoOrder`,
                    params: toAlgoParams(rawParams), _deps: deps,
                });
                return {leg: name, success: true, orderId: data.orderId ?? data.algoId, algo: true, algo_fallback: true, params};
            } catch (err_) {
                return {leg: name, success: false, error: err_.message, params};
            }
        }
        return {leg: name, success: false, error: err.message, params};
    }
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
    const paperTrading = usePaperTrading(_deps);
    if (paperTrading) confirm = false; // global kill-switch
    if (!isFuturesLike(market)) throw new Error('placeBracket supports USD-M and COIN-M futures only');
    const {sym, sd} = validateOrderInputs({symbol, side, sideMsg: 'side must be BUY (long) or SELL (short)'});
    const exit = sd === 'BUY' ? 'SELL' : 'BUY'; // closing side for stop/TP
    const qty = requireFinite(quantity, 'quantity');
    if (qty <= 0) throw new Error('quantity must be > 0');

    const tps = normalizeTakeProfits(takeProfits);
    const legs = buildBracketLegs({sym, sd, exit, qty, includeEntry, entryType, entryPrice, postOnly, stopPrice, tps});
    assertBracketMakerOnly(legs, allowTaker);
    const hedgeMode = await applyBracketHedgeMode({legs, market, sd, hedge, confirm, deps});
    const rounding_note = round ? await roundBracketLegs({legs, market, sym, confirm, deps}) : undefined;

    const isLive = !resolveMarket(market, deps).includes('testnet');
    if (!confirm) {
        const env = isLive ? 'LIVE (real funds)' : 'TESTNET';
        const legNames = legs.map((l) => l.leg).join(', ');
        return dryRunResponse({
            paperTrading,
            paperMsg: `PAPER TRADING — would place this ${env} bracket (${legs.length} legs: ${legNames}); decision logged, nothing sent.`,
            dryMsg: `DRY RUN — ${legs.length} legs (${legNames}). Pass confirm:true to place this ${env} bracket.`,
            extra: {market, account, live_funds: isLive, hedgeMode: !!hedgeMode},
            tail: {
                ...(rounding_note ? {rounding_note} : {}),
                legs,
            },
        });
    }

    const results = [];
    for (const {leg: name, ...rawParams} of legs) {
        results.push(await placeBracketLeg({market, name, rawParams, deps}));
    }
    const placed = results.filter((r) => r.success).length;
    return {success: results.every((r) => r.success), market, account, live_funds: isLive, placed, total: results.length, legs: results};
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
async function planMirrorSizing({accounts, marginAsset, market, symbol, baseQty, _deps}) {
    const balances = {};
    for (const acct of accounts) {
        const bal = await getBalance({market, account: acct, _deps});
        balances[acct] = balanceFor(bal, marginAsset);
    }
    const base = accounts[0];
    const baseBal = balances[base];
    if (!baseBal) throw new Error(`Base account "${base}" has no ${marginAsset} balance to size the mirror ratio from.`);

    // Trading filters are exchange-wide (account-independent) — fetch once to snap/min-check.
    let info = null;
    try {
        info = await getSymbolInfo({market, symbol, _deps});
    } catch { /* leave unsnapped; placeOrder will still try */
    }

    return accounts.map((acct) => {
        const factor = acct === base ? 1 : balances[acct] / baseBal;
        let quantity = baseQty * factor;
        let belowMin = false;
        if (info) {
            quantity = snap(quantity, info.stepSize, 'floor');
            const minQty = Number(info.minQty) || 0;
            if (quantity <= 0 || (minQty && quantity < minQty)) belowMin = true;
        }
        return {account: acct, balance: balances[acct], factor: Number(factor.toFixed(6)), quantity, ...(belowMin ? {belowMin: true} : {})};
    });
}

/** Submit up to 5 orders per request via the futures batchOrders endpoint.
 *  Returns a flat array of per-order results (each an order object or a {code,msg} error). */
async function batchPlaceOrders({market, orders, deps}) {
    const results = [];
    for (let i = 0; i < orders.length; i += 5) {
        const chunk = orders.slice(i, i + 5);
        const data = await signedRequest({
            market, method: 'POST', endpoint: `${futPrefix(market)}/v1/batchOrders`,
            params: {batchOrders: JSON.stringify(chunk)}, _deps: deps,
        });
        for (const r of (Array.isArray(data) ? data : [data])) results.push(r);
    }
    return results;
}

/** Hedge-mode positionSide resolution for the ladder (mirrors placeOrder). */
async function resolveLadderPositionSide({market, account, positionSide, confirm, deps}) {
    const ps = positionSide ? String(positionSide).toUpperCase() : null;
    if (ps && !['LONG', 'SHORT', 'BOTH'].includes(ps)) throw new Error('positionSide must be LONG, SHORT, or BOTH');
    if (!ps && confirm) {
        const mode = await getPositionMode({market, account, _deps: deps});
        if (mode.hedgeMode) throw new Error('Account is in Hedge Mode — pass positionSide:"LONG" or "SHORT".');
    }
    return ps;
}

/** Resolve a "min" seedQuantity to the smallest valid position for this symbol (LOT_SIZE minQty
 *  AND MIN_NOTIONAL), so set-and-forget ladders can rest a closePosition stop without
 *  over-seeding. Snaps the notional-implied qty UP (never under-fill the min-notional).
 *  Any other seedQuantity value passes through unchanged. */
async function resolveSeedQuantity({seedQuantity, market, sym, info, lowP, deps}) {
    if (typeof seedQuantity !== 'string' || seedQuantity.trim().toLowerCase() !== 'min') return seedQuantity;
    const si = info || await getSymbolInfo({market, symbol: sym, _deps: deps});
    const mq = Number(si.minQty) || 0;
    const mn = Number(si.minNotional) || 0;
    const stp = Number(si.stepSize) || mq || 0;
    let refPx = lowP; // conservative fallback: notional is qty×fillPrice, lower price ⇒ more qty needed
    try {
        const bt = await getBookTicker({market, symbol: sym, _deps: deps});
        refPx = Number(bt.bidPrice) || Number(bt.askPrice) || lowP; // SELL seed fills near bid
    } catch { /* ticker unavailable — fall back to lowP */
    }
    const byNotional = mn > 0 && refPx > 0 ? snap(mn / refPx, stp, 'ceil') : 0;
    const seedQty = Math.max(mq, byNotional);
    // NaN-safe form of !(seedQty > 0): a NaN seed (broken filters) must also be rejected.
    if (Number.isNaN(seedQty) || seedQty <= 0) throw new Error('could not resolve a "min" seed — symbol filters unavailable; pass an explicit seedQuantity');
    return seedQty;
}

/** Build the ladder's rungs: prices evenly spaced across [lowP, highP] (snapped to tick),
 *  per-rung qty from the notional or quantity split (snapped to step), dropping rungs
 *  that floor below minQty. */
function buildLadderRungs({n, lowP, step, perQty, perNotional, info, minQty}) {
    const rungs = [];
    let skipped = 0;
    for (let i = 0; i < n; i++) {
        let price = n > 1 ? lowP + step * i : lowP;
        let qty = perQty == null ? perNotional / price : perQty;
        if (info) {
            price = snap(price, info.tickSize, 'round');
            qty = snap(qty, info.stepSize, 'floor');
        }
        if (minQty && qty < minQty) {
            skipped++;
            continue;
        }
        rungs.push({price, qty});
    }
    if (!rungs.length) throw new Error('no valid rungs — every rung floored below minQty; raise totalNotional or lower count');
    return {rungs, skipped};
}

/** Best-effort 3x-rule guard: compare the ladder's total notional to account equity. */
async function ladderLeverageGuard({market, account, totNotional, deps}) {
    let impliedAccountLeverage;
    const warnings = [];
    try {
        const eq = Number((await getAccountSummary({market, account, _deps: deps})).totalMarginBalance);
        if (Number.isFinite(eq) && eq > 0) {
            impliedAccountLeverage = Number((totNotional / eq).toFixed(2));
            if (impliedAccountLeverage > 3.0001) warnings.push(`implied account leverage ${impliedAccountLeverage}x exceeds your 3x rule ($${totNotional.toFixed(0)} notional vs $${eq.toFixed(0)} equity)`);
        }
    } catch { /* equity unavailable — skip the guard */
    }
    return {impliedAccountLeverage, warnings};
}

/** Assemble the ladder plan: totals, range, per-order sizing, seed/stop summary, warnings.
 *  Shown verbatim in the dry-run preview and reused for the confirm-path totals. */
function buildLadderPlan({
                             market,
                             sym,
                             account,
                             sd,
                             ps,
                             rungs,
                             lowP,
                             highP,
                             perNotional,
                             perQty,
                             postOnly,
                             seedQty,
                             stop,
                             totQty,
                             totNotional,
                             impliedAccountLeverage,
                             skipped,
                             warnings
                         }) {
    const avgPrice = totNotional / totQty;
    return {
        market, symbol: sym, account, side: sd, positionSide: ps || undefined,
        rungs: rungs.length, range: {lo: lowP, hi: highP},
        perOrder: perNotional == null ? `${perQty} ${sym}` : `~$${perNotional.toFixed(2)}`,
        totalQuantity: Number(totQty.toFixed(8)), totalNotional: Number(totNotional.toFixed(2)),
        avgPrice: Number(avgPrice.toFixed(2)), impliedAccountLeverage, skippedBelowMin: skipped,
        timeInForce: postOnly ? 'GTX (post-only)' : 'GTC',
        seed: seedQty ? {type: 'MARKET', quantity: seedQty} : undefined,
        stop: stop == null ? undefined : {type: 'STOP_MARKET', closePosition: true, triggerPrice: stop},
        ...(warnings.length ? {warnings} : {}),
    };
}

/** Confirm path: 1) optional MARKET seed (opens the position so a stop has something to
 *  guard), 2) optional protective closePosition stop, 3) the rungs via batchOrders
 *  (5/request). Returns the raw per-step results for the response builder. */
async function executeLadder({market, sym, sd, ps, rungs, seedQty, stop, postOnly, round, account, deps}) {
    // 1) optional seed market order — opens the position so a stop has something to guard.
    let seedResult;
    if (seedQty) {
        seedResult = await placeOrder({
            market,
            symbol: sym,
            side: sd,
            type: 'MARKET',
            quantity: seedQty,
            positionSide: ps || undefined,
            allowTaker: true,
            round,
            account,
            confirm: true,
            _deps: deps
        });
    }
    // 2) optional protective closePosition stop.
    let stopResult;
    if (stop != null) {
        const closeSide = sd === 'BUY' ? 'SELL' : 'BUY';
        stopResult = await placeOrder({
            market,
            symbol: sym,
            side: closeSide,
            type: 'STOP_MARKET',
            stopPrice: stop,
            closePosition: true,
            positionSide: ps || undefined,
            allowTaker: true,
            round,
            account,
            confirm: true,
            _deps: deps
        });
    }
    // 3) the rungs, batched 5/request.
    const orderObjs = rungs.map((r) => {
        const o = {symbol: sym, side: sd, type: 'LIMIT', quantity: String(r.qty), price: String(r.price), timeInForce: postOnly ? 'GTX' : 'GTC'};
        if (ps) o.positionSide = ps;
        return o;
    });
    const rungResults = await batchPlaceOrders({market, orders: orderObjs, deps});
    const placed = rungResults.filter((r) => r && (r.orderId || r.clientOrderId)).length;
    const errors = rungResults.filter((r) => r && typeof r.code === 'number' && r.code < 0).map((r) => r.msg);
    return {seedResult, stopResult, placed, errors};
}

/** Assemble the confirm-path response from the plan totals and execution results. */
function buildLadderResult({market, sym, account, sd, ps, rungs, plan, warnings, seedResult, stopResult, placed, errors}) {
    return {
        success: true, market, symbol: sym, account, side: sd, positionSide: ps || undefined,
        placed, requested: rungs.length, failed: rungs.length - placed,
        totalQuantity: plan.totalQuantity, totalNotional: plan.totalNotional, avgPrice: plan.avgPrice,
        impliedAccountLeverage: plan.impliedAccountLeverage,
        seed: seedResult ? {orderId: seedResult.order?.orderId, status: seedResult.order?.status} : undefined,
        stop: stopResult ? {algoId: stopResult.order?.algoId, orderId: stopResult.order?.orderId} : undefined,
        errors: errors.length ? [...new Set(errors)].slice(0, 5) : undefined,
        ...(warnings.length ? {warnings} : {}),
    };
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
    const {sym, sd} = validateOrderInputs({symbol, side});
    const loN = requireFinite(lo, 'lo'), hiN = requireFinite(hi, 'hi');
    const n = Math.trunc(requireFinite(count, 'count'));
    if (n < 1) throw new Error('count must be >= 1');
    if ((totalNotional == null) === (totalQuantity == null)) throw new Error('pass exactly one of totalNotional or totalQuantity');
    const deps = resolveDeps(account, _deps);
    const paperTrading = usePaperTrading(_deps);
    if (paperTrading) confirm = false; // global kill-switch
    const lowP = Math.min(loN, hiN), highP = Math.max(loN, hiN);

    const ps = await resolveLadderPositionSide({market, account, positionSide, confirm, deps});

    const info = round ? await getSymbolInfo({market, symbol: sym, _deps: deps}) : null;
    const minQty = info ? Number(info.minQty) : 0;
    const step = n > 1 ? (highP - lowP) / (n - 1) : 0;
    const perNotional = totalNotional == null ? null : Number(totalNotional) / n;
    const perQty = totalQuantity == null ? null : Number(totalQuantity) / n;

    const seedQty = await resolveSeedQuantity({seedQuantity, market, sym, info, lowP, deps});
    const {rungs, skipped} = buildLadderRungs({n, lowP, step, perQty, perNotional, info, minQty});

    const totQty = rungs.reduce((s, r) => s + r.qty, 0);
    const totNotional = rungs.reduce((s, r) => s + r.qty * r.price, 0);
    const {impliedAccountLeverage, warnings} = await ladderLeverageGuard({market, account, totNotional, deps});
    const plan = buildLadderPlan({
        market,
        sym,
        account,
        sd,
        ps,
        rungs,
        lowP,
        highP,
        perNotional,
        perQty,
        postOnly,
        seedQty,
        stop,
        totQty,
        totNotional,
        impliedAccountLeverage,
        skipped,
        warnings
    });

    const seedNote = seedQty ? ` + seed (${seedQty})` : '';
    const stopNote = stop == null ? '' : ' + stop';
    const sampleRungs = [...rungs.slice(0, 3), ...(rungs.length > 3 ? [rungs.at(-1)] : [])];
    if (!confirm) {
        return dryRunResponse({
            paperTrading,
            paperMsg: `PAPER TRADING — would place ${rungs.length} ladder rungs${seedNote}${stopNote}; decision logged, nothing sent.`,
            dryMsg: `DRY RUN — no orders sent. Pass confirm:true to place ${rungs.length} ladder rungs${seedNote}${stopNote} (LIVE real funds).`,
            tail: {
                ladder_preview: plan,
                sample_rungs: sampleRungs,
            },
        });
    }

    const {seedResult, stopResult, placed, errors} = await executeLadder({market, sym, sd, ps, rungs, seedQty, stop, postOnly, round, account, deps});
    return buildLadderResult({market, sym, account, sd, ps, rungs, plan, warnings, seedResult, stopResult, placed, errors});
}

/**
 * Idempotently ensure a protective closePosition stop exists for an open futures position.
 * If a closePosition STOP order is already resting, does nothing. Otherwise (and if a position
 * exists) places a STOP_MARKET closePosition at `stop`. DRY-RUN unless confirm:true.
 */
export async function ensureProtectiveStop({market = 'futures', symbol, stop, positionSide, account = '1', confirm = false, _deps = {}} = {}) {
    if (!isFuturesLike(market)) throw new Error('ensureProtectiveStop is futures-only');
    if (!symbol) throw new Error('symbol is required');
    const trigger = requireFinite(stop, 'stop');
    const deps = resolveDeps(account, _deps);
    const paperTrading = usePaperTrading(_deps);
    if (paperTrading) confirm = false; // global kill-switch
    const sym = String(symbol).toUpperCase();
    const oo = await getOpenOrders({market, symbol: sym, account, _deps: deps});
    const isClosePosStop = (o) => /STOP/.test(o.orderType || o.type || '') && (o.closePosition === true || o.closePosition === 'true');
    const existing = [...(oo.algoOrders || []), ...(oo.orders || [])].filter(isClosePosStop);
    if (existing.length) {
        return {
            success: true,
            market,
            symbol: sym,
            account,
            action: 'none',
            exists: true,
            stops: existing.map((s) => ({id: s.algoId || s.orderId, trigger: s.triggerPrice || s.stopPrice, positionSide: s.positionSide}))
        };
    }
    const posRes = await getPositions({market, symbol: sym, account, _deps: deps});
    const pos = (posRes.positions || []).find((p) => p.symbol === sym);
    if (!pos) {
        return {
            success: false,
            market,
            symbol: sym,
            account,
            action: 'none',
            exists: false,
            warning: 'no open position to protect and no existing stop — nothing placed'
        };
    }
    const ps = positionSide ? String(positionSide).toUpperCase() : pos.side;
    const closeSide = pos.side === 'LONG' ? 'SELL' : 'BUY';
    if (!confirm) {
        return dryRunResponse({
            paperTrading,
            paperMsg: `PAPER TRADING — the ${pos.side} ${sym} position has NO protective stop; would place a closePosition STOP_MARKET @ ${trigger}; decision logged, nothing sent.`,
            dryMsg: `DRY RUN — the ${pos.side} ${sym} position has NO protective stop. Pass confirm:true to place a closePosition STOP_MARKET @ ${trigger}.`,
            extra: {market, symbol: sym, account, action: 'would_place', exists: false},
            tail: {stop_preview: {side: closeSide, type: 'STOP_MARKET', closePosition: true, triggerPrice: trigger, positionSide: ps}},
        });
    }
    const placed = await placeOrder({
        market,
        symbol: sym,
        side: closeSide,
        type: 'STOP_MARKET',
        stopPrice: trigger,
        closePosition: true,
        positionSide: ps,
        allowTaker: true,
        account,
        confirm: true,
        _deps: deps
    });
    return {
        success: true,
        market,
        symbol: sym,
        account,
        action: 'placed',
        exists: false,
        stop: {algoId: placed.order?.algoId, orderId: placed.order?.orderId, trigger}
    };
}

/** Shared mirror fan-out loop: walk the sizing plan in order, placing via `placeFn` per
 *  account. The base account goes first; if it fails (or floors below minQty) every
 *  remaining mirror is skipped so you never hold only a mirrored position. */
async function runMirrorFanOut({sizing, base, symbol, confirm, skipNoun, placeFn}) {
    const results = [];
    let baseFailed = false;
    for (const s of sizing) {
        const isBase = s.account === base;
        if (baseFailed) {
            results.push({...s, skipped: `base ${skipNoun} failed — mirror not placed`});
            continue;
        }
        if (s.belowMin) {
            results.push({...s, skipped: `scaled quantity ${s.quantity} below minQty for ${symbol} — not placed on account ${s.account}`});
            if (isBase) baseFailed = true;
            continue;
        }
        let result;
        try {
            result = await placeFn(s);
        } catch (err) {
            result = {success: false, error: err.message};
        }
        results.push({...s, result});
        if (isBase && confirm && result.success === false) baseFailed = true;
    }
    return results;
}

/** Shared mirror result envelope: success only when the base placed and nothing failed. */
function buildMirrorResult({results, base, marginAsset, market, confirm, paperTrading}) {
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
    const paperTrading = usePaperTrading(_deps);
    if (paperTrading) confirm = false; // global kill-switch (delegated placeOrder is also gated)
    const baseQty = requireFinite(quantity, 'quantity');
    if (baseQty <= 0) throw new Error('quantity must be > 0');

    const sizing = await planMirrorSizing({accounts, marginAsset, market, symbol, baseQty, _deps});
    const base = accounts[0];
    const results = await runMirrorFanOut({
        sizing, base, symbol, confirm, skipNoun: 'order',
        placeFn: (s) => placeOrder({...orderArgs, market, symbol, quantity: s.quantity, account: s.account, confirm, _deps}),
    });
    return buildMirrorResult({results, base, marginAsset, market, confirm, paperTrading});
}

/** Scale per-TP quantities by the mirror factor, snapped to the step size. */
function scaleTakeProfits({takeProfits, factor, info}) {
    return (takeProfits || []).map((tp) => {
        const price = (tp && tp.price !== undefined) ? tp.price : tp;
        if (tp && tp.quantity !== undefined) {
            let q = Number(tp.quantity) * factor;
            if (info) q = snap(q, info.stepSize, 'floor');
            return {price, quantity: q};
        }
        return {price};
    });
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
    const paperTrading = usePaperTrading(_deps);
    if (paperTrading) confirm = false; // global kill-switch (delegated placeBracket is also gated)
    const baseQty = requireFinite(quantity, 'quantity');
    if (baseQty <= 0) throw new Error('quantity must be > 0');

    const sizing = await planMirrorSizing({accounts, marginAsset, market, symbol, baseQty, _deps});
    const base = accounts[0];
    let info = null;
    try {
        info = await getSymbolInfo({market, symbol, _deps});
    } catch { /* placeBracket will still snap */
    }

    const results = await runMirrorFanOut({
        sizing, base, symbol, confirm, skipNoun: 'bracket',
        placeFn: (s) => placeBracket({
            ...bracketArgs, market, symbol, quantity: s.quantity,
            takeProfits: scaleTakeProfits({takeProfits, factor: s.factor, info}),
            account: s.account, confirm, _deps,
        }),
    });
    return buildMirrorResult({results, base, marginAsset, market, confirm, paperTrading});
}

/** Clear conditional (algo) orders for a symbol — they're a separate service since 2025-12-09.
 *  USD-M only: COIN-M (dapi) has no Algo service as of 2026-06 (its stops are plain orders).
 *  Best-effort: individual cancel failures are skipped. Returns the cancel count. */
async function cancelOpenAlgoOrders({market, sym, deps}) {
    let algoCanceled = 0;
    try {
        const a = await signedRequest({market, endpoint: `${futPrefix(market)}/v1/openAlgoOrders`, params: {symbol: sym}, _deps: deps});
        const arr = Array.isArray(a) ? a : (a.orders || a.algoOrders || []);
        for (const o of arr) {
            if (o.algoId === undefined) continue;
            try {
                await signedRequest({
                    market,
                    method: 'DELETE',
                    endpoint: `${futPrefix(market)}/v1/algoOrder`,
                    params: {algoId: String(o.algoId)},
                    _deps: deps
                });
                algoCanceled++;
            } catch { /* skip */
            }
        }
    } catch { /* no algo orders */
    }
    return algoCanceled;
}

/**
 * Cancel ALL open orders for a symbol. DRY-RUN by default — only fires with
 * `confirm: true`, since it's bulk-destructive.
 */
export async function cancelAllOrders({market = 'futures', symbol, confirm = false, account = '1', _deps = {}} = {}) {
    if (!symbol) throw new Error('symbol is required');
    const sym = String(symbol).toUpperCase();
    const paperTrading = usePaperTrading(_deps);
    if (paperTrading) confirm = false; // global kill-switch
    if (!confirm) {
        return dryRunResponse({
            paperTrading,
            paperMsg: `PAPER TRADING — would cancel ALL open orders for ${sym} on ${market}; decision logged, nothing sent.`,
            dryMsg: `DRY RUN — pass confirm:true to cancel ALL open orders for ${sym} on ${market}.`,
            extra: {account},
        });
    }
    const deps = resolveDeps(account, _deps);
    if (isFuturesLike(market)) {
        const data = await signedRequest({market, method: 'DELETE', endpoint: `${futPrefix(market)}/v1/allOpenOrders`, params: {symbol: sym}, _deps: deps});
        const algoCanceled = isFutures(market) ? await cancelOpenAlgoOrders({market, sym, deps}) : 0;
        return {success: true, market, account, symbol: sym, response: data, algoCanceled};
    }
    const data = await signedRequest({market, method: 'DELETE', endpoint: '/api/v3/openOrders', params: {symbol: sym}, _deps: deps});
    return {success: true, market, account, symbol: sym, canceled: data};
}
