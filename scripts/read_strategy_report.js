// Reads the Strategy Tester report for a named strategy on the active chart.
// Works around data_get_strategy_results returning {} for overlay=true strategies
// by reading study._reportData directly. Optionally loads more history first.
//
// Usage: node scripts/read_strategy_report.js [--name "Adaptive Trend Rider"] [--more 2000] [--timeframe 60]
import { evaluate, disconnect } from '../src/connection.js';
import { waitForChartReady } from '../src/wait.js';
import { setTimeframe } from '../src/core/chart.js';

const args = process.argv.slice(2);
function flag(name, def) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
}
const name = flag('name', 'Adaptive Trend Rider');
const more = parseInt(flag('more', '0'), 10);
const timeframe = flag('timeframe', null);
const wantTrades = args.includes('--trades');

try {
  if (timeframe) {
    await setTimeframe({ timeframe });
    await waitForChartReady(null, null, 30000);
  }
  if (more > 0) {
    await evaluate(`window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().model().mainSeries().requestMoreData(${more})`);
    await new Promise((r) => setTimeout(r, 5000));
    await waitForChartReady(null, null, 30000);
    // strategy recalc after history load takes a moment
    await new Promise((r) => setTimeout(r, 4000));
  }
  const expr = `(function(){
    var srcs = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().model().dataSources();
    var strat = null;
    for (var i = 0; i < srcs.length; i++) {
      var s = srcs[i];
      try {
        if (s.metaInfo && s.metaInfo() && (s.metaInfo().description || '').indexOf(${JSON.stringify(name)}) >= 0) { strat = s; break; }
      } catch (e) {}
    }
    if (!strat) return JSON.stringify({ error: 'strategy not found' });
    var rd = strat._reportData;
    if (rd && typeof rd.value === 'function') rd = rd.value();
    if (!rd || !rd.performance) return JSON.stringify({ error: 'no report data yet' });
    var p = rd.performance, a = p.all || {};
    if (${wantTrades}) {
      var trades = (rd.trades || []).map(function (t) {
        return {
          en: new Date(t.e.tm).toISOString().slice(0, 10),
          ex: t.x && t.x.tm ? new Date(t.x.tm).toISOString().slice(0, 10) : 'open',
          cumEquity: Math.round(t.cp.v),
          pricePct: Math.round(t.tp.p * 1000) / 10,
          exitWhy: t.x ? t.x.c : ''
        };
      });
      return JSON.stringify({ tradeCount: trades.length, trades: trades });
    }
    var bars = null;
    try { bars = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().model().mainSeries().bars().size(); } catch (e) {}
    return JSON.stringify({
      barsLoaded: bars,
      netProfit: a.netProfit,
      netProfitPercent: a.netProfitPercent,
      totalTrades: a.totalTrades,
      percentProfitable: a.percentProfitable,
      profitFactor: a.profitFactor,
      avgTrade: a.avgTrade,
      avgTradePercent: a.avgTradePercent,
      maxDrawDownPercent: p.maxStrategyDrawDownPercent,
      sharpe: p.sharpeRatio,
      sortino: p.sortinoRatio,
      grossProfit: a.grossProfit,
      grossLoss: a.grossLoss,
      longTrades: (p.long || {}).totalTrades,
      shortTrades: (p.short || {}).totalTrades,
      longNetProfitPercent: (p.long || {}).netProfitPercent,
      shortNetProfitPercent: (p.short || {}).netProfitPercent
    });
  })()`;
  const res = await evaluate(expr);
  console.log(typeof res === 'string' ? res : JSON.stringify(res));
} catch (err) {
  console.error(JSON.stringify({ error: err.message }));
  process.exitCode = 1;
} finally {
  await disconnect().catch(() => {});
}
