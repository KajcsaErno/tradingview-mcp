// Binance core — account reads (balances, positions, summaries, risk), account
// configuration (leverage, margin, position mode) and wallet transfers/history.
import {requireFinite} from '../../connection.js';
import {futPrefix, isCoinM, isFutures, isFuturesLike, paperFields, resolveDeps, signedRequest, usePaperTrading,} from './request.js';

/** Read account balances. Spot returns free/locked per asset; futures returns wallet/available. */
export async function getBalance({market = 'futures', account = '1', _deps = {}} = {}) {
    const deps = resolveDeps(account, _deps);
    if (isFuturesLike(market)) {
        // USD-M: /fapi/v2/balance · COIN-M: /dapi/v1/balance (both expose asset/balance/availableBalance)
        const endpoint = isCoinM(market) ? '/dapi/v1/balance' : '/fapi/v2/balance';
        const data = await signedRequest({market, endpoint, _deps: deps});
        const balances = data
            .filter((b) => Number(b.balance) !== 0 || Number(b.availableBalance) !== 0)
            .map((b) => ({asset: b.asset, balance: b.balance, available: b.availableBalance}));
        return {success: true, market, balances};
    }
    const data = await signedRequest({market, endpoint: '/api/v3/account', _deps: deps});
    const balances = (data.balances || [])
        .filter((b) => Number(b.free) + Number(b.locked) > 0)
        .map((b) => ({asset: b.asset, free: b.free, locked: b.locked}));
    return {success: true, market, balances};
}

/** One-call futures account health snapshot: wallet/margin balance, unrealized PnL,
 *  available margin, and the computed margin ratio (maint margin / margin balance). */
export async function getAccountSummary({market = 'futures', account = '1', _deps = {}} = {}) {
    if (!isFuturesLike(market)) throw new Error('getAccountSummary is futures-only');
    const deps = resolveDeps(account, _deps);
    // USD-M: /fapi/v2/account · COIN-M: /dapi/v1/account
    const endpoint = isCoinM(market) ? '/dapi/v1/account' : '/fapi/v2/account';
    const d = await signedRequest({market, endpoint, _deps: deps});
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
export async function getAccountSnapshot({market = 'futures', symbol, account = '1', _deps = {}} = {}) {
    if (!isFuturesLike(market)) throw new Error('snapshot is futures-only');
    const deps = resolveDeps(account, _deps);
    const [sum, posRes, ooRes] = await Promise.all([
        getAccountSummary({market, account, _deps: deps}),
        getPositions({market, symbol, account, _deps: deps}),
        getOpenOrders({market, symbol, account, _deps: deps}),
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

/** Portfolio risk report: per-position notional, liquidation price + distance-to-liq %, and
 *  % of equity, plus account-level gross exposure, exposure/equity, and margin ratio. */
export async function getRiskReport({market = 'futures', account = '1', _deps = {}} = {}) {
    if (!isFuturesLike(market)) throw new Error('risk report is futures-only');
    const deps = resolveDeps(account, _deps);
    const [sum, posData] = await Promise.all([
        getAccountSummary({market, account, _deps: deps}),
        signedRequest({market, endpoint: isCoinM(market) ? '/dapi/v1/positionRisk' : '/fapi/v2/positionRisk', _deps: deps}),
    ]);
    const equity = Number(sum.totalMarginBalance);
    const positions = (Array.isArray(posData) ? posData : []).filter((p) => Number(p.positionAmt) !== 0).map((p) => {
        const amt = Number(p.positionAmt), mark = Number(p.markPrice), liq = Number(p.liquidationPrice);
        const notional = Math.abs(amt) * mark;
        const distToLiqPct = (mark && Number.isFinite(liq) && liq > 0) ? Math.abs(mark - liq) / mark * 100 : undefined;
        const distanceToLiqPct = distToLiqPct === undefined ? undefined : Number(distToLiqPct.toFixed(2));
        return {
            symbol: p.symbol, side: amt > 0 ? 'LONG' : 'SHORT', quantity: Math.abs(amt),
            entryPrice: p.entryPrice, markPrice: p.markPrice, liquidationPrice: p.liquidationPrice,
            leverage: p.leverage, unrealizedPnl: p.unRealizedProfit, notional: Number(notional.toFixed(2)),
            distanceToLiqPct,
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
export async function getPositions({market = 'futures', symbol, account = '1', _deps = {}} = {}) {
    if (!isFuturesLike(market)) throw new Error('getPositions is futures-only');
    const deps = resolveDeps(account, _deps);
    const params = symbol ? {symbol: String(symbol).toUpperCase()} : {};
    const endpoint = isCoinM(market) ? '/dapi/v1/positionRisk' : '/fapi/v2/positionRisk';
    const data = await signedRequest({market, endpoint, params, _deps: deps});
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
    return {success: true, market, positions};
}

/** List open orders. */
export async function getOpenOrders({market = 'futures', symbol, account = '1', _deps = {}} = {}) {
    const deps = resolveDeps(account, _deps);
    const endpoint = isFuturesLike(market) ? `${futPrefix(market)}/v1/openOrders` : '/api/v3/openOrders';
    const params = symbol ? {symbol: String(symbol).toUpperCase()} : {};
    const data = await signedRequest({market, endpoint, params, _deps: deps});
    // Conditional orders (stops/TPs) live in the Algo service since 2025-12-09 — fetch & merge them.
    // USD-M only: COIN-M (dapi) has no Algo service as of 2026-06 (its stops are plain orders).
    let algoOrders = [];
    if (isFutures(market)) {
        try {
            const a = await signedRequest({market, endpoint: `${futPrefix(market)}/v1/openAlgoOrders`, params, _deps: deps});
            algoOrders = Array.isArray(a) ? a : (a.orders || a.algoOrders || []);
        } catch { /* algo endpoint unavailable — leave empty */
        }
    }
    return {success: true, market, count: data.length + algoOrders.length, orders: data, algoOrders};
}

/** Account trade list (signed): user's trades for a symbol */
export async function getAccountTrades({market = 'futures', symbol, fromId, limit = 500, account = '1', _deps = {}} = {}) {
    if (!symbol) throw new Error('symbol is required');
    const sym = String(symbol).toUpperCase();
    const deps = resolveDeps(account, _deps);
    const params = {symbol: sym};
    if (fromId !== undefined) params.fromId = String(fromId);
    const lim = Math.max(1, Math.min(Number(limit) || 500, 1000));
    params.limit = String(lim);
    const endpoint = isFuturesLike(market) ? `${futPrefix(market)}/v1/userTrades` : '/api/v3/myTrades';
    const data = await signedRequest({market, endpoint, params, _deps: deps});
    return {success: true, market, symbol: sym, count: data.length, trades: data};
}

/** Futures income history (signed): realized PnL, funding fees, commissions, etc. — with a
 *  per-type summary. Filter by symbol/incomeType/time window. */
export async function getIncome({market = 'futures', symbol, incomeType, startTime, endTime, limit = 100, account = '1', _deps = {}} = {}) {
    if (!isFuturesLike(market)) throw new Error('income history is futures-only');
    const deps = resolveDeps(account, _deps);
    const params = {};
    if (symbol) params.symbol = String(symbol).toUpperCase();
    if (incomeType) params.incomeType = String(incomeType).toUpperCase();
    if (startTime !== undefined) params.startTime = String(requireFinite(startTime, 'startTime'));
    if (endTime !== undefined) params.endTime = String(requireFinite(endTime, 'endTime'));
    params.limit = String(Math.max(1, Math.min(Number(limit) || 100, 1000)));
    const data = await signedRequest({market, endpoint: `${futPrefix(market)}/v1/income`, params, _deps: deps});
    const summary = {};
    for (const r of (data || [])) summary[r.incomeType] = (summary[r.incomeType] || 0) + Number(r.income);
    for (const k of Object.keys(summary)) summary[k] = Number(summary[k].toFixed(8));
    return {success: true, market, account, count: (data || []).length, summary, income: data};
}

/** Forced-liquidation / ADL history (signed, futures only): the user's OWN positions that
 *  Binance force-closed. Filter by symbol, autoCloseType (LIQUIDATION | ADL) and time window
 *  (if startTime is omitted, Binance returns the 7 days before endTime). This is the
 *  backward-looking complement to getRiskReport's forward-looking distance-to-liquidation. */
export async function getLiquidationHistory({market = 'futures', symbol, autoCloseType, startTime, endTime, limit = 50, account = '1', _deps = {}} = {}) {
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
    const data = await signedRequest({market, endpoint: `${futPrefix(market)}/v1/forceOrders`, params, _deps: deps});
    const orders = Array.isArray(data) ? data : [];
    return {success: true, market, account, count: orders.length, orders};
}

/** Whether the futures account is in Hedge Mode (dualSidePosition) vs one-way. */
export async function getPositionMode({market = 'futures', account = '1', _deps = {}} = {}) {
    if (!isFuturesLike(market)) throw new Error('position mode is futures-only');
    const deps = resolveDeps(account, _deps);
    const data = await signedRequest({market, endpoint: `${futPrefix(market)}/v1/positionSide/dual`, _deps: deps});
    return {success: true, market, account, hedgeMode: !!data.dualSidePosition};
}

/** Switch the futures account between Hedge Mode (true) and one-way (false).
 *  Idempotent: Binance's "no need to change" (-4059) is treated as success. */
export async function setPositionMode({market = 'futures', hedgeMode, account = '1', _deps = {}} = {}) {
    if (!isFuturesLike(market)) throw new Error('position mode is futures-only');
    if (typeof hedgeMode !== 'boolean') throw new Error('hedgeMode must be true (Hedge Mode) or false (one-way)');
    const deps = resolveDeps(account, _deps);
    const params = {dualSidePosition: hedgeMode ? 'true' : 'false'};
    try {
        await signedRequest({market, method: 'POST', endpoint: `${futPrefix(market)}/v1/positionSide/dual`, params, _deps: deps});
        return {success: true, market, account, hedgeMode, changed: true};
    } catch (err) {
        // -4059: "No need to change position side." — already in the requested mode.
        if (/-4059|No need to change/i.test(err.message)) return {success: true, market, account, hedgeMode, changed: false};
        throw err;
    }
}

/** Maker/taker commission rate for a symbol — confirms a "0 maker fee" pair. */
export async function getCommissionRate({market = 'futures', symbol, account = '1', _deps = {}} = {}) {
    if (!symbol) throw new Error('symbol is required');
    const sym = String(symbol).toUpperCase();
    const deps = resolveDeps(account, _deps);
    if (isFuturesLike(market)) {
        const d = await signedRequest({market, endpoint: `${futPrefix(market)}/v1/commissionRate`, params: {symbol: sym}, _deps: deps});
        return {success: true, market, symbol: sym, makerCommissionRate: d.makerCommissionRate, takerCommissionRate: d.takerCommissionRate};
    }
    // Spot: commission rates come from the account/commission endpoint.
    const d = await signedRequest({market, endpoint: '/api/v3/account/commission', params: {symbol: sym}, _deps: deps});
    return {success: true, market, symbol: sym, standardCommission: d.standardCommission, taxCommission: d.taxCommission};
}

/** Set leverage for a futures symbol (signed, futures-only). */
export async function setLeverage({market = 'futures', symbol, leverage, account = '1', _deps = {}} = {}) {
    if (!isFuturesLike(market)) throw new Error('setLeverage is futures-only');
    if (!symbol) throw new Error('symbol is required');
    const lev = requireFinite(leverage, 'leverage');
    if (lev < 1 || lev > 125) throw new Error('leverage must be between 1 and 125');
    const deps = resolveDeps(account, _deps);
    const params = {symbol: String(symbol).toUpperCase(), leverage: String(Math.trunc(lev))};
    const data = await signedRequest({market, method: 'POST', endpoint: `${futPrefix(market)}/v1/leverage`, params, _deps: deps});
    return {success: true, market, leverage: data.leverage, maxNotionalValue: data.maxNotionalValue, symbol: data.symbol};
}

/** Set margin type ISOLATED|CROSSED for a futures symbol (signed, futures-only). */
export async function setMarginType({market = 'futures', symbol, marginType, account = '1', _deps = {}} = {}) {
    if (!isFuturesLike(market)) throw new Error('setMarginType is futures-only');
    if (!symbol) throw new Error('symbol is required');
    const mt = String(marginType || '').toUpperCase();
    if (!['ISOLATED', 'CROSSED'].includes(mt)) throw new Error('marginType must be ISOLATED or CROSSED');
    const deps = resolveDeps(account, _deps);
    const params = {symbol: String(symbol).toUpperCase(), marginType: mt};
    // Binance returns code 200 {"code":200,"msg":"success"}; -4046 = "no need to change".
    const data = await signedRequest({market, method: 'POST', endpoint: `${futPrefix(market)}/v1/marginType`, params, _deps: deps});
    return {success: true, market, marginType: mt, response: data};
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
export async function adjustIsolatedMargin({
                                               market = 'futures',
                                               symbol,
                                               amount,
                                               direction = 'add',
                                               positionSide,
                                               account = '1',
                                               confirm = false,
                                               _deps = {}
                                           } = {}) {
    if (!isFuturesLike(market)) throw new Error('adjustIsolatedMargin is futures-only');
    if (!symbol) throw new Error('symbol is required');
    const dir = String(direction).toLowerCase();
    if (!['add', 'remove'].includes(dir)) throw new Error("direction must be 'add' or 'remove'");
    const amt = requireFinite(amount, 'amount');
    if (amt <= 0) throw new Error('amount must be > 0');
    const deps = resolveDeps(account, _deps);
    const paperTrading = usePaperTrading(_deps);
    if (paperTrading) confirm = false; // global kill-switch
    const sym = String(symbol).toUpperCase();
    const type = dir === 'add' ? 1 : 2; // Binance positionMargin `type`: 1 = add, 2 = remove
    const params = {symbol: sym, amount: String(amt), type: String(type)};
    let ps = positionSide ? String(positionSide).toUpperCase() : null;
    if (ps && !['LONG', 'SHORT', 'BOTH'].includes(ps)) throw new Error('positionSide must be LONG, SHORT, or BOTH');
    // Hedge Mode needs an explicit LONG/SHORT — refuse to guess which position to fund.
    if (!ps && confirm) {
        const mode = await getPositionMode({market, _deps: deps});
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
            margin_preview: {market, endpoint, ...params, action: dir},
        };
    }
    const data = await signedRequest({market, method: 'POST', endpoint, params, _deps: deps});
    return {success: true, market, account, symbol: sym, action: dir, amount: amt, positionSide: ps || 'BOTH', response: data};
}

/** Leverage/margin tiers (brackets) per notional for a symbol — shows max leverage
 *  and maintenance-margin steps. Backs risk decisions (and your 3x-max rule). */
export async function getLeverageBrackets({market = 'futures', symbol, account = '1', _deps = {}} = {}) {
    if (!isFuturesLike(market)) throw new Error('leverage brackets are futures-only');
    const deps = resolveDeps(account, _deps);
    const params = symbol ? {symbol: String(symbol).toUpperCase()} : {};
    const data = await signedRequest({market, endpoint: `${futPrefix(market)}/v1/leverageBracket`, params, _deps: deps});
    // USD-M returns [{ symbol, brackets:[...] }]; COIN-M keys by `pair`.
    const rows = (Array.isArray(data) ? data : [data]).map((r) => ({
        symbol: r.symbol || r.pair,
        brackets: (r.brackets || []).map((b) => ({
            bracket: b.bracket, initialLeverage: b.initialLeverage,
            notionalCap: b.notionalCap ?? b.qtyCap, notionalFloor: b.notionalFloor ?? b.qtyFloor,
            maintMarginRatio: b.maintMarginRatio,
        })),
    }));
    return {success: true, market, account, symbols: rows};
}

// Wallet → Binance Universal-Transfer code. One side must be MAIN (spot) for these pairs.
const WALLET_CODES = {spot: 'MAIN', main: 'MAIN', futures: 'UMFUTURE', usdm: 'UMFUTURE', coinm: 'CMFUTURE'};

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
export async function transfer({asset, amount, from = 'futures', to = 'spot', type, confirm = false, account = '1', _deps = {}} = {}) {
    if (!asset) throw new Error('asset is required (e.g. "USDC")');
    const amt = requireFinite(amount, 'amount');
    if (amt <= 0) throw new Error('amount must be > 0');
    const deps = resolveDeps(account, _deps);
    const paperTrading = usePaperTrading(_deps);
    if (paperTrading) confirm = false; // global kill-switch
    const ttype = type || transferType(String(from).toLowerCase(), String(to).toLowerCase());
    const params = {type: ttype, asset: String(asset).toUpperCase(), amount: String(amt)};

    if (!confirm) {
        return {
            success: false,
            dry_run: true,
            message: paperTrading
                ? `PAPER TRADING — would move ${amt} ${params.asset} (${ttype}); decision logged, nothing sent.`
                : `DRY RUN — no transfer sent. Pass confirm:true to move ${amt} ${params.asset} (${ttype}, REAL funds).`,
            ...paperFields(paperTrading),
            transfer_preview: {...params, from, to, account},
        };
    }
    const data = await signedRequest({market: 'spot', method: 'POST', endpoint: '/sapi/v1/asset/transfer', params, _deps: deps});
    return {success: true, tranId: data.tranId, ...params, from, to, account};
}

/** Recent universal transfers for a wallet pair (signed). */
export async function getTransferHistory({from = 'futures', to = 'spot', type, size = 10, account = '1', _deps = {}} = {}) {
    const deps = resolveDeps(account, _deps);
    const ttype = type || transferType(String(from).toLowerCase(), String(to).toLowerCase());
    const params = {type: ttype, size: String(Math.max(1, Math.min(Number(size) || 10, 100)))};
    const data = await signedRequest({market: 'spot', endpoint: '/sapi/v1/asset/transfer', params, _deps: deps});
    return {success: true, type: ttype, total: data.total || 0, rows: data.rows || []};
}

// Wallet history / address endpoints live on the SAPI (spot host), like transfer — they are
// account-level, not per-market, and exist only on mainnet. All are READ-ONLY (GET), so no
// confirm gate is needed.

/** On-chain deposit history (signed, SAPI/spot host). Filter by coin, status (Binance numeric
 *  codes: 0 pending, 6 credited-but-cannot-withdraw, 1 success, …) and time window. Read-only. */
export async function getDepositHistory({coin, status, startTime, endTime, offset, limit = 100, account = '1', _deps = {}} = {}) {
    const deps = resolveDeps(account, _deps);
    const params = {};
    if (coin) params.coin = String(coin).toUpperCase();
    if (status !== undefined) params.status = String(status);
    if (startTime !== undefined) params.startTime = String(requireFinite(startTime, 'startTime'));
    if (endTime !== undefined) params.endTime = String(requireFinite(endTime, 'endTime'));
    if (offset !== undefined) params.offset = String(offset);
    params.limit = String(Math.max(1, Math.min(Number(limit) || 100, 1000)));
    const data = await signedRequest({market: 'spot', endpoint: '/sapi/v1/capital/deposit/hisrec', params, _deps: deps});
    const deposits = Array.isArray(data) ? data : [];
    return {success: true, account, count: deposits.length, deposits};
}

/** Withdrawal history (signed, SAPI/spot host). Filter by coin, status (Binance numeric codes:
 *  0 email-sent, 1 cancelled, 2 awaiting-approval, 4 processing, 5 failure, 6 completed) and
 *  time window. Read-only. */
export async function getWithdrawHistory({coin, status, startTime, endTime, offset, limit = 100, account = '1', _deps = {}} = {}) {
    const deps = resolveDeps(account, _deps);
    const params = {};
    if (coin) params.coin = String(coin).toUpperCase();
    if (status !== undefined) params.status = String(status);
    if (startTime !== undefined) params.startTime = String(requireFinite(startTime, 'startTime'));
    if (endTime !== undefined) params.endTime = String(requireFinite(endTime, 'endTime'));
    if (offset !== undefined) params.offset = String(offset);
    params.limit = String(Math.max(1, Math.min(Number(limit) || 100, 1000)));
    const data = await signedRequest({market: 'spot', endpoint: '/sapi/v1/capital/withdraw/history', params, _deps: deps});
    const withdrawals = Array.isArray(data) ? data : [];
    return {success: true, account, count: withdrawals.length, withdrawals};
}

/** Deposit address for a coin (signed, SAPI/spot host). `network` is optional (e.g. "BSC",
 *  "ETH", "TRX", "BNB"); omit to get the coin's default network. Read-only — returns the
 *  on-chain address, optional memo/tag, and a block-explorer url. */
export async function getDepositAddress({coin, network, account = '1', _deps = {}} = {}) {
    if (!coin) throw new Error('coin is required (e.g. "USDC")');
    const deps = resolveDeps(account, _deps);
    const params = {coin: String(coin).toUpperCase()};
    if (network) params.network = String(network).toUpperCase();
    const data = await signedRequest({market: 'spot', endpoint: '/sapi/v1/capital/deposit/address', params, _deps: deps});
    return {success: true, account, coin: data.coin, address: data.address, tag: data.tag, url: data.url, network: data.network || params.network};
}
