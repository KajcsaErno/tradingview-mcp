import {z} from 'zod';
import {jsonResult, registerTool} from './_format.js';
import * as core from '../core/data.js';

export function registerDataTools(server) {
    registerTool(server, 'data_get_ohlcv', 'Get OHLCV bar data from the chart. Use summary=true for compact stats instead of all bars (saves context).', {
    count: z.coerce.number().optional().describe('Number of bars to retrieve (max 500, default 100)'),
    summary: z.coerce.boolean().optional().describe('Return summary stats (high, low, open, close, avg volume, range) instead of all bars — much smaller output'),
    }, ({count, summary}) => core.getOhlcv({count, summary}));

    registerTool(server, 'data_get_indicator', 'Get indicator/study info and input values', {
    entity_id: z.string().describe('Study entity ID (from chart_get_state)'),
    }, ({entity_id}) => core.getIndicator({entity_id}));

    registerTool(server, 'data_get_strategy_results', 'Get strategy performance metrics from Strategy Tester', {}, () => core.getStrategyResults());

    registerTool(server, 'data_get_trades', 'Get trade list from Strategy Tester', {
    max_trades: z.coerce.number().optional().describe('Maximum trades to return'),
    }, ({max_trades}) => core.getTrades({max_trades}));

    registerTool(server, 'data_get_equity', 'Get equity curve data from Strategy Tester', {}, () => core.getEquity());

    registerTool(server, 'quote_get', 'Get real-time quote data for a symbol (price, OHLC, volume)', {
    symbol: z.string().optional().describe('Symbol to quote (blank = current chart symbol)'),
    }, ({symbol}) => core.getQuote({symbol}));

  server.tool('depth_get', 'Get order book / DOM (Depth of Market) data from the chart', {}, async () => {
    try { return jsonResult(await core.getDepth()); }
    catch (err) { return jsonResult({ success: false, error: err.message, hint: 'Open the DOM panel in TradingView before using this tool.' }, true); }
  });

    registerTool(server, 'data_get_pine_lines', 'Read horizontal price levels drawn by Pine Script indicators (line.new). Returns deduplicated price levels per study. Use study_filter to target a specific indicator.', {
    study_filter: z.string().optional().describe('Substring to match study name (e.g., "Profiler", "NY Levels"). Omit for all.'),
    verbose: z.coerce.boolean().optional().describe('Return raw line data with IDs, coordinates, colors (default false — returns only unique price levels)'),
    }, ({study_filter, verbose}) => core.getPineLines({study_filter, verbose}));

    registerTool(server, 'data_get_pine_labels', 'Read text labels drawn by Pine Script indicators (label.new). Returns text and price pairs. Use study_filter to target a specific indicator.', {
    study_filter: z.string().optional().describe('Substring to match study name. Omit for all.'),
    max_labels: z.coerce.number().optional().describe('Max labels per study (default 50). Set higher if you need all.'),
    verbose: z.coerce.boolean().optional().describe('Return raw label data with IDs, colors, positions (default false — returns only text + price)'),
    }, ({study_filter, max_labels, verbose}) => core.getPineLabels({study_filter, max_labels, verbose}));

    registerTool(server, 'data_get_pine_tables', 'Read table data drawn by Pine Script indicators (table.new). Returns formatted text rows per table. Use study_filter to target a specific indicator.', {
    study_filter: z.string().optional().describe('Substring to match study name. Omit for all.'),
    }, ({study_filter}) => core.getPineTables({study_filter}));

    registerTool(server, 'data_get_pine_boxes', 'Read box/zone boundaries drawn by Pine Script indicators (box.new). Returns deduplicated {high, low} price zones. Use study_filter to target a specific indicator.', {
    study_filter: z.string().optional().describe('Substring to match study name. Omit for all.'),
    verbose: z.coerce.boolean().optional().describe('Return all boxes with IDs and coordinates (default false — returns unique price zones)'),
    }, ({study_filter, verbose}) => core.getPineBoxes({study_filter, verbose}));

    registerTool(server, 'data_get_study_values', 'Get current indicator values from the data window for all visible studies (RSI, MACD, Bollinger Bands, EMAs, custom indicators with plot()).', {}, () => core.getStudyValues());
}
