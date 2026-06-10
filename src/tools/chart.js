import {z} from 'zod';
import {registerTool} from './_format.js';
import * as core from '../core/chart.js';

export function registerChartTools(server) {
    registerTool(server, 'chart_get_state', 'Get current chart state (symbol, timeframe, chart type, indicators)', {}, () => core.getState());

    registerTool(server, 'chart_set_symbol', 'Change the chart symbol', {
    symbol: z.string().describe('Symbol to set (e.g., BTCUSD, AAPL, ES1!, NYMEX:CL1!)'),
    }, ({symbol}) => core.setSymbol({symbol}));

    registerTool(server, 'chart_set_timeframe', 'Change the chart timeframe/resolution', {
    timeframe: z.string().describe('Timeframe (e.g., 1, 5, 15, 60, D, W, M)'),
    }, ({timeframe}) => core.setTimeframe({timeframe}));

    registerTool(server, 'chart_set_type', 'Change chart type', {
    chart_type: z.string().describe('Chart type: Bars(0), Candles(1), Line(2), Area(3), Renko(4), Kagi(5), PointAndFigure(6), LineBreak(7), HeikinAshi(8), HollowCandles(9) — pass name or number'),
    }, ({chart_type}) => core.setType({chart_type}));

    registerTool(server, 'chart_manage_indicator', 'Add or remove an indicator/study on the chart', {
    action: z.enum(['add', 'remove']).describe('Action: add or remove'),
    indicator: z.string().describe('Full indicator name: "Relative Strength Index", "MACD", "Volume", "Moving Average", "Bollinger Bands", "Moving Average Exponential". Short names like RSI/EMA do NOT work.'),
    entity_id: z.string().optional().describe('Entity ID to remove (from chart_get_state). Required for remove.'),
    inputs: z.string().optional().describe('JSON string of input overrides for the indicator (e.g., \'{"length": 20}\')'),
    }, ({action, indicator, entity_id, inputs}) => core.manageIndicator({action, indicator, entity_id, inputs}));

    registerTool(server, 'chart_get_visible_range', 'Get the visible date range (unix timestamps) and bars range on the chart', {}, () => core.getVisibleRange());

    registerTool(server, 'chart_set_visible_range', 'Zoom the chart to a specific date range (unix timestamps)', {
    from: z.coerce.number().describe('Start of range (unix timestamp in seconds)'),
    to: z.coerce.number().describe('End of range (unix timestamp in seconds)'),
    }, ({from, to}) => core.setVisibleRange({from, to}));

    registerTool(server, 'chart_scroll_to_date', 'Jump the chart view to center on a specific date', {
    date: z.string().describe('ISO date string (e.g., "2024-01-15") or unix timestamp as a string'),
    }, ({date}) => core.scrollToDate({date}));

    registerTool(server, 'symbol_info', 'Get detailed metadata about the current symbol (name, exchange, type, description)', {}, () => core.symbolInfo());

    registerTool(server, 'symbol_search', 'Search for symbols by name or keyword', {
    query: z.string().describe('Search query (e.g., "AAPL", "crude oil", "ES")'),
    type: z.string().optional().describe('Filter by type (e.g., "stock", "futures", "crypto", "forex")'),
    }, ({query, type}) => core.symbolSearch({query, type}));
}
