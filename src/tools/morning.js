import {z} from 'zod';
import {registerTool} from './_format.js';
import * as core from '../core/morning.js';

export function registerMorningTools(server) {
    registerTool(
        server,
    'morning_brief',
    'Scan watchlist symbols from rules.json and return structured data for a daily session brief.',
    {
      rules_path: z.string().optional().describe('Optional rules.json path. Defaults to project rules.json, then ~/.tradingview-mcp/rules.json.'),
    },
        ({rules_path} = {}) => core.runBrief({rules_path}),
  );

    registerTool(
        server,
    'session_save',
    'Save a generated session brief to ~/.tradingview-mcp/sessions/YYYY-MM-DD.json.',
    {
      brief: z.string().describe('Session brief text to store.'),
      date: z.string().optional().describe('Date (YYYY-MM-DD). Defaults to today.'),
    },
        ({brief, date} = {}) => core.saveSession({brief, date}),
  );

    registerTool(
        server,
    'session_get',
    'Load a saved session brief. Returns the requested day if present; otherwise tries previous day.',
    {
      date: z.string().optional().describe('Date (YYYY-MM-DD). Defaults to today.'),
    },
        ({date} = {}) => core.getSession({date}),
  );
}
