/* Pinteless Desktop — preload da janela de configurações (popup.html).
 * Expõe um "browser" mínimo para o popup.js: storage e tabs.
 */
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const area = name => ({
  get: keys => ipcRenderer.invoke('pjr-storage-get', name, keys === undefined ? null : keys),
  set: items => ipcRenderer.invoke('pjr-storage-set', name, items),
  remove: keys => ipcRenderer.invoke('pjr-storage-remove', name, keys)
});

contextBridge.exposeInMainWorld('browser', {
  storage: { sync: area('sync'), local: area('local') },
  tabs: {
    query: q => ipcRenderer.invoke('pjr-tabs-query', q),
    sendMessage: (tabId, msg) => ipcRenderer.invoke('pjr-tabs-send', tabId, msg)
  }
});

// No app, "nesta aba" vira "na janela".
window.addEventListener('DOMContentLoaded', () => {
  const toggle = document.getElementById('toggle');
  if (!toggle) return;
  const fix = () => {
    const t = toggle.textContent.replace('nesta aba', 'na janela').replace('Abra uma página do Pinterest', 'Abra o Pinterest na janela principal');
    if (t !== toggle.textContent) toggle.textContent = t;
  };
  new MutationObserver(fix).observe(toggle, { childList: true, characterData: true, subtree: true });
  fix();
  const hint = document.getElementById('hint');
  if (hint) hint.insertAdjacentHTML('beforeend', ' · <b>Ctrl+,</b> abre estas configurações');
});
