import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/morning.js';

export function registerMorningTools(server) {
  server.tool(
    'morning_brief',
    'Scan watchlist symbols from rules.json and return structured data for a daily session brief.',
    {
      rules_path: z.string().optional().describe('Optional rules.json path. Defaults to project rules.json, then ~/.tradingview-mcp/rules.json.'),
    },
    async ({ rules_path } = {}) => {
      try {
        return jsonResult(await core.runBrief({ rules_path }));
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    },
  );

  server.tool(
    'session_save',
    'Save a generated session brief to ~/.tradingview-mcp/sessions/YYYY-MM-DD.json.',
    {
      brief: z.string().describe('Session brief text to store.'),
      date: z.string().optional().describe('Date (YYYY-MM-DD). Defaults to today.'),
    },
    async ({ brief, date } = {}) => {
      try {
        return jsonResult(core.saveSession({ brief, date }));
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    },
  );

  server.tool(
    'session_get',
    'Load a saved session brief. Returns the requested day if present; otherwise tries previous day.',
    {
      date: z.string().optional().describe('Date (YYYY-MM-DD). Defaults to today.'),
    },
    async ({ date } = {}) => {
      try {
        return jsonResult(core.getSession({ date }));
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    },
  );
}

