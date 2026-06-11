/**
 * Morning brief workflow core logic.
 *
 * Scans symbols from rules.json, collects chart + indicator snapshots,
 * and supports saving/retrieving daily session briefs.
 */
import {existsSync as _existsSync, mkdirSync as _mkdirSync, readFileSync as _readFileSync, writeFileSync as _writeFileSync} from 'node:fs';
import {homedir as _homedir} from 'node:os';
import {dirname, isAbsolute, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import * as chart from './chart.js';
import * as data from './data.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../../');

function _resolve(deps) {
  return {
    chartApi: deps?.chartApi || chart,
    dataApi: deps?.dataApi || data,
    existsSync: deps?.existsSync || _existsSync,
    mkdirSync: deps?.mkdirSync || _mkdirSync,
    readFileSync: deps?.readFileSync || _readFileSync,
    writeFileSync: deps?.writeFileSync || _writeFileSync,
    homedir: deps?.homedir || _homedir,
    now: deps?.now || (() => new Date()),
    tvDeps: deps?.tvDeps,
  };
}

function isWithinRoot(target, root) {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function assertSafeRulesPath(rulesPath, userDataDir) {
  const resolved = resolve(rulesPath);
  const allowed = [PROJECT_ROOT, userDataDir];
  if (!allowed.some(root => isWithinRoot(resolved, root))) {
    throw new Error(
      `rules_path must be inside ${PROJECT_ROOT} or ${userDataDir}. Got: ${resolved}`,
    );
  }
}

function assertSafeDate(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    throw new Error(`Invalid date: ${dateStr}. Use YYYY-MM-DD.`);
  }
}

function toDateString(nowFn) {
  const value = nowFn();
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error('Invalid date from now()');
  return d.toISOString().slice(0, 10);
}

function getUserDataDir(homedirFn) {
  return resolve(join(homedirFn(), '.tradingview-mcp'));
}

function getSessionsDir(homedirFn) {
  return join(getUserDataDir(homedirFn), 'sessions');
}

function loadRules({ rulesPath, existsSync, readFileSync, homedir }) {
  const userDataDir = getUserDataDir(homedir);
  if (rulesPath) assertSafeRulesPath(rulesPath, userDataDir);

  const candidates = [
    rulesPath,
    join(PROJECT_ROOT, 'rules.json'),
    join(userDataDir, 'rules.json'),
  ].filter(Boolean);

  for (const filePath of candidates) {
    if (!existsSync(filePath)) continue;
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
      return { rules: parsed, path: filePath };
    } catch (err) {
      throw new Error(`Failed to parse rules.json at ${filePath}: ${err.message}`);
    }
  }

  throw new Error(
    'No rules.json found. Copy rules.example.json to rules.json and customize it.',
  );
}

function normalizeWatchlist(watchlist) {
  if (!Array.isArray(watchlist)) return [];
  return watchlist
    .map(item => String(item || '').trim())
    .filter(Boolean);
}

export async function runBrief({ rules_path, _deps } = {}) {
  const deps = _resolve(_deps);
  const { rules, path } = loadRules({
    rulesPath: rules_path,
    existsSync: deps.existsSync,
    readFileSync: deps.readFileSync,
    homedir: deps.homedir,
  });

  const watchlist = normalizeWatchlist(rules.watchlist);
  if (watchlist.length === 0) {
    throw new Error('rules.json watchlist is empty. Add at least one symbol.');
  }

  const timeframe = String(rules.default_timeframe || '240');
  let originalState = null;

  try {
    originalState = await deps.chartApi.getState({ _deps: deps.tvDeps });
  } catch {
    // Best effort only; morning brief still runs if state fetch fails.
  }

  const symbols_scanned = [];

  try {
    for (const symbol of watchlist) {
      try {
        await deps.chartApi.setSymbol({ symbol, _deps: deps.tvDeps });
        await deps.chartApi.setTimeframe({ timeframe, _deps: deps.tvDeps });

        const [state, indicators, quote] = await Promise.all([
          deps.chartApi.getState({ _deps: deps.tvDeps }),
          deps.dataApi.getStudyValues({ _deps: deps.tvDeps }),
          deps.dataApi.getQuote({ _deps: deps.tvDeps }),
        ]);

        symbols_scanned.push({ symbol, timeframe, state, indicators, quote });
      } catch (err) {
        symbols_scanned.push({ symbol, timeframe, success: false, error: err.message });
      }
    }
  } finally {
    if (originalState?.symbol) {
      try {
        await deps.chartApi.setSymbol({ symbol: originalState.symbol, _deps: deps.tvDeps });
        if (originalState.resolution) {
          await deps.chartApi.setTimeframe({ timeframe: String(originalState.resolution), _deps: deps.tvDeps });
        }
      } catch {
        // Ignore restore failures to avoid masking useful scan output.
      }
    }
  }

  return {
    success: true,
    generated_at: deps.now().toISOString(),
    rules_loaded_from: path,
    rules: {
      bias_criteria: rules.bias_criteria || null,
      risk_rules: rules.risk_rules || null,
      notes: rules.notes || null,
    },
    symbols_scanned,
    instruction: 'Apply bias_criteria to each symbol and output: SYMBOL | BIAS | KEY LEVEL | WATCH. End with one-line overall market read.',
  };
}

export function saveSession({ brief, date, _deps } = {}) {
  const deps = _resolve(_deps);
  const dateStr = date || toDateString(deps.now);
  assertSafeDate(dateStr);

  const sessionsDir = getSessionsDir(deps.homedir);
  deps.mkdirSync(sessionsDir, { recursive: true });

  const filePath = join(sessionsDir, `${dateStr}.json`);
  const payload = {
    date: dateStr,
    saved_at: deps.now().toISOString(),
    brief: String(brief || ''),
  };

  deps.writeFileSync(filePath, JSON.stringify(payload, null, 2));
  return { success: true, path: filePath, date: dateStr };
}

export function getSession({ date, _deps } = {}) {
  const deps = _resolve(_deps);
  const dateStr = date || toDateString(deps.now);
  assertSafeDate(dateStr);

  const sessionsDir = getSessionsDir(deps.homedir);
  const todayPath = join(sessionsDir, `${dateStr}.json`);

  if (deps.existsSync(todayPath)) {
    return { success: true, ...JSON.parse(deps.readFileSync(todayPath, 'utf8')) };
  }

  const baseDate = new Date(`${dateStr}T00:00:00Z`);
  baseDate.setUTCDate(baseDate.getUTCDate() - 1);
  const yesterday = baseDate.toISOString().slice(0, 10);
  const yesterdayPath = join(sessionsDir, `${yesterday}.json`);

  if (deps.existsSync(yesterdayPath)) {
    return {
      success: true,
      note: 'No session for requested day; returning previous day.',
      ...JSON.parse(deps.readFileSync(yesterdayPath, 'utf8')),
    };
  }

  return {
    success: false,
    error: `No session found for ${dateStr} or ${yesterday}`,
    sessions_dir: sessionsDir,
  };
}

