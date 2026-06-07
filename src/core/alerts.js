/**
 * Core alert logic.
 */
import { evaluate as _evaluate, evaluateAsync as _evaluateAsync, getClient as _getClient, safeString, requireFinite } from '../connection.js';

function _resolve(deps) {
  return {
    evaluate: deps?.evaluate || _evaluate,
    evaluateAsync: deps?.evaluateAsync || _evaluateAsync,
    getClient: deps?.getClient || _getClient,
  };
}

// Webpack module IDs sniffed from TradingView Desktop bundle (3.1.0.7818, 2026-05).
// Required for the activate() facade path. If TradingView ever rebuilds with a
// different chunk graph, these IDs change — re-sniff via `grep getChartAlertsFacade`
// in static.tradingview.com/static/bundles/*.js.
const TV_CHART_ALERTS_FACADE_MODULE = 144534;

export async function create({ condition, price, message, _deps }) {
  const { evaluate, getClient } = _resolve(_deps);
  const opened = await evaluate(`
    (function() {
      var btn = document.querySelector('[aria-label="Create alert"]')
        || document.querySelector('[aria-label="Create Alert"]')
        || document.querySelector('[data-name="alerts"]');
      if (btn) { btn.click(); return true; }
      return false;
    })()
  `);

  if (!opened) {
    const client = await getClient();
    await client.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 1, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
    await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'a', code: 'KeyA' });
  }

  await new Promise(r => setTimeout(r, 1000));

  const priceSet = await evaluate(`
    (function() {
      var inputs = document.querySelectorAll('[class*="alert"] input[type="text"], [class*="alert"] input[type="number"]');
      for (var i = 0; i < inputs.length; i++) {
        var label = inputs[i].closest('[class*="row"]')?.querySelector('[class*="label"]');
        if (label && /value|price/i.test(label.textContent)) {
          var nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          nativeSet.call(inputs[i], ${safeString(String(price))});
          inputs[i].dispatchEvent(new Event('input', { bubbles: true }));
          inputs[i].dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
      }
      if (inputs.length > 0) {
        var nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        nativeSet.call(inputs[0], ${safeString(String(price))});
        inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      }
      return false;
    })()
  `);

  if (message) {
    await evaluate(`
      (function() {
        var textarea = document.querySelector('[class*="alert"] textarea')
          || document.querySelector('textarea[placeholder*="message"]');
        if (textarea) {
          var nativeSet = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
          nativeSet.call(textarea, ${JSON.stringify(message)});
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
        }
      })()
    `);
  }

  await new Promise(r => setTimeout(r, 500));
  const created = await evaluate(`
    (function() {
      var btns = document.querySelectorAll('button[data-name="submit"], button');
      for (var i = 0; i < btns.length; i++) {
        if (/^create$/i.test(btns[i].textContent.trim())) { btns[i].click(); return true; }
      }
      return false;
    })()
  `);

  return { success: !!created, price, condition, message: message || '(none)', price_set: !!priceSet, source: 'dom_fallback' };
}

export async function list({ _deps } = {}) {
  const { evaluateAsync } = _resolve(_deps);
  // Use pricealerts REST API — returns structured data with alert_id, symbol, price, conditions
  const result = await evaluateAsync(`
    fetch('https://pricealerts.tradingview.com/list_alerts', { credentials: 'include' })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.s !== 'ok' || !Array.isArray(data.r)) return { alerts: [], error: data.errmsg || 'Unexpected response' };
        return {
          alerts: data.r.map(function(a) {
            var sym = '';
            try { sym = JSON.parse(a.symbol.replace(/^=/, '')).symbol || a.symbol; } catch(e) { sym = a.symbol; }
            return {
              alert_id: a.alert_id,
              symbol: sym,
              type: a.type,
              message: a.message,
              active: a.active,
              condition: a.condition,
              resolution: a.resolution,
              created: a.create_time,
              last_fired: a.last_fire_time,
              expiration: a.expiration,
            };
          })
        };
      })
      .catch(function(e) { return { alerts: [], error: e.message }; })
  `);
  return { success: true, alert_count: result?.alerts?.length || 0, source: 'internal_api', alerts: result?.alerts || [], error: result?.error };
}

export async function activate({ alert_id, _deps }) {
  const { evaluateAsync } = _resolve(_deps);
  const id = requireFinite(Number(alert_id), 'alert_id');
  const result = await evaluateAsync(`
    (async function() {
      // Boot webpack require if we haven't already (caches on window for reuse).
      if (!window.__tvWebpackRequire) {
        var chunks = window.webpackChunktradingview;
        if (!Array.isArray(chunks)) return { ok: false, error: 'webpackChunktradingview not found — TradingView UI may not be loaded yet' };
        chunks.push([[(Math.random() * 1e9) | 0], {}, function(req) { window.__tvWebpackRequire = req; }]);
        // Allow the synchronous chunk callback to run.
        await new Promise(function(r){ setTimeout(r, 50); });
        if (!window.__tvWebpackRequire) return { ok: false, error: 'failed to capture webpack require' };
      }
      if (!window.__tvAlertsFacade) {
        try {
          var mod = window.__tvWebpackRequire(${TV_CHART_ALERTS_FACADE_MODULE});
          if (!mod || typeof mod.getChartAlertsFacade !== 'function') return { ok: false, error: 'getChartAlertsFacade not exported by module ${TV_CHART_ALERTS_FACADE_MODULE} (TV bundle may have changed)' };
          window.__tvAlertsFacade = await mod.getChartAlertsFacade();
        } catch (e) { return { ok: false, error: 'failed to load alerts facade: ' + (e && e.message || e) }; }
      }
      return new Promise(function(resolve) {
        var done = false;
        function finish(payload) { if (!done) { done = true; resolve(payload); } }
        try {
          window.__tvAlertsFacade.restartAlert(${id}, {
            success: function() { finish({ ok: true }); },
            error: function(e) { finish({ ok: false, error: String(e && e.message || e || 'unknown') }); },
            complete: function() { /* fired after success/error */ },
            actionSource: 'mcp_activate_alert'
          });
        } catch (e) { finish({ ok: false, error: 'restartAlert threw: ' + e.message }); }
        setTimeout(function(){ finish({ ok: false, error: 'timeout after 10s' }); }, 10000);
      });
    })()
  `);
  if (result && result.ok) return { success: true, alert_id: id, source: 'chart_alerts_facade' };
  return { success: false, alert_id: id, error: (result && result.error) || 'unknown', source: 'chart_alerts_facade' };
}

export async function deleteAlerts({ delete_all, _deps }) {
  const { evaluate } = _resolve(_deps);
  if (delete_all) {
    const result = await evaluate(`
      (function() {
        var alertBtn = document.querySelector('[data-name="alerts"]');
        if (alertBtn) alertBtn.click();
        var header = document.querySelector('[data-name="alerts"]');
        if (header) {
          header.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 }));
          return { context_menu_opened: true };
        }
        return { context_menu_opened: false };
      })()
    `);
    return { success: true, note: 'Alert deletion requires manual confirmation in the context menu.', context_menu_opened: result?.context_menu_opened || false, source: 'dom_fallback' };
  }
  throw new Error('Individual alert deletion not yet supported. Use delete_all: true.');
}
