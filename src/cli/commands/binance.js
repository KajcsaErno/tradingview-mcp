import { register } from '../router.js';
import * as core from '../../core/binance.js';

const marketOpt = { type: 'string', short: 'm', description: 'spot | futures (USD-M) | coinm (COIN-M, qty in contracts) | *-testnet (default futures)' };
const accountOpt = { type: 'string', description: 'API key set: "1" (primary, BINANCE_API_KEY) or "2"/"3"… (BINANCE_API_KEY_2…). Default 1.' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

register('binance', {
  description: 'Binance account: balance, positions, orders (direct API, not via TradingView)',
  subcommands: new Map([
    ['balance', {
      description: 'Show account balances',
      options: { market: marketOpt, account: accountOpt },
      handler: (o) => core.getBalance({ market: o.market || 'futures', account: o.account }),
    }],
    ['positions', {
      description: 'Show open futures positions',
      options: { market: marketOpt, symbol: { type: 'string', short: 's', description: 'Filter by symbol e.g. BTCUSDT' }, account: accountOpt },
      handler: (o) => core.getPositions({ market: o.market || 'futures', symbol: o.symbol, account: o.account }),
    }],
    ['account-summary', {
      description: 'Futures account health: wallet/margin balance, unrealized PnL, available, margin ratio',
      options: { market: marketOpt, account: accountOpt },
      handler: (o) => core.getAccountSummary({ market: o.market || 'futures', account: o.account }),
    }],
    ['account-snapshot', {
      description: 'Compact monitoring snapshot: margin ratio, available, uPnL, open-order counts, positions',
      options: { market: marketOpt, symbol: { type: 'string', short: 's', description: 'Filter by symbol e.g. BTCUSDC' }, account: accountOpt },
      handler: (o) => core.getAccountSnapshot({ market: o.market || 'futures', symbol: o.symbol, account: o.account }),
    }],
    ['risk-report', {
      description: 'Portfolio risk: per-position notional, liq price + distance-to-liq %, % of equity, gross exposure',
      options: { market: marketOpt, account: accountOpt },
      handler: (o) => core.getRiskReport({ market: o.market || 'futures', account: o.account }),
    }],
    ['position-size', {
      description: 'Risk-based position sizing from entry + a stop (explicit --stop, or ATR-derived via --atrMult and --side) and a risk budget (--riskAmount or --riskPct)',
      options: {
        market: marketOpt,
        symbol: { type: 'string', short: 's', description: 'e.g. BTCUSDC (enables qty rounding; required for an ATR-derived stop)' },
        entry: { type: 'string', description: 'Entry price', required: true },
        stop: { type: 'string', description: 'Stop-loss price (omit to derive from ATR with --atrMult + --side)' },
        side: { type: 'string', description: 'BUY/LONG or SELL/SHORT — required for an ATR-derived stop' },
        atrMult: { type: 'string', description: 'Derive the stop as entry ∓ atrMult·ATR(14) off klines (needs --symbol and --side)' },
        interval: { type: 'string', short: 'i', description: 'Kline interval for the ATR stop (default 1h)' },
        leverage: { type: 'string', short: 'l', description: 'Leverage (default 3)' },
        riskAmount: { type: 'string', description: 'Risk budget in $', oneOfGroup: 'risk_budget', mutuallyExclusiveGroup: 'risk_budget' },
        riskPct: { type: 'string', description: 'Risk budget as % of balance', oneOfGroup: 'risk_budget', mutuallyExclusiveGroup: 'risk_budget' },
        balance: { type: 'string', description: 'Balance to size against (fetched if omitted)' },
        noRound: { type: 'boolean', description: 'Do not snap qty to step size' },
        account: accountOpt,
      },
      handler: (o) => core.calcPositionSize({
        market: o.market || 'futures', symbol: o.symbol, entry: Number(o.entry),
        stop: o.stop !== undefined ? Number(o.stop) : undefined,
        side: o.side, atrMult: o.atrMult !== undefined ? Number(o.atrMult) : undefined, interval: o.interval || '1h',
        leverage: o.leverage !== undefined ? Number(o.leverage) : undefined,
        riskAmount: o.riskAmount !== undefined ? Number(o.riskAmount) : undefined,
        riskPct: o.riskPct !== undefined ? Number(o.riskPct) : undefined,
        balance: o.balance !== undefined ? Number(o.balance) : undefined,
        round: !o.noRound, account: o.account,
      }),
    }],
    ['expectancy', {
      description: 'Expectancy from a win rate + reward:risk: expectancy in R, break-even win rate (1/(1+rr)), and $/% projections over N trades',
      options: {
        winRate: { type: 'string', description: 'Win rate as a percent, e.g. 50', required: true },
        rrRatio: { type: 'string', description: 'Reward:risk ratio, e.g. 2 for 2:1', required: true },
        riskPct: { type: 'string', description: 'Risk per trade as % of account' },
        riskAmount: { type: 'string', description: 'Risk per trade in $' },
        balance: { type: 'string', description: 'Balance, to turn --riskPct into $' },
        trades: { type: 'string', description: 'Sample size for the projection (default 100)' },
      },
      handler: (o) => core.calcExpectancy({
        winRate: Number(o.winRate), rrRatio: Number(o.rrRatio),
        riskPct: o.riskPct !== undefined ? Number(o.riskPct) : undefined,
        riskAmount: o.riskAmount !== undefined ? Number(o.riskAmount) : undefined,
        balance: o.balance !== undefined ? Number(o.balance) : undefined,
        trades: o.trades !== undefined ? Number(o.trades) : undefined,
      }),
    }],
    ['losing-streak', {
      description: 'Longest losing streak to expect over a sample size for a win rate (ln(N)/ln(1/lossRate)); --riskPct adds the implied drawdown',
      options: {
        winRate: { type: 'string', description: 'Win rate as a percent, strictly 0–100', required: true },
        sampleSize: { type: 'string', description: 'Trades to plan over (default 1000)' },
        riskPct: { type: 'string', description: 'Risk per trade as % — adds worst-streak drawdown' },
      },
      handler: (o) => core.estimateLosingStreak({
        winRate: Number(o.winRate),
        sampleSize: o.sampleSize !== undefined ? Number(o.sampleSize) : undefined,
        riskPct: o.riskPct !== undefined ? Number(o.riskPct) : undefined,
      }),
    }],
    ['simulate-equity', {
      description: 'Monte Carlo equity sim: final-return & max-drawdown percentiles, longest losing streak, % profitable and % ruined across many random trade sequences',
      options: {
        winRate: { type: 'string', description: 'Win rate as a percent 0–100', required: true },
        rrRatio: { type: 'string', description: 'Reward:risk ratio, e.g. 2', required: true },
        riskPct: { type: 'string', description: 'Risk per trade as % of balance (default 1)' },
        startBalance: { type: 'string', description: 'Starting balance (default 10000)' },
        trades: { type: 'string', description: 'Trades per run (default 1000, max 100000)' },
        runs: { type: 'string', description: 'Independent runs (default 1000, max 10000)' },
        noCompounding: { type: 'boolean', description: 'Risk a fixed % of the starting balance instead of the current balance' },
        ruinDrawdownPct: { type: 'string', description: 'Drawdown %% that counts as ruin (default 50)' },
      },
      handler: (o) => core.simulateEquity({
        winRate: Number(o.winRate), rrRatio: Number(o.rrRatio),
        riskPct: o.riskPct !== undefined ? Number(o.riskPct) : undefined,
        startBalance: o.startBalance !== undefined ? Number(o.startBalance) : undefined,
        trades: o.trades !== undefined ? Number(o.trades) : undefined,
        runs: o.runs !== undefined ? Number(o.runs) : undefined,
        compounding: !o.noCompounding,
        ruinDrawdownPct: o.ruinDrawdownPct !== undefined ? Number(o.ruinDrawdownPct) : undefined,
      }),
    }],
    ['stream', {
      description: 'Poll account/position state and emit JSONL on change (Ctrl-C to stop); --once for a single snapshot',
      options: {
        market: marketOpt,
        symbol: { type: 'string', short: 's', description: 'Filter by symbol e.g. BTCUSDC' },
        account: accountOpt,
        interval: { type: 'string', short: 'i', description: 'Poll interval in ms (default 3000, min 500)' },
        once: { type: 'boolean', description: 'Print one snapshot and exit' },
      },
      handler: async (o) => {
        const snap = () => core.getAccountSnapshot({ market: o.market || 'futures', symbol: o.symbol, account: o.account });
        if (o.once) return snap();
        const interval = Math.max(500, Number(o.interval) || 3000);
        let prev = null;
        for (;;) {
          let cur;
          try { cur = await snap(); }
          catch (e) { console.log(JSON.stringify({ time: new Date().toISOString(), error: e.message })); await sleep(interval); continue; }
          const key = JSON.stringify({ p: cur.positions, oo: cur.openOrders, ao: cur.openAlgoOrders, mr: cur.marginRatio, pnl: cur.totalUnrealizedPnl });
          if (key !== prev) { prev = key; console.log(JSON.stringify({ time: new Date().toISOString(), ...cur })); }
          await sleep(interval);
        }
      },
    }],
    ['user-stream', {
      description: 'Stream real-time order fills, position & balance updates over a WebSocket (user-data stream). Ctrl-C to stop.',
      options: {
        market: marketOpt,
        account: accountOpt,
        raw: { type: 'boolean', description: 'Emit the raw Binance event payload instead of the compact summary' },
      },
      handler: async (o) => {
        const market = o.market || 'futures';
        const account = o.account || '1';
        process.stderr.write('⚠  tradingview-mcp | Unofficial. Connects to YOUR Binance account via your own API keys.\n');
        process.stderr.write(`[user-stream:${market}/acct${account}] starting… Ctrl-C to stop\n`);

        let running = true, ws = null, keepAlive = null, listenKey = null, backoff = 1000;
        const emit = (obj) => process.stdout.write(JSON.stringify({ time: new Date().toISOString(), _stream: 'user', market, account, ...obj }) + '\n');

        // Normalize the key futures user-data events into a compact line (or pass raw with --raw).
        const fmt = (m) => {
          if (o.raw) return { event: m.e, raw: m };
          switch (m.e) {
            case 'ORDER_TRADE_UPDATE': { const x = m.o || {};
              return { event: 'order', symbol: x.s, side: x.S, type: x.o, status: x.X, posSide: x.ps,
                qty: x.q, price: x.p, avgPrice: x.ap, lastFilledQty: x.l, cumFilledQty: x.z,
                stop: x.sp, realizedPnl: x.rp, reduceOnly: x.R, orderId: x.i }; }
            case 'ACCOUNT_UPDATE': { const a = m.a || {};
              return { event: 'account', reason: a.m,
                balances: (a.B || []).map((b) => ({ asset: b.a, wallet: b.wb, cross: b.cw })),
                positions: (a.P || []).map((p) => ({ symbol: p.s, posSide: p.ps, amt: p.pa, entry: p.ep, uPnl: p.up })) }; }
            case 'ACCOUNT_CONFIG_UPDATE': return { event: 'config', raw: m.ac || m.ai };
            case 'listenKeyExpired': return { event: 'listenKeyExpired' };
            default: return { event: m.e || 'unknown', raw: m };
          }
        };

        const cleanup = async () => {
          running = false;
          if (keepAlive) clearInterval(keepAlive);
          try { ws && ws.close(); } catch { /* ignore */ }
          if (listenKey) { try { await core.closeUserStream({ market, account, listenKey }); } catch { /* ignore */ } }
          process.stderr.write('\n[user-stream] stopped\n');
          process.exit(0);
        };
        process.on('SIGINT', cleanup);
        process.on('SIGTERM', cleanup);

        const connect = async () => {
          if (!running) return;
          let started;
          try { started = await core.startUserStream({ market, account }); }
          catch (e) {
            process.stderr.write(`[user-stream] start failed: ${e.message} — retry in ${backoff}ms\n`);
            return void setTimeout(connect, (backoff = Math.min(backoff * 2, 30000)));
          }
          listenKey = started.listenKey;
          backoff = 1000;
          ws = new WebSocket(started.wsUrl);
          ws.addEventListener('open', () => process.stderr.write('[user-stream] connected\n'));
          ws.addEventListener('message', (ev) => {
            let m; try { m = JSON.parse(ev.data); } catch { return; }
            emit(fmt(m));
            if (m.e === 'listenKeyExpired') { try { ws.close(); } catch { /* reconnect via close handler */ } }
          });
          ws.addEventListener('close', () => {
            if (!running) return;
            process.stderr.write(`[user-stream] disconnected — reconnecting in ${backoff}ms\n`);
            setTimeout(connect, (backoff = Math.min(backoff * 2, 30000)));
          });
          ws.addEventListener('error', () => { /* a 'close' event follows; reconnect there */ });
          if (keepAlive) clearInterval(keepAlive);
          keepAlive = setInterval(() => {
            core.keepAliveUserStream({ market, account, listenKey }).catch((e) => process.stderr.write(`[user-stream] keepalive failed: ${e.message}\n`));
          }, 30 * 60 * 1000);
        };

        await connect();
        await new Promise(() => {}); // never resolves — runs until Ctrl-C (matches `tv binance stream`)
      },
    }],
    ['market-stream', {
      description: 'Stream public market data (trade/ticker/bookTicker/kline/markPrice/funding) for one or more symbols over a multiplexed WebSocket; emits JSONL. Ctrl-C to stop.',
      options: {
        market: marketOpt,
        symbols: { type: 'string', short: 's', description: 'CSV of symbols, e.g. "BTCUSDC,ETHUSDC"', required: true },
        streams: { type: 'string', description: 'CSV of stream types: trade,aggTrade,ticker,bookTicker,kline[:1m],markPrice,funding (default trade,bookTicker)' },
        raw: { type: 'boolean', description: 'Emit the raw Binance payload instead of the compact summary' },
      },
      handler: async (o) => {
        const market = o.market || 'futures';
        let plan;
        try { plan = core.buildMarketStream({ market, symbols: o.symbols, streams: o.streams || 'trade,bookTicker' }); }
        catch (e) { process.stderr.write(`[market-stream] ${e.message}\n`); process.exit(1); return; }

        process.stderr.write('⚠  tradingview-mcp | Unofficial. Public market data only — no account/keys involved.\n');
        process.stderr.write(`[market-stream:${market}] ${plan.subscriptions.join(', ')} — Ctrl-C to stop\n`);

        let running = true, ws = null, backoff = 1000;
        const emit = (obj) => process.stdout.write(JSON.stringify({ time: new Date().toISOString(), _stream: 'market', market, ...obj }) + '\n');

        const cleanup = () => {
          running = false;
          try { ws && ws.close(); } catch { /* ignore */ }
          process.stderr.write('\n[market-stream] stopped\n');
          process.exit(0);
        };
        process.on('SIGINT', cleanup);
        process.on('SIGTERM', cleanup);

        const connect = () => {
          if (!running) return;
          ws = new WebSocket(plan.wsUrl);
          ws.addEventListener('open', () => { backoff = 1000; process.stderr.write('[market-stream] connected\n'); });
          ws.addEventListener('message', (ev) => {
            let m; try { m = JSON.parse(ev.data); } catch { return; }
            emit(o.raw ? { stream: m.stream, raw: m.data || m } : core.formatMarketEvent(m));
          });
          ws.addEventListener('close', () => {
            if (!running) return;
            process.stderr.write(`[market-stream] disconnected — reconnecting in ${backoff}ms\n`);
            setTimeout(connect, (backoff = Math.min(backoff * 2, 30000)));
          });
          ws.addEventListener('error', () => { /* a 'close' event follows; reconnect there */ });
        };

        connect();
        await new Promise(() => {}); // never resolves — runs until Ctrl-C (matches `tv binance user-stream`)
      },
    }],
    ['orders', {
      description: 'List open orders',
      options: { market: marketOpt, symbol: { type: 'string', short: 's', description: 'Filter by symbol' }, account: accountOpt },
      handler: (o) => core.getOpenOrders({ market: o.market || 'futures', symbol: o.symbol, account: o.account }),
    }],
    ['order-status', {
      description: 'Get a single order by id or client id',
      options: {
        market: marketOpt,
        symbol: { type: 'string', short: 's', description: 'e.g. BTCUSDT', required: true },
        orderId: { type: 'string', description: 'Order id to fetch', oneOfGroup: 'order_identifier', mutuallyExclusiveGroup: 'order_identifier' },
        origClientOrderId: { type: 'string', description: 'Original client order id', oneOfGroup: 'order_identifier', mutuallyExclusiveGroup: 'order_identifier' },
        account: accountOpt,
      },
      handler: (o) => {
        if (!o.orderId && !o.origClientOrderId) throw new Error('Either --orderId or --origClientOrderId is required');
        return core.getOrder({ market: o.market || 'futures', symbol: o.symbol, orderId: o.orderId, origClientOrderId: o.origClientOrderId, account: o.account });
      },
    }],
    ['agg-trades', {
      description: 'Get aggregated trades (aggTrades) for a symbol (public)',
      options: {
        market: marketOpt,
        symbol: { type: 'string', short: 's', description: 'e.g. BTCUSDT', required: true },
        fromId: { type: 'string', description: 'Return aggTrades from this id' },
        startTime: { type: 'string', description: 'Start time in ms since epoch' },
        endTime: { type: 'string', description: 'End time in ms since epoch' },
        limit: { type: 'string', short: 'n', description: 'Max number of aggTrades (1-1000)' },
      },
      handler: (o) => core.getAggTrades({
        market: o.market || 'futures', symbol: o.symbol, fromId: o.fromId,
        startTime: o.startTime !== undefined ? Number(o.startTime) : undefined,
        endTime: o.endTime !== undefined ? Number(o.endTime) : undefined,
        limit: o.limit !== undefined ? Number(o.limit) : undefined,
      }),
    }],
    ['historical', {
      description: 'Get historical trades (spot only) — requires API key',
      options: { market: marketOpt, symbol: { type: 'string', short: 's', description: 'e.g. BTCUSDT', required: true }, fromId: { type: 'string' }, limit: { type: 'string', short: 'n' }, account: accountOpt },
      handler: (o) => core.getHistoricalTrades({ market: o.market || 'spot', symbol: o.symbol, fromId: o.fromId, limit: o.limit !== undefined ? Number(o.limit) : undefined, account: o.account }),
    }],
    ['account-trades', {
      description: "Get user's account trades (signed)",
      options: { market: marketOpt, symbol: { type: 'string', short: 's', description: 'e.g. BTCUSDT', required: true }, fromId: { type: 'string' }, limit: { type: 'string', short: 'n' }, account: accountOpt },
      handler: (o) => core.getAccountTrades({ market: o.market || 'futures', symbol: o.symbol, fromId: o.fromId, limit: o.limit !== undefined ? Number(o.limit) : undefined, account: o.account }),
    }],
    ['order-history', {
      description: 'All orders for a symbol — open, filled, and cancelled (signed)',
      options: {
        market: marketOpt,
        symbol: { type: 'string', short: 's', description: 'e.g. BTCUSDC', required: true },
        orderId: { type: 'string', description: 'Return orders from this id onward' },
        startTime: { type: 'string', description: 'Start time in ms since epoch' },
        endTime: { type: 'string', description: 'End time in ms since epoch' },
        limit: { type: 'string', short: 'n', description: 'Max orders (default 500, max 1000)' },
        account: accountOpt,
      },
      handler: (o) => core.getOrderHistory({
        market: o.market || 'futures', symbol: o.symbol, orderId: o.orderId,
        startTime: o.startTime !== undefined ? Number(o.startTime) : undefined,
        endTime: o.endTime !== undefined ? Number(o.endTime) : undefined,
        limit: o.limit !== undefined ? Number(o.limit) : undefined, account: o.account,
      }),
    }],
    ['income', {
      description: 'Futures income history (signed): realized PnL, funding fees, commissions — with a per-type summary',
      options: {
        market: marketOpt,
        symbol: { type: 'string', short: 's', description: 'Filter by symbol (optional)' },
        incomeType: { type: 'string', description: 'REALIZED_PNL | FUNDING_FEE | COMMISSION | TRANSFER | …' },
        startTime: { type: 'string', description: 'Start time in ms since epoch' },
        endTime: { type: 'string', description: 'End time in ms since epoch' },
        limit: { type: 'string', short: 'n', description: 'Max rows (default 100, max 1000)' },
        account: accountOpt,
      },
      handler: (o) => core.getIncome({
        market: o.market || 'futures', symbol: o.symbol, incomeType: o.incomeType,
        startTime: o.startTime !== undefined ? Number(o.startTime) : undefined,
        endTime: o.endTime !== undefined ? Number(o.endTime) : undefined,
        limit: o.limit !== undefined ? Number(o.limit) : undefined, account: o.account,
      }),
    }],
    ['liquidation-history', {
      description: "Forced-liquidation / ADL history (signed, futures only) — the user's own force-closed positions",
      options: {
        market: marketOpt,
        symbol: { type: 'string', short: 's', description: 'Filter by symbol (optional)' },
        autoCloseType: { type: 'string', description: 'LIQUIDATION | ADL (omit for both)' },
        startTime: { type: 'string', description: 'Start time in ms since epoch' },
        endTime: { type: 'string', description: 'End time in ms since epoch' },
        limit: { type: 'string', short: 'n', description: 'Max rows (default 50, max 100)' },
        account: accountOpt,
      },
      handler: (o) => core.getLiquidationHistory({
        market: o.market || 'futures', symbol: o.symbol, autoCloseType: o.autoCloseType,
        startTime: o.startTime !== undefined ? Number(o.startTime) : undefined,
        endTime: o.endTime !== undefined ? Number(o.endTime) : undefined,
        limit: o.limit !== undefined ? Number(o.limit) : undefined, account: o.account,
      }),
    }],
    ['trades', {
      description: 'Get recent public trades for a symbol',
      options: { market: marketOpt, symbol: { type: 'string', short: 's', description: 'e.g. BTCUSDT', required: true }, limit: { type: 'string', short: 'n', description: 'Max number of trades (1-1000, default 50)' } },
      handler: (o) => core.getRecentTrades({ market: o.market || 'futures', symbol: o.symbol, limit: o.limit !== undefined ? Number(o.limit) : undefined }),
    }],
    ['order', {
      description: 'Place an order (DRY RUN unless --confirm is passed)',
      options: {
        market: marketOpt,
        symbol: { type: 'string', short: 's', description: 'e.g. BTCUSDT', required: true },
        side: { type: 'string', description: 'BUY or SELL', required: true },
        type: { type: 'string', short: 't', description: 'MARKET|LIMIT|STOP|STOP_MARKET|TAKE_PROFIT|TAKE_PROFIT_MARKET (default MARKET)' },
          quantity: { type: 'string', short: 'q', description: 'Base-asset quantity (omit with --closePosition)' },
          price: { type: 'string', short: 'p', description: 'Limit price (LIMIT/STOP/TAKE_PROFIT)' },
          stopPrice: { type: 'string', description: 'Trigger price (required for stop/TP types)' },
          closePosition: { type: 'boolean', description: 'Futures stop/TP that closes the whole position' },
          noPostOnly: { type: 'boolean', description: 'Disable the default post-only (allow a normal GTC limit)' },
          allowTaker: { type: 'boolean', description: 'Permit taker-only types: MARKET / STOP_MARKET / TAKE_PROFIT_MARKET' },
          timeInForce: { type: 'string', description: 'GTC | IOC | FOK | GTX (post-only forces GTX)' },
          clientOrderId: { type: 'string', description: 'Optional client order id (newClientOrderId)' },
          positionSide: { type: 'string', description: 'Hedge mode: LONG | SHORT | BOTH (required in hedge mode)' },
          noRound: { type: 'boolean', description: 'Do not snap price/qty to the symbol tick/step size' },
        reduceOnly: { type: 'boolean', description: 'Futures: close-only order' },
        account: accountOpt,
        confirm: { type: 'boolean', description: 'REQUIRED to actually send a live order' },
      },
      handler: (o) => core.placeOrder({
        market: o.market || 'futures',
        symbol: o.symbol,
        side: o.side,
        type: o.type || 'MARKET',
          quantity: o.quantity !== undefined ? Number(o.quantity) : undefined,
          price: o.price !== undefined ? Number(o.price) : undefined,
          stopPrice: o.stopPrice !== undefined ? Number(o.stopPrice) : undefined,
          closePosition: !!o.closePosition,
          postOnly: !o.noPostOnly,
          allowTaker: !!o.allowTaker,
          timeInForce: o.timeInForce,
          positionSide: o.positionSide,
          round: !o.noRound,
          newClientOrderId: o.clientOrderId,
        reduceOnly: !!o.reduceOnly,
        account: o.account,
        confirm: !!o.confirm,
      }),
    }],
    ['cancel', {
      description: 'Cancel an open order by id',
      options: {
        market: marketOpt,
        symbol: { type: 'string', short: 's', description: 'e.g. BTCUSDT', required: true },
        orderId: { type: 'string', description: 'Order id to cancel', oneOfGroup: 'order_identifier', mutuallyExclusiveGroup: 'order_identifier' },
        origClientOrderId: { type: 'string', description: 'Original client order id to cancel', oneOfGroup: 'order_identifier', mutuallyExclusiveGroup: 'order_identifier' },
        account: accountOpt,
      },
      handler: (o) => {
        if (!o.orderId && !o.origClientOrderId) throw new Error('Either --orderId or --origClientOrderId is required to cancel');
        return core.cancelOrder({ market: o.market || 'futures', symbol: o.symbol, orderId: o.orderId, origClientOrderId: o.origClientOrderId, account: o.account });
      },
    }],
    ['ladder', {
      description: 'Scale in with N post-only LIMIT rungs across [lo,hi], optional --seed and --stop (DRY RUN unless --confirm)',
      options: {
        market: marketOpt,
        symbol: { type: 'string', short: 's', description: 'e.g. BTCUSDC', required: true },
        side: { type: 'string', description: 'BUY or SELL', required: true },
        lo: { type: 'string', description: 'Bottom of the entry range', required: true },
        hi: { type: 'string', description: 'Top of the entry range', required: true },
        count: { type: 'string', short: 'c', description: 'Number of rungs (default 10)' },
        totalNotional: { type: 'string', description: 'Total $ notional split evenly across rungs', oneOfGroup: 'ladder_size', mutuallyExclusiveGroup: 'ladder_size' },
        totalQuantity: { type: 'string', description: 'Total base qty split evenly across rungs', oneOfGroup: 'ladder_size', mutuallyExclusiveGroup: 'ladder_size' },
        positionSide: { type: 'string', description: 'Hedge mode: LONG | SHORT | BOTH' },
        seed: { type: 'string', description: 'Optional MARKET seed quantity to open the position now (or "min" for the smallest valid size, so a closePosition stop can rest)' },
        stop: { type: 'string', description: 'Optional closePosition STOP_MARKET trigger price' },
        noPostOnly: { type: 'boolean', description: 'Disable default post-only on the rungs' },
        noRound: { type: 'boolean', description: 'Do not snap price/qty to tick/step' },
        account: accountOpt,
        confirm: { type: 'boolean', description: 'REQUIRED to actually place the ladder' },
      },
      handler: (o) => core.placeLadder({
        market: o.market || 'futures', symbol: o.symbol, side: o.side,
        lo: Number(o.lo), hi: Number(o.hi), count: o.count !== undefined ? Number(o.count) : undefined,
        totalNotional: o.totalNotional !== undefined ? Number(o.totalNotional) : undefined,
        totalQuantity: o.totalQuantity !== undefined ? Number(o.totalQuantity) : undefined,
        positionSide: o.positionSide,
        seedQuantity: o.seed === undefined ? undefined
          : (String(o.seed).trim().toLowerCase() === 'min' ? 'min' : Number(o.seed)),
        stop: o.stop !== undefined ? Number(o.stop) : undefined,
        postOnly: !o.noPostOnly, round: !o.noRound, account: o.account, confirm: !!o.confirm,
      }),
    }],
    ['ensure-stop', {
      description: 'Ensure an open position has a closePosition stop; places one only if missing (DRY RUN unless --confirm)',
      options: {
        market: marketOpt,
        symbol: { type: 'string', short: 's', description: 'e.g. BTCUSDC', required: true },
        stop: { type: 'string', description: 'Stop trigger price', required: true },
        positionSide: { type: 'string', description: 'Hedge mode: LONG | SHORT (defaults to the open position side)' },
        account: accountOpt,
        confirm: { type: 'boolean', description: 'REQUIRED to actually place the stop' },
      },
      handler: (o) => core.ensureProtectiveStop({
        market: o.market || 'futures', symbol: o.symbol, stop: Number(o.stop),
        positionSide: o.positionSide, account: o.account, confirm: !!o.confirm,
      }),
    }],
    ['modify', {
      description: 'Amend a resting futures LIMIT order price/quantity in place (DRY RUN unless --confirm)',
      options: {
        market: marketOpt,
        symbol: { type: 'string', short: 's', description: 'e.g. BTCUSDC', required: true },
        orderId: { type: 'string', description: 'Order id to modify', oneOfGroup: 'order_identifier', mutuallyExclusiveGroup: 'order_identifier' },
        origClientOrderId: { type: 'string', description: 'Original client order id', oneOfGroup: 'order_identifier', mutuallyExclusiveGroup: 'order_identifier' },
        side: { type: 'string', description: 'BUY or SELL (must match the order)', required: true },
        quantity: { type: 'string', short: 'q', description: 'New quantity', required: true },
        price: { type: 'string', short: 'p', description: 'New limit price', required: true },
        noRound: { type: 'boolean', description: 'Do not snap price/qty to tick/step' },
        account: accountOpt,
        confirm: { type: 'boolean', description: 'REQUIRED to actually modify' },
      },
      handler: (o) => {
        if (!o.orderId && !o.origClientOrderId) throw new Error('Either --orderId or --origClientOrderId is required');
        return core.modifyOrder({
          market: o.market || 'futures', symbol: o.symbol, orderId: o.orderId, origClientOrderId: o.origClientOrderId,
          side: o.side, quantity: o.quantity !== undefined ? Number(o.quantity) : undefined,
          price: o.price !== undefined ? Number(o.price) : undefined,
          round: !o.noRound, account: o.account, confirm: !!o.confirm,
        });
      },
    }],
    ['cancel-all', {
      description: 'Cancel ALL open orders for a symbol (DRY RUN unless --confirm)',
      options: {
        market: marketOpt,
        symbol: { type: 'string', short: 's', description: 'e.g. BTCUSDT', required: true },
        account: accountOpt,
        confirm: { type: 'boolean', description: 'REQUIRED to actually cancel' },
      },
      handler: (o) => core.cancelAllOrders({ market: o.market || 'futures', symbol: o.symbol, account: o.account, confirm: !!o.confirm }),
    }],
    ['cancel-algo', {
      description: 'Cancel a conditional (stop/TP) algo order by algoId',
      options: { market: marketOpt, algoId: { type: 'string', description: 'Algo order id', required: true }, account: accountOpt },
      handler: (o) => core.cancelAlgoOrder({ market: o.market || 'futures', algoId: o.algoId, account: o.account }),
    }],
    ['ticker', {
      description: 'Latest price for a symbol (public)',
      options: { market: marketOpt, symbol: { type: 'string', short: 's', description: 'e.g. BTCUSDT', required: true } },
      handler: (o) => core.getTicker({ market: o.market || 'futures', symbol: o.symbol }),
    }],
    ['watch-price', {
      description: 'Watch live trades over a public WebSocket for a bounded window, then print a compact summary (OHLC + change, VWAP, volume, tick count). Bounded counterpart to the unbounded `stream` loop.',
      options: {
        market: marketOpt,
        symbol: { type: 'string', short: 's', description: 'e.g. BTCUSDC', required: true },
        durationSec: { type: 'string', short: 'd', description: 'Seconds to watch (1-60, default 10)' },
      },
      handler: (o) => core.watchPrice({
        market: o.market || 'futures', symbol: o.symbol,
        durationSec: o.durationSec !== undefined ? Number(o.durationSec) : undefined,
      }),
    }],
    ['klines', {
      description: 'Candlesticks (OHLCV) for a symbol (public) — for the exact Binance contract, no chart needed',
      options: {
        market: marketOpt,
        symbol: { type: 'string', short: 's', description: 'e.g. BTCUSDC', required: true },
        interval: { type: 'string', short: 'i', description: '1m,5m,15m,1h,4h,1d,… (default 1h)' },
        startTime: { type: 'string', description: 'Start time in ms since epoch' },
        endTime: { type: 'string', description: 'End time in ms since epoch' },
        limit: { type: 'string', short: 'n', description: 'Bars (spot max 1000, futures max 1500; default 500)' },
        extended: { type: 'boolean', description: 'Also include per-bar order-flow fields (quoteVolume, trades, takerBuyVolume, takerBuyQuoteVolume)' },
      },
      handler: (o) => core.getKlines({
        market: o.market || 'futures', symbol: o.symbol, interval: o.interval || '1h',
        startTime: o.startTime !== undefined ? Number(o.startTime) : undefined,
        endTime: o.endTime !== undefined ? Number(o.endTime) : undefined,
        limit: o.limit !== undefined ? Number(o.limit) : undefined,
        extended: !!o.extended,
      }),
    }],
    ['ticker-24hr', {
      description: '24-hour price-change stats; one --symbol, or --all (optionally --quote USDC) to scan every symbol',
      options: {
        market: marketOpt,
        symbol: { type: 'string', short: 's', description: 'e.g. BTCUSDC (omit with --all)' },
        all: { type: 'boolean', description: 'Return every symbol on the market' },
        quote: { type: 'string', short: 'q', description: 'With --all: keep only this quote asset, e.g. USDC' },
      },
      handler: (o) => core.get24hrTicker({ market: o.market || 'futures', symbol: o.symbol, all: !!o.all, quote: o.quote }),
    }],
    ['book-ticker', {
      description: 'Best bid/ask + spread; one --symbol, or --all (optionally --quote USDC) to scan every symbol',
      options: {
        market: marketOpt,
        symbol: { type: 'string', short: 's', description: 'e.g. BTCUSDC (omit with --all)' },
        all: { type: 'boolean', description: 'Return every symbol on the market' },
        quote: { type: 'string', short: 'q', description: 'With --all: keep only this quote asset, e.g. USDC' },
      },
      handler: (o) => core.getBookTicker({ market: o.market || 'futures', symbol: o.symbol, all: !!o.all, quote: o.quote }),
    }],
    ['ui-klines', {
      description: 'UI-optimized candlesticks (spot-only /uiKlines) — same shape as klines, tuned for charting',
      options: {
        market: marketOpt,
        symbol: { type: 'string', short: 's', description: 'e.g. BTCUSDC', required: true },
        interval: { type: 'string', short: 'i', description: '1m,5m,15m,1h,4h,1d,… (default 1h)' },
        startTime: { type: 'string', description: 'Start time in ms since epoch' },
        endTime: { type: 'string', description: 'End time in ms since epoch' },
        limit: { type: 'string', short: 'n', description: 'Bars (max 1000; default 500)' },
        extended: { type: 'boolean', description: 'Also include per-bar order-flow fields (quoteVolume, trades, takerBuyVolume, takerBuyQuoteVolume)' },
      },
      handler: (o) => core.getUiKlines({
        market: o.market || 'spot', symbol: o.symbol, interval: o.interval || '1h',
        startTime: o.startTime !== undefined ? Number(o.startTime) : undefined,
        endTime: o.endTime !== undefined ? Number(o.endTime) : undefined,
        limit: o.limit !== undefined ? Number(o.limit) : undefined,
        extended: !!o.extended,
      }),
    }],
    ['trading-day', {
      description: 'Trading-day price-change stats (spot-only); one --symbol or a --symbols CSV, optional --timeZone',
      options: {
        market: marketOpt,
        symbol: { type: 'string', short: 's', description: 'e.g. BTCUSDC' },
        symbols: { type: 'string', description: 'CSV list to scan, e.g. "BTCUSDC,ETHUSDC"' },
        timeZone: { type: 'string', description: 'Trading-day offset, e.g. "0" (UTC) or "8"' },
      },
      handler: (o) => core.getTradingDayTicker({ market: o.market || 'spot', symbol: o.symbol, symbols: o.symbols, timeZone: o.timeZone }),
    }],
    ['funding', {
      description: 'Perpetual funding rate (public): current snapshot, or --history for recent payments',
      options: {
        market: marketOpt,
        symbol: { type: 'string', short: 's', description: 'e.g. BTCUSDC', required: true },
        history: { type: 'boolean', description: 'Recent funding-rate history instead of the current snapshot' },
        limit: { type: 'string', short: 'n', description: 'History rows (default 10, max 1000)' },
      },
      handler: (o) => core.getFundingRate({ market: o.market || 'futures', symbol: o.symbol, history: !!o.history, limit: o.limit !== undefined ? Number(o.limit) : undefined }),
    }],
    ['avg-price', {
      description: 'Current average price over a short window (spot-only; ~5-min avg)',
      options: { market: marketOpt, symbol: { type: 'string', short: 's', description: 'e.g. BTCUSDC', required: true } },
      handler: (o) => core.getAvgPrice({ market: o.market || 'spot', symbol: o.symbol }),
    }],
    ['rolling-ticker', {
      description: 'Rolling-window price-change stats (spot-only); one --symbol or a --symbols CSV to scan a set',
      options: {
        market: marketOpt,
        symbol: { type: 'string', short: 's', description: 'e.g. BTCUSDC (omit when using --symbols)' },
        symbols: { type: 'string', description: 'CSV list to scan, e.g. "BTCUSDC,ETHUSDC"' },
        windowSize: { type: 'string', short: 'w', description: 'e.g. "1d", "4h" (default 1d)' },
      },
      handler: (o) => core.getRollingWindowTicker({ market: o.market || 'spot', symbol: o.symbol, symbols: o.symbols, windowSize: o.windowSize || '1d' }),
    }],
    ['compare', {
      description: 'Compare symbols side-by-side on 24h stats, ranked (--symbols CSV, --sortBy metric)',
      options: {
        market: marketOpt,
        symbols: { type: 'string', description: 'CSV list to compare, e.g. "BTCUSDC,ETHUSDC,SOLUSDC"', required: true },
        sortBy: { type: 'string', description: 'priceChangePercent (default) | priceChange | quoteVolume | volume | lastPrice' },
      },
      handler: (o) => core.compareSymbols({ market: o.market || 'futures', symbols: o.symbols, sortBy: o.sortBy || 'priceChangePercent' }),
    }],
    ['technicals', {
      description: 'Technical indicators off klines (RSI/ATR/MACD/SMA/EMA/Bollinger/VWAP + trend classification) for the exact contract — no chart',
      options: {
        market: marketOpt,
        symbol: { type: 'string', short: 's', description: 'e.g. BTCUSDC', required: true },
        interval: { type: 'string', short: 'i', description: '1m,5m,15m,1h,4h,1d,… (default 1h)' },
        limit: { type: 'string', short: 'n', description: 'Bars to analyze (min 30; default 300)' },
      },
      handler: (o) => core.getTechnicals({
        market: o.market || 'futures', symbol: o.symbol, interval: o.interval || '1h',
        limit: o.limit !== undefined ? Number(o.limit) : undefined,
      }),
    }],
    ['correlate', {
      description: 'Deep multi-symbol analysis off klines: return/volatility/Sharpe/ATR%/RSI/trend per symbol + correlation matrix + rankings (--symbols CSV, capped at 10)',
      options: {
        market: marketOpt,
        symbols: { type: 'string', description: 'CSV list to correlate, e.g. "BTCUSDC,ETHUSDC,SOLUSDC"', required: true },
        interval: { type: 'string', short: 'i', description: '1m,5m,15m,1h,4h,1d,… (default 1h)' },
        limit: { type: 'string', short: 'n', description: 'Bars per symbol (min 30; default 200)' },
      },
      handler: (o) => core.correlateSymbols({
        market: o.market || 'futures', symbols: o.symbols, interval: o.interval || '1h',
        limit: o.limit !== undefined ? Number(o.limit) : undefined,
      }),
    }],
    ['backtest', {
      description: 'Backtest a strategy off klines (no chart/orders): institutional metrics (Sharpe/Calmar/maxDD/profit-factor/expectancy/vs buy&hold). Strategies: rsi,bollinger,macd,ema_cross,supertrend,donchian,rsi_pullback,keltner,triple_ema',
      options: {
        market: marketOpt,
        symbol: { type: 'string', short: 's', description: 'e.g. BTCUSDC', required: true },
        strategy: { type: 'string', description: 'Strategy key (default ema_cross)' },
        interval: { type: 'string', short: 'i', description: '1m,5m,15m,1h,4h,1d,… (default 1h)' },
        limit: { type: 'string', short: 'n', description: 'Bars to backtest (min 60; default 500)' },
        commission: { type: 'string', description: 'Per-side commission fraction (default 0.0004)' },
        slippage: { type: 'string', description: 'Per-side slippage fraction (default 0.0005)' },
        noShort: { type: 'boolean', description: 'Long-only (disallow shorts)' },
        trades: { type: 'boolean', description: 'Include the full trade log' },
        equity: { type: 'boolean', description: 'Include the per-bar equity curve' },
      },
      handler: (o) => core.backtestStrategy({
        market: o.market || 'futures', symbol: o.symbol, strategy: o.strategy || 'ema_cross', interval: o.interval || '1h',
        limit: o.limit !== undefined ? Number(o.limit) : undefined,
        commission: o.commission !== undefined ? Number(o.commission) : undefined,
        slippage: o.slippage !== undefined ? Number(o.slippage) : undefined,
        allowShort: !o.noShort, includeTrades: !!o.trades, includeEquityCurve: !!o.equity,
      }),
    }],
    ['compare-strategies', {
      description: 'Run all 9 strategies on one symbol and rank them (--sortBy totalReturnPct|sharpe|calmar|winRatePct|profitFactor|maxDrawdownPct)',
      options: {
        market: marketOpt,
        symbol: { type: 'string', short: 's', description: 'e.g. BTCUSDC', required: true },
        interval: { type: 'string', short: 'i', description: '1m,5m,15m,1h,4h,1d,… (default 1h)' },
        limit: { type: 'string', short: 'n', description: 'Bars to backtest (min 60; default 500)' },
        commission: { type: 'string', description: 'Per-side commission fraction (default 0.0004)' },
        slippage: { type: 'string', description: 'Per-side slippage fraction (default 0.0005)' },
        noShort: { type: 'boolean', description: 'Long-only (disallow shorts)' },
        sortBy: { type: 'string', description: 'Ranking metric (default totalReturnPct)' },
      },
      handler: (o) => core.compareStrategies({
        market: o.market || 'futures', symbol: o.symbol, interval: o.interval || '1h',
        limit: o.limit !== undefined ? Number(o.limit) : undefined,
        commission: o.commission !== undefined ? Number(o.commission) : undefined,
        slippage: o.slippage !== undefined ? Number(o.slippage) : undefined,
        allowShort: !o.noShort, sortBy: o.sortBy || 'totalReturnPct',
      }),
    }],
    ['walk-forward', {
      description: 'Train/test out-of-sample consistency check with an overfitting verdict (ROBUST/MODERATE/WEAK/OVERFITTED). Fixed params — temporal robustness, not param-search overfitting',
      options: {
        market: marketOpt,
        symbol: { type: 'string', short: 's', description: 'e.g. BTCUSDC', required: true },
        strategy: { type: 'string', description: 'Strategy key (default ema_cross)' },
        interval: { type: 'string', short: 'i', description: '1m,5m,15m,1h,4h,1d,… (default 1h)' },
        limit: { type: 'string', short: 'n', description: 'Bars (min 120; default 1000)' },
        trainRatio: { type: 'string', description: 'In-sample fraction 0.1–0.95 (default 0.7)' },
        commission: { type: 'string', description: 'Per-side commission fraction (default 0.0004)' },
        slippage: { type: 'string', description: 'Per-side slippage fraction (default 0.0005)' },
        noShort: { type: 'boolean', description: 'Long-only (disallow shorts)' },
      },
      handler: (o) => core.walkForwardBacktest({
        market: o.market || 'futures', symbol: o.symbol, strategy: o.strategy || 'ema_cross', interval: o.interval || '1h',
        limit: o.limit !== undefined ? Number(o.limit) : undefined,
        trainRatio: o.trainRatio !== undefined ? Number(o.trainRatio) : undefined,
        commission: o.commission !== undefined ? Number(o.commission) : undefined,
        slippage: o.slippage !== undefined ? Number(o.slippage) : undefined,
        allowShort: !o.noShort,
      }),
    }],
    ['multi-timeframe', {
      description: 'Trend/momentum confluence across timeframes (--intervals CSV, default 15m,1h,4h,1d): per-TF trend + a bullish/bearish bias and aligned flag',
      options: {
        market: marketOpt,
        symbol: { type: 'string', short: 's', description: 'e.g. BTCUSDC', required: true },
        intervals: { type: 'string', description: 'CSV of timeframes, e.g. "15m,1h,4h,1d"' },
      },
      handler: (o) => core.getMultiTimeframe({
        market: o.market || 'futures', symbol: o.symbol,
        intervals: o.intervals ? o.intervals.split(',') : undefined,
      }),
    }],
    ['scan-signals', {
      description: 'Scan symbols for a signal (--signal oversold|overbought|bullish|bearish|breakout|breakdown) off klines; --symbols CSV (capped at 20)',
      options: {
        market: marketOpt,
        symbols: { type: 'string', description: 'CSV list to scan, e.g. "BTCUSDC,ETHUSDC,SOLUSDC"', required: true },
        signal: { type: 'string', description: 'oversold (default) | overbought | bullish | bearish | breakout | breakdown' },
        interval: { type: 'string', short: 'i', description: '1m,5m,15m,1h,4h,1d,… (default 1h)' },
      },
      handler: (o) => core.scanSignals({
        market: o.market || 'futures', symbols: o.symbols, signal: o.signal || 'oversold', interval: o.interval || '1h',
      }),
    }],
    ['candles', {
      description: 'Detect candlestick patterns off klines (doji/hammer/engulfing/star/… ) on the latest bar + last --lookback bars',
      options: {
        market: marketOpt,
        symbol: { type: 'string', short: 's', description: 'e.g. BTCUSDC', required: true },
        interval: { type: 'string', short: 'i', description: '1m,5m,15m,1h,4h,1d,… (default 1h)' },
        limit: { type: 'string', short: 'n', description: 'Bars to pull (min 10; default 100)' },
        lookback: { type: 'string', description: 'Recent bars to scan (default 5)' },
      },
      handler: (o) => core.detectCandlestickPatterns({
        market: o.market || 'futures', symbol: o.symbol, interval: o.interval || '1h',
        limit: o.limit !== undefined ? Number(o.limit) : undefined,
        lookback: o.lookback !== undefined ? Number(o.lookback) : undefined,
      }),
    }],
    ['signal', {
      description: 'Composite BUY/SELL/HOLD score off the technicals (SMA200/EMA50/MACD/RSI/VWAP/Bollinger) with confidence + reasons; --mtf folds in multi-timeframe confluence',
      options: {
        market: marketOpt,
        symbol: { type: 'string', short: 's', description: 'e.g. BTCUSDC', required: true },
        interval: { type: 'string', short: 'i', description: '1m,5m,15m,1h,4h,1d,… (default 1h)' },
        limit: { type: 'string', short: 'n', description: 'Bars to analyze (min 30; default 300)' },
        mtf: { type: 'boolean', description: 'Fold in 15m/1h/4h/1d trend confluence as an extra factor' },
      },
      handler: (o) => core.getSignal({
        market: o.market || 'futures', symbol: o.symbol, interval: o.interval || '1h',
        limit: o.limit !== undefined ? Number(o.limit) : undefined,
        mtf: !!o.mtf,
      }),
    }],
    ['depth', {
      description: 'Order book depth (public)',
      options: {
        market: marketOpt,
        symbol: { type: 'string', short: 's', description: 'e.g. BTCUSDT', required: true },
        limit: { type: 'string', short: 'n', description: 'Levels per side (default 20)' },
      },
      handler: (o) => core.getOrderBook({ market: o.market || 'futures', symbol: o.symbol, limit: o.limit !== undefined ? Number(o.limit) : undefined }),
    }],
    ['symbol-info', {
      description: 'Trading filters: tick size, step size, min notional, precision',
      options: { market: marketOpt, symbol: { type: 'string', short: 's', description: 'e.g. BTCUSDT', required: true } },
      handler: (o) => core.getSymbolInfo({ market: o.market || 'futures', symbol: o.symbol }),
    }],
    ['leverage', {
      description: 'Set leverage for a futures symbol',
      options: {
        market: marketOpt,
        symbol: { type: 'string', short: 's', description: 'e.g. BTCUSDT', required: true },
        leverage: { type: 'string', short: 'l', description: 'Integer 1-125', required: true },
        account: accountOpt,
      },
      handler: (o) => core.setLeverage({ market: o.market || 'futures', symbol: o.symbol, leverage: o.leverage !== undefined ? Number(o.leverage) : undefined, account: o.account }),
    }],
    ['margin-type', {
      description: 'Set margin type ISOLATED|CROSSED for a futures symbol',
      options: {
        market: marketOpt,
        symbol: { type: 'string', short: 's', description: 'e.g. BTCUSDT', required: true },
        marginType: { type: 'string', description: 'ISOLATED or CROSSED', required: true },
        account: accountOpt,
      },
      handler: (o) => core.setMarginType({ market: o.market || 'futures', symbol: o.symbol, marginType: o.marginType, account: o.account }),
    }],
    ['adjust-margin', {
      description: 'Add/remove margin on an ISOLATED futures position without closing it (DRY RUN unless --confirm)',
      options: {
        market: marketOpt,
        symbol: { type: 'string', short: 's', description: 'e.g. BTCUSDC', required: true },
        amount: { type: 'string', short: 'a', description: 'Margin amount to move (> 0)', required: true },
        direction: { type: 'string', short: 'd', description: "'add' (default) or 'remove'" },
        positionSide: { type: 'string', description: 'Hedge mode: LONG | SHORT (defaults to BOTH in one-way)' },
        account: accountOpt,
        confirm: { type: 'boolean', description: 'REQUIRED to actually move margin' },
      },
      handler: (o) => core.adjustIsolatedMargin({
        market: o.market || 'futures', symbol: o.symbol, amount: Number(o.amount),
        direction: o.direction || 'add', positionSide: o.positionSide, account: o.account, confirm: !!o.confirm,
      }),
    }],
    ['bracket', {
      description: 'Place entry + stop + take-profit(s) in one shot (DRY RUN unless --confirm)',
      options: {
        market: marketOpt,
        symbol: { type: 'string', short: 's', description: 'e.g. BTCUSDC', required: true },
        side: { type: 'string', description: 'BUY (long) or SELL (short)', required: true },
        quantity: { type: 'string', short: 'q', description: 'Position size in base asset', required: true },
        entryType: { type: 'string', description: 'MARKET or LIMIT (default MARKET)' },
        entryPrice: { type: 'string', description: 'Required for LIMIT entry' },
        noPostOnly: { type: 'boolean', description: 'Disable default post-only on a LIMIT entry' },
        allowTaker: { type: 'boolean', description: 'Permit taker legs: stop, market take-profits, MARKET entry' },
        noEntry: { type: 'boolean', description: 'Attach stop/TPs to an EXISTING position (skip the entry leg)' },
        hedge: { type: 'boolean', description: 'Force Hedge Mode (positionSide on every leg). Default: auto-detect on --confirm' },
        oneWay: { type: 'boolean', description: 'Force one-way mode (no positionSide)' },
        noRound: { type: 'boolean', description: 'Do not snap leg prices/qty to tick/step size' },
        stop: { type: 'string', description: 'Stop trigger price (STOP_MARKET, closes position)' },
        tp: { type: 'string', multiple: true, description: 'Take-profit "price" or "price:qty"; repeat for multiple TPs' },
        account: accountOpt,
        confirm: { type: 'boolean', description: 'REQUIRED to actually place the bracket' },
      },
      handler: (o) => {
        const raw = Array.isArray(o.tp) ? o.tp : (o.tp ? [o.tp] : []);
        const takeProfits = raw.map((s) => {
          const [p, q] = String(s).split(':');
          return { price: Number(p), quantity: q !== undefined ? Number(q) : undefined };
        });
        return core.placeBracket({
          market: o.market || 'futures',
          symbol: o.symbol,
          side: o.side,
          quantity: o.quantity !== undefined ? Number(o.quantity) : undefined,
          includeEntry: !o.noEntry,
          entryType: o.entryType || 'MARKET',
          entryPrice: o.entryPrice !== undefined ? Number(o.entryPrice) : undefined,
          postOnly: !o.noPostOnly,
          allowTaker: !!o.allowTaker,
          hedge: o.hedge ? true : (o.oneWay ? false : undefined),
          round: !o.noRound,
          stopPrice: o.stop !== undefined ? Number(o.stop) : undefined,
          takeProfits,
          account: o.account,
          confirm: !!o.confirm,
        });
      },
    }],
    ['mirror-order', {
      description: 'Mirror one order across accounts, sized by balance ratio (DRY RUN unless --confirm)',
      options: {
        market: marketOpt,
        symbol: { type: 'string', short: 's', description: 'e.g. BTCUSDT', required: true },
        side: { type: 'string', description: 'BUY or SELL', required: true },
        type: { type: 'string', short: 't', description: 'MARKET|LIMIT|STOP|STOP_MARKET|TAKE_PROFIT|TAKE_PROFIT_MARKET (default MARKET)' },
        quantity: { type: 'string', short: 'q', description: 'Base-account quantity; mirrors scaled from this', required: true },
        price: { type: 'string', short: 'p', description: 'Limit price (LIMIT/STOP/TAKE_PROFIT)' },
        stopPrice: { type: 'string', description: 'Trigger price (required for stop/TP types)' },
        noPostOnly: { type: 'boolean', description: 'Disable the default post-only' },
        allowTaker: { type: 'boolean', description: 'Permit taker-only types: MARKET / STOP_MARKET / TAKE_PROFIT_MARKET' },
        timeInForce: { type: 'string', description: 'GTC | IOC | FOK | GTX' },
        positionSide: { type: 'string', description: 'Hedge mode: LONG | SHORT | BOTH' },
        noRound: { type: 'boolean', description: 'Do not snap price/qty to tick/step size' },
        accounts: { type: 'string', description: 'Comma-separated account ids; first is base. Default "1,2"' },
        marginAsset: { type: 'string', description: 'Asset whose balance ratio scales the mirror (default USDT)' },
        confirm: { type: 'boolean', description: 'REQUIRED to actually place orders on all accounts' },
      },
      handler: (o) => core.mirrorOrder({
        market: o.market || 'futures',
        symbol: o.symbol,
        side: o.side,
        type: o.type || 'MARKET',
        quantity: o.quantity !== undefined ? Number(o.quantity) : undefined,
        price: o.price !== undefined ? Number(o.price) : undefined,
        stopPrice: o.stopPrice !== undefined ? Number(o.stopPrice) : undefined,
        postOnly: !o.noPostOnly,
        allowTaker: !!o.allowTaker,
        timeInForce: o.timeInForce,
        positionSide: o.positionSide,
        round: !o.noRound,
        accounts: o.accounts ? String(o.accounts).split(',').map((s) => s.trim()).filter(Boolean) : undefined,
        marginAsset: o.marginAsset,
        confirm: !!o.confirm,
      }),
    }],
    ['mirror-bracket', {
      description: 'Mirror an entry+stop+TP bracket across accounts, sized by balance ratio (DRY RUN unless --confirm)',
      options: {
        market: marketOpt,
        symbol: { type: 'string', short: 's', description: 'e.g. BTCUSDC', required: true },
        side: { type: 'string', description: 'BUY (long) or SELL (short)', required: true },
        quantity: { type: 'string', short: 'q', description: 'Base-account position size; mirrors scaled from this', required: true },
        entryType: { type: 'string', description: 'MARKET or LIMIT (default MARKET)' },
        entryPrice: { type: 'string', description: 'Required for LIMIT entry' },
        noPostOnly: { type: 'boolean', description: 'Disable default post-only on a LIMIT entry' },
        allowTaker: { type: 'boolean', description: 'Permit taker legs: stop, market take-profits, MARKET entry' },
        noEntry: { type: 'boolean', description: 'Attach stop/TPs to an EXISTING position (skip the entry leg)' },
        hedge: { type: 'boolean', description: 'Force Hedge Mode. Default: auto-detect on --confirm' },
        oneWay: { type: 'boolean', description: 'Force one-way mode (no positionSide)' },
        noRound: { type: 'boolean', description: 'Do not snap leg prices/qty to tick/step size' },
        stop: { type: 'string', description: 'Stop trigger price (STOP_MARKET, closes position)' },
        tp: { type: 'string', multiple: true, description: 'Take-profit "price" or "price:qty"; repeat for multiple TPs' },
        accounts: { type: 'string', description: 'Comma-separated account ids; first is base. Default "1,2"' },
        marginAsset: { type: 'string', description: 'Asset whose balance ratio scales the mirror (default USDT)' },
        confirm: { type: 'boolean', description: 'REQUIRED to actually place the brackets on all accounts' },
      },
      handler: (o) => {
        const raw = Array.isArray(o.tp) ? o.tp : (o.tp ? [o.tp] : []);
        const takeProfits = raw.map((s) => {
          const [p, q] = String(s).split(':');
          return { price: Number(p), quantity: q !== undefined ? Number(q) : undefined };
        });
        return core.mirrorBracket({
          market: o.market || 'futures',
          symbol: o.symbol,
          side: o.side,
          quantity: o.quantity !== undefined ? Number(o.quantity) : undefined,
          includeEntry: !o.noEntry,
          entryType: o.entryType || 'MARKET',
          entryPrice: o.entryPrice !== undefined ? Number(o.entryPrice) : undefined,
          postOnly: !o.noPostOnly,
          allowTaker: !!o.allowTaker,
          hedge: o.hedge ? true : (o.oneWay ? false : undefined),
          round: !o.noRound,
          stopPrice: o.stop !== undefined ? Number(o.stop) : undefined,
          takeProfits,
          accounts: o.accounts ? String(o.accounts).split(',').map((s) => s.trim()).filter(Boolean) : undefined,
          marginAsset: o.marginAsset,
          confirm: !!o.confirm,
        });
      },
    }],
    ['position-mode', {
      description: 'Show whether the futures account is in Hedge Mode or one-way',
      options: { market: marketOpt, account: accountOpt },
      handler: (o) => core.getPositionMode({ market: o.market || 'futures', account: o.account }),
    }],
    ['set-position-mode', {
      description: 'Switch the futures account between Hedge Mode and one-way (idempotent)',
      options: {
        market: marketOpt,
        hedge: { type: 'boolean', description: 'Set Hedge Mode (LONG/SHORT positions)' },
        oneWay: { type: 'boolean', description: 'Set one-way mode' },
        account: accountOpt,
      },
      handler: (o) => {
        if (o.hedge === o.oneWay) throw new Error('Pass exactly one of --hedge or --oneWay');
        return core.setPositionMode({ market: o.market || 'futures', hedgeMode: !!o.hedge, account: o.account });
      },
    }],
    ['leverage-brackets', {
      description: 'Leverage/margin tiers (max leverage + maint-margin steps per notional)',
      options: { market: marketOpt, symbol: { type: 'string', short: 's', description: 'e.g. BTCUSDC (optional)' }, account: accountOpt },
      handler: (o) => core.getLeverageBrackets({ market: o.market || 'futures', symbol: o.symbol, account: o.account }),
    }],
    ['server-time', {
      description: 'Show local-vs-Binance clock offset (signed requests auto-correct on -1021)',
      options: { market: marketOpt },
      handler: (o) => core.getServerTime({ market: o.market || 'futures' }),
    }],
    ['commission', {
      description: 'Show maker/taker commission rate for a symbol',
      options: { market: marketOpt, symbol: { type: 'string', short: 's', description: 'e.g. BTCUSDC', required: true }, account: accountOpt },
      handler: (o) => core.getCommissionRate({ market: o.market || 'futures', symbol: o.symbol, account: o.account }),
    }],
    ['transfer', {
      description: 'Move an asset between wallets via Universal Transfer (DRY RUN unless --confirm)',
      options: {
        asset: { type: 'string', short: 'a', description: 'e.g. USDC', required: true },
        amount: { type: 'string', short: 'q', description: 'Amount to transfer', required: true },
        from: { type: 'string', description: 'Source wallet: spot | futures (usdm) | coinm (default futures)' },
        to: { type: 'string', description: 'Destination wallet: spot | futures | coinm (default spot)' },
        account: accountOpt,
        confirm: { type: 'boolean', description: 'REQUIRED to actually move funds' },
      },
      handler: (o) => core.transfer({
        asset: o.asset,
        amount: o.amount !== undefined ? Number(o.amount) : undefined,
        from: o.from || 'futures',
        to: o.to || 'spot',
        account: o.account,
        confirm: !!o.confirm,
      }),
    }],
    ['transfer-history', {
      description: 'Recent universal transfers for a wallet pair',
      options: {
        from: { type: 'string', description: 'Source wallet (default futures)' },
        to: { type: 'string', description: 'Destination wallet (default spot)' },
        size: { type: 'string', short: 'n', description: 'Rows to return (1-100, default 10)' },
        account: accountOpt,
      },
      handler: (o) => core.getTransferHistory({ from: o.from || 'futures', to: o.to || 'spot', size: o.size !== undefined ? Number(o.size) : undefined, account: o.account }),
    }],
    ['deposit-history', {
      description: 'On-chain deposit history (signed, read-only)',
      options: {
        coin: { type: 'string', short: 'a', description: 'Asset, e.g. USDC (omit for all)' },
        status: { type: 'string', description: 'Binance status code: 0 pending, 6 credited-cannot-withdraw, 1 success' },
        startTime: { type: 'string', description: 'Start time in ms since epoch' },
        endTime: { type: 'string', description: 'End time in ms since epoch' },
        offset: { type: 'string' },
        limit: { type: 'string', short: 'n', description: 'Max rows (default 100, max 1000)' },
        account: accountOpt,
      },
      handler: (o) => core.getDepositHistory({
        coin: o.coin, status: o.status !== undefined ? Number(o.status) : undefined,
        startTime: o.startTime !== undefined ? Number(o.startTime) : undefined,
        endTime: o.endTime !== undefined ? Number(o.endTime) : undefined,
        offset: o.offset !== undefined ? Number(o.offset) : undefined,
        limit: o.limit !== undefined ? Number(o.limit) : undefined, account: o.account,
      }),
    }],
    ['withdraw-history', {
      description: 'Withdrawal history (signed, read-only)',
      options: {
        coin: { type: 'string', short: 'a', description: 'Asset, e.g. USDC (omit for all)' },
        status: { type: 'string', description: 'Binance status code: 0 email-sent, 1 cancelled, 2 awaiting-approval, 4 processing, 5 failure, 6 completed' },
        startTime: { type: 'string', description: 'Start time in ms since epoch' },
        endTime: { type: 'string', description: 'End time in ms since epoch' },
        offset: { type: 'string' },
        limit: { type: 'string', short: 'n', description: 'Max rows (default 100, max 1000)' },
        account: accountOpt,
      },
      handler: (o) => core.getWithdrawHistory({
        coin: o.coin, status: o.status !== undefined ? Number(o.status) : undefined,
        startTime: o.startTime !== undefined ? Number(o.startTime) : undefined,
        endTime: o.endTime !== undefined ? Number(o.endTime) : undefined,
        offset: o.offset !== undefined ? Number(o.offset) : undefined,
        limit: o.limit !== undefined ? Number(o.limit) : undefined, account: o.account,
      }),
    }],
    ['deposit-address', {
      description: 'Deposit address for a coin (signed, read-only)',
      options: {
        coin: { type: 'string', short: 'a', description: 'Asset, e.g. USDC', required: true },
        network: { type: 'string', description: 'Network, e.g. BSC, ETH, TRX, BNB (omit for default)' },
        account: accountOpt,
      },
      handler: (o) => core.getDepositAddress({ coin: o.coin, network: o.network, account: o.account }),
    }],
  ]),
});
