import {z} from 'zod';
import {jsonResult, registerTool} from './_format.js';
import * as core from '../core/pine.js';

export function registerPineTools(server) {
    registerTool(server, 'pine_get_source', 'Get current Pine Script source code from the editor', {}, () => core.getSource());

    registerTool(server, 'pine_set_source', 'Set Pine Script source code in the editor', {
    source: z.string().describe('Pine Script source code to inject'),
    }, ({source}) => core.setSource({source}));

    registerTool(server, 'pine_compile', 'Compile / add the current Pine Script to the chart', {}, () => core.compile());

    registerTool(server, 'pine_get_errors', 'Get Pine Script compilation errors from Monaco markers', {}, () => core.getErrors());

    registerTool(server, 'pine_save', 'Save the current Pine Script (Ctrl+S)', {}, () => core.save());

    registerTool(server, 'pine_get_console', 'Read Pine Script console/log output (compile messages, log.info(), errors)', {}, () => core.getConsole());

    registerTool(server, 'pine_smart_compile', 'Intelligent compile: detects button, compiles, checks errors, reports study changes', {}, () => core.smartCompile());

    registerTool(server, 'pine_new', 'Create a new blank Pine Script', {
    type: z.enum(['indicator', 'strategy', 'library']).describe('Type of script to create'),
    }, ({type}) => core.newScript({type}));

  server.tool('pine_open', 'Open a saved Pine Script by name', {
    name: z.string().describe('Name of the saved script to open (case-insensitive match)'),
  }, async ({ name }) => {
    try { return jsonResult(await core.openScript({ name })); }
    catch (err) { return jsonResult({ success: false, source: 'internal_api', error: err.message }, true); }
  });

    registerTool(server, 'pine_list_scripts', 'List saved Pine Scripts', {}, () => core.listScripts());

    registerTool(server, 'pine_analyze', 'Run static analysis on Pine Script code WITHOUT compiling — catches array out-of-bounds, unguarded array.first()/last(), bad loop bounds, and implicit bool casts. Works offline, no TradingView connection needed.', {
    source: z.string().describe('Pine Script source code to analyze'),
    }, ({source}) => core.analyze({source}));

    registerTool(server, 'pine_check', 'Compile Pine Script via TradingView\'s server API without needing the chart open. Returns compilation errors/warnings. Useful for validating code before injecting into the chart.', {
    source: z.string().describe('Pine Script source code to compile/validate'),
    }, ({source}) => core.check({source}));
}
