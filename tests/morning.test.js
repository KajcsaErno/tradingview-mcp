import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {join, parse} from 'node:path';
import {fileURLToPath} from 'node:url';
import {getSession, runBrief, saveSession} from '../src/core/morning.js';

// A path outside both PROJECT_ROOT and the user-data dir on any platform —
// filesystem root + a folder that can't be inside the repo ('/outside-repo/...'
// on POSIX, 'C:\\outside-repo\\...' on Windows).
const OUTSIDE_REPO_PATH = join(parse(process.cwd()).root, 'outside-repo', 'rules.json');

function makeMemoryFs() {
  const files = new Map();
  return {
    existsSync: (path) => files.has(path),
    readFileSync: (path) => {
      if (!files.has(path)) throw new Error(`ENOENT: ${path}`);
      return files.get(path);
    },
    writeFileSync: (path, content) => {
      files.set(path, String(content));
    },
    mkdirSync: () => {},
    files,
  };
}

describe('morning core', () => {
  it('runBrief scans watchlist symbols and restores original chart state', async () => {
    const fs = makeMemoryFs();
      // Inside the real repo root on any machine/OS — assertSafeRulesPath only
      // allows paths under PROJECT_ROOT or the user-data dir.
      const rulesPath = fileURLToPath(new URL('../rules.json', import.meta.url));
    fs.writeFileSync(rulesPath, JSON.stringify({
      watchlist: ['BTCUSD', 'ETHUSD'],
      default_timeframe: '240',
      bias_criteria: { bullish: ['x'] },
    }));

    const symbolCalls = [];
    const timeframeCalls = [];

    const chartApi = {
      getState: async () => ({ success: true, symbol: 'AAPL', resolution: '60' }),
      setSymbol: async ({ symbol }) => {
        symbolCalls.push(symbol);
        return { success: true };
      },
      setTimeframe: async ({ timeframe }) => {
        timeframeCalls.push(timeframe);
        return { success: true };
      },
    };

    const dataApi = {
      getStudyValues: async () => ({ success: true, values: [{ name: 'RSI', value: 52 }] }),
      getQuote: async () => ({ success: true, close: 101.5 }),
    };

    const result = await runBrief({
      rules_path: rulesPath,
      _deps: {
        ...fs,
        chartApi,
        dataApi,
        homedir: () => 'C:/Users/tester',
        now: () => new Date('2026-06-06T08:30:00Z'),
      },
    });

    assert.equal(result.success, true);
    assert.equal(result.symbols_scanned.length, 2);
    assert.deepEqual(symbolCalls, ['BTCUSD', 'ETHUSD', 'AAPL']);
    assert.deepEqual(timeframeCalls, ['240', '240', '60']);
  });

  it('runBrief rejects unsafe rules_path locations', async () => {
    await assert.rejects(
      () => runBrief({
        rules_path: OUTSIDE_REPO_PATH,
        _deps: {
          homedir: () => 'C:/Users/tester',
          existsSync: () => true,
          readFileSync: () => '{}',
        },
      }),
      /rules_path must be inside/,
    );
  });

  it('saveSession writes a dated record and getSession reads it back', () => {
    const fs = makeMemoryFs();
    const deps = {
      ...fs,
      homedir: () => 'C:/Users/tester',
      now: () => new Date('2026-06-06T09:00:00Z'),
    };

    const saved = saveSession({ brief: 'Bias: neutral', _deps: deps });
    assert.equal(saved.success, true);

    const loaded = getSession({ date: '2026-06-06', _deps: deps });
    assert.equal(loaded.success, true);
    assert.equal(loaded.brief, 'Bias: neutral');
  });

  it('getSession falls back to previous day when requested day is missing', () => {
    const fs = makeMemoryFs();
    const deps = {
      ...fs,
      homedir: () => 'C:/Users/tester',
      now: () => new Date('2026-06-06T11:00:00Z'),
    };

    saveSession({ brief: 'Yesterday brief', date: '2026-06-05', _deps: deps });
    const loaded = getSession({ date: '2026-06-06', _deps: deps });
    assert.equal(loaded.success, true);
    assert.equal(loaded.brief, 'Yesterday brief');
    assert.equal(typeof loaded.note, 'string');
  });
});

