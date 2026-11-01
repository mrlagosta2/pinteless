/* Pinteless Desktop — preload da janela do Pinterest.
 * Faz o papel do navegador para a extensão:
 *  - injeta page.js no contexto da página, antes dos scripts do Pinterest
 *    (equivale a content_scripts world: MAIN, run_at: document_start);
 *  - roda defaults.js + content.js neste mundo isolado ao carregar o DOM
 *    (equivale ao content script normal, run_at: document_idle);
 *  - emula chrome.storage e chrome.runtime.onMessage via IPC.
 */
'use strict';
const { ipcRenderer, webFrame } = require('electron');
const path = require('path');

const PINTEREST_RE = /(^|\.)pinterest\.(com|com\.br|pt|co\.uk|es|fr|de|it|ca|com\.mx|com\.au)$/i;

if (location.protocol === 'https:' && PINTEREST_RE.test(location.hostname)) {
  const src = ipcRenderer.sendSync('pjr-sources');
  if (src && src.error) console.error('[Pinteless]', src.error);

  if (src && src.pageJs) {
    webFrame.executeJavaScript(src.pageJs).catch(err => console.error('[Pinteless] page.js', err));
  }

  // ---------- shim das APIs de extensão ----------
  const changeListeners = new Set();
  const messageListeners = new Set();

  const area = name => ({
    get: keys => ipcRenderer.invoke('pjr-storage-get', name, keys === undefined ? null : keys),
    set: items => ipcRenderer.invoke('pjr-storage-set', name, items),
    remove: keys => ipcRenderer.invoke('pjr-storage-remove', name, keys)
  });

  const api = {
    storage: {
      sync: area('sync'),
      local: area('local'),
      onChanged: {
        addListener: fn => changeListeners.add(fn),
        removeListener: fn => changeListeners.delete(fn)
      }
    },
    runtime: {
      onMessage: {
        addListener: fn => messageListeners.add(fn),
        removeListener: fn => messageListeners.delete(fn)
      }
    }
  };

  ipcRenderer.on('pjr-storage-changed', (_e, changes, areaName) => {
    for (const fn of changeListeners) { try { fn(changes, areaName); } catch (err) { console.error(err); } }
  });

  ipcRenderer.on('pjr-msg', (_e, id, msg) => {
    let replied = false;
    const sendResponse = r => { if (!replied) { replied = true; ipcRenderer.send('pjr-msg-reply', id, r); } };
    for (const fn of messageListeners) { try { fn(msg, {}, sendResponse); } catch (err) { console.error(err); } }
    if (!replied) sendResponse(undefined);
  });

  globalThis.browser = api;

  const start = () => {
    try {
      const { PJR_DEFAULTS } = require(path.join(src.extDir, 'defaults.js'));
      globalThis.PJR_DEFAULTS = PJR_DEFAULTS;
      globalThis.PJR_API = api;
      require(path.join(src.extDir, 'content.js'));
    } catch (err) {
      console.error('[Pinteless] content.js', err);
    }
  };
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}
