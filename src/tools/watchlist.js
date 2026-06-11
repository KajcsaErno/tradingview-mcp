import {z} from 'zod';
import {jsonResult, registerTool} from './_format.js';
import * as core from '../core/watchlist.js';

export function registerWatchlistTools(server) {
    registerTool(server, 'watchlist_get', 'Get all symbols from the current TradingView watchlist with last price, change, and change%', {}, () => core.get());

  server.tool('watchlist_add', 'Add a symbol to the TradingView watchlist', {
    symbol: z.string().describe('Symbol to add (e.g., AAPL, BTCUSD, ES1!, NYMEX:CL1!)'),
  }, async ({ symbol }) => {
    try { return jsonResult(await core.add({ symbol })); }
    catch (err) {
      // Try to close any open search/input on error
      try {
        const { getClient } = await import('../connection.js');
        const c = await getClient();
        await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      } catch { /* best-effort cleanup; the original error below is what matters */
      }
      return jsonResult({ success: false, error: err.message }, true);
    }
  });
}
