import {z} from 'zod';
import {jsonResult, registerTool} from './_format.js';
import * as core from '../core/health.js';

export function registerHealthTools(server) {
  server.tool('tv_health_check', 'Check CDP connection to TradingView and return current chart state', {}, async () => {
    try { return jsonResult(await core.healthCheck()); }
    catch (err) { return jsonResult({ success: false, error: err.message, hint: 'TradingView is not running with CDP enabled. Use the tv_launch tool to start it automatically.' }, true); }
  });

    registerTool(server, 'tv_discover', 'Report which known TradingView API paths are available and their methods', {}, () => core.discover());

    registerTool(server, 'tv_ui_state', 'Get current UI state: which panels are open, what buttons are visible/enabled/disabled', {}, () => core.uiState());

    registerTool(server, 'tv_launch', 'Launch TradingView Desktop with Chrome DevTools Protocol (remote debugging) enabled. Auto-detects install location on Mac, Windows, and Linux.', {
    port: z.coerce.number().optional().describe('CDP port (default 9222)'),
    kill_existing: z.coerce.boolean().optional().describe('Kill existing TradingView instances first (default true)'),
    }, ({port, kill_existing}) => core.launch({port, kill_existing}));
}
