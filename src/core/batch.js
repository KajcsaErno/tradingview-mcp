/**
 * Core batch execution logic.
 */
import {evaluate, evaluateAsync, getChartApi, getChartCollection, getClient, safeString} from '../connection.js';
import {waitForChartReady} from '../wait.js';
import {mkdirSync, writeFileSync} from 'fs';
import {dirname, join} from 'path';
import {fileURLToPath} from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = join(dirname(dirname(__dirname)), 'screenshots');

async function batchSetSymbol(colPath, apiPath, symbol) {
    if (colPath) await evaluate(`${colPath}.setSymbol(${safeString(symbol)})`);
    else if (apiPath) await evaluate(`${apiPath}.setSymbol(${safeString(symbol)})`);
}

async function batchSetResolution(colPath, apiPath, tf) {
    if (colPath) await evaluate(`${colPath}.setResolution(${safeString(tf)})`);
    else if (apiPath) await evaluate(`${apiPath}.setResolution(${safeString(tf)})`);
}

async function screenshotAction(symbol, tf) {
    mkdirSync(SCREENSHOT_DIR, {recursive: true});
    const client = await getClient();
    const {data} = await client.Page.captureScreenshot({format: 'png'});
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const fname = `batch_${symbol}_${tf || 'default'}_${ts}`.replace(/[\/\\]/g, '_') + '.png';
    const filePath = join(SCREENSHOT_DIR, fname);
    writeFileSync(filePath, Buffer.from(data, 'base64'));
    return {file_path: filePath};
}

async function ohlcvAction(apiPath, ohlcv_count) {
    const limit = Math.min(ohlcv_count || 100, 500);
    return evaluateAsync(`
            new Promise(function(resolve, reject) {
              ${apiPath}.exportData({ includeTime: true, includeSeries: true, includeStudies: false })
                .then(function(result) {
                  var bars = (result.data || []).slice(-${limit});
                  resolve({ bar_count: bars.length, last_bar: bars[bars.length - 1] || null });
                }).catch(reject);
            })
          `);
}

async function strategyResultsAction() {
    await new Promise(r => setTimeout(r, 1000));
    return evaluate(`
            (function() {
              var metrics = {};
              var panel = document.querySelector('[data-name="backtesting"]') || document.querySelector('[class*="strategyReport"]');
              if (!panel) return { error: 'Strategy Tester not found' };
              var items = panel.querySelectorAll('[class*="reportItem"], [class*="metric"]');
              items.forEach(function(item) {
                var label = item.querySelector('[class*="label"]');
                var value = item.querySelector('[class*="value"]');
                if (label && value) metrics[label.textContent.trim()] = value.textContent.trim();
              });
              return { metric_count: Object.keys(metrics).length, metrics: metrics };
            })()
          `);
}

async function runBatchAction({action, apiPath, symbol, tf, ohlcv_count}) {
    if (action === 'screenshot') return screenshotAction(symbol, tf);
    if (action === 'get_ohlcv' && apiPath) return ohlcvAction(apiPath, ohlcv_count);
    if (action === 'get_strategy_results') return strategyResultsAction();
    return {error: 'Unknown action or API not available: ' + action};
}

export async function batchRun({symbols, timeframes, action, delay_ms, ohlcv_count}) {
    const tfs = timeframes && timeframes.length > 0 ? timeframes : [null];
    const delay = delay_ms || 2000;
    const results = [];

    let colPath, apiPath;
    try {
        colPath = await getChartCollection();
    } catch {
    }
    try {
        apiPath = await getChartApi();
    } catch {
    }

    for (const symbol of symbols) {
        for (const tf of tfs) {
            const combo = {symbol, timeframe: tf};
            try {
                await batchSetSymbol(colPath, apiPath, symbol);
                if (tf) await batchSetResolution(colPath, apiPath, tf);

                await waitForChartReady(symbol);
                await new Promise(r => setTimeout(r, delay));

                const actionResult = await runBatchAction({action, apiPath, symbol, tf, ohlcv_count});
        results.push({ ...combo, success: true, result: actionResult });
      } catch (err) {
        results.push({ ...combo, success: false, error: err.message });
      }
    }
  }

  const successCount = results.filter(r => r.success).length;
  return { success: true, total_iterations: results.length, successful: successCount, failed: results.length - successCount, results };
}
