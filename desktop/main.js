/* Pinteless Desktop — processo principal (Electron).
 * Abre o Pinterest numa janela própria e injeta os mesmos scripts da extensão
 * (page.js, content.js, content.css). As APIs de extensão que eles usam
 * (storage, runtime.onMessage, tabs) são emuladas aqui e no preload.
 */
'use strict';
const { app, BrowserWindow, Menu, ipcMain, shell, session, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const { EXT_DIR } = require('./paths');

const HOME_URL = 'https://www.pinterest.com/';
const PINTEREST_RE = /(^|\.)pinterest\.(com|com\.br|pt|co\.uk|es|fr|de|it|ca|com\.mx|com\.au)$/i;
// Domínios de login (Google, Facebook, Apple) precisam abrir como popup dentro do app.
const LOGIN_RE = /(^|\.)(accounts\.google\.com|google\.com|facebook\.com|appleid\.apple\.com|apple\.com)$/i;

function hostOf(url) { try { return new URL(url).hostname; } catch { return ''; } }
const isPinterest = url => PINTEREST_RE.test(hostOf(url));
const isLogin = url => LOGIN_RE.test(hostOf(url));

// ---------- armazenamento (substitui chrome.storage) ----------

const STORE_FILE = () => path.join(app.getPath('userData'), 'pinteless-store.json');
let store = { sync: {}, local: {}, window: null };

function loadStore() {
  try { store = { ...store, ...JSON.parse(fs.readFileSync(STORE_FILE(), 'utf8')) }; }
  catch {
    // primeira execução: no app a galeria abre sozinha por padrão
    store.sync.autoOpen = true;
  }
}
let saveTimer = null;
function saveStore() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(STORE_FILE(), JSON.stringify(store, null, 2)); } catch (e) { console.error(e); }
  }, 200);
}

function storageGet(area, keys) {
  const data = store[area] || {};
  if (keys == null) return { ...data };
  if (typeof keys === 'string') return keys in data ? { [keys]: data[keys] } : {};
  if (Array.isArray(keys)) {
    const out = {};
    for (const k of keys) if (k in data) out[k] = data[k];
    return out;
  }
  const out = { ...keys };
  for (const k of Object.keys(keys)) if (k in data) out[k] = data[k];
  return out;
}

function storageSet(area, items) {
  const data = store[area] || (store[area] = {});
  const changes = {};
  for (const [k, v] of Object.entries(items || {})) {
    if (JSON.stringify(data[k]) === JSON.stringify(v)) continue;
    changes[k] = { oldValue: data[k], newValue: v };
    data[k] = v;
  }
  if (!Object.keys(changes).length) return;
  saveStore();
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('pjr-storage-changed', changes, area);
  }
}

ipcMain.handle('pjr-storage-get', (_e, area, keys) => storageGet(area, keys));
ipcMain.handle('pjr-storage-set', (_e, area, items) => { storageSet(area, items); });
ipcMain.handle('pjr-storage-remove', (_e, area, keys) => {
  const data = store[area] || {};
  for (const k of [].concat(keys)) delete data[k];
  saveStore();
});

// Fontes da extensão, lidas uma vez e entregues ao preload.
ipcMain.on('pjr-sources', e => {
  try {
    e.returnValue = {
      pageJs: fs.readFileSync(path.join(EXT_DIR, 'page.js'), 'utf8'),
      extDir: EXT_DIR
    };
  } catch (err) { e.returnValue = { error: String(err) }; }
});

// ---------- mensagens janela de configurações -> galeria (chrome.tabs.sendMessage) ----------

let msgSeq = 0;
const pending = new Map();
ipcMain.on('pjr-msg-reply', (_e, id, response) => {
  const p = pending.get(id);
  if (p) { pending.delete(id); p(response); }
});

function sendToViewer(win, msg) {
  return new Promise((resolve, reject) => {
    if (!win || win.isDestroyed()) return reject(new Error('Nenhuma janela do Pinterest aberta'));
    const id = ++msgSeq;
    const t = setTimeout(() => { pending.delete(id); reject(new Error('Sem resposta')); }, 3000);
    pending.set(id, r => { clearTimeout(t); resolve(r); });
    win.webContents.send('pjr-msg', id, msg);
  });
}

let lastViewer = null;
function viewerWindows() { return BrowserWindow.getAllWindows().filter(w => w.__pjrViewer && !w.isDestroyed()); }
function currentViewer() {
  if (lastViewer && !lastViewer.isDestroyed()) return lastViewer;
  return viewerWindows()[0] || null;
}

ipcMain.handle('pjr-tabs-query', () => {
  const w = currentViewer();
  return w ? [{ id: w.id, url: w.webContents.getURL(), active: true }] : [];
});
ipcMain.handle('pjr-tabs-send', async (_e, tabId, msg) => {
  const w = BrowserWindow.fromId(tabId) || currentViewer();
  return sendToViewer(w, msg);
});

// ---------- janelas ----------

function cleanUserAgent() {
  // O Google recusa login em navegadores "embutidos"; tira as marcas do Electron do UA.
  const ua = session.defaultSession.getUserAgent()
    .replace(/\s*Electron\/\S+/i, '')
    .replace(new RegExp(`\\s*${app.getName()}\\/\\S+`, 'i'), '')
    .replace(/\s*pinteless[-\w]*\/\S+/i, '');
  app.userAgentFallback = ua;
  session.defaultSession.setUserAgent(ua);
}

function createViewer(url = HOME_URL) {
  const saved = store.window || {};
  const win = new BrowserWindow({
    width: saved.width || 1400,
    height: saved.height || 900,
    x: saved.x, y: saved.y,
    minWidth: 480, minHeight: 360,
    backgroundColor: (store.sync && store.sync.background) || '#111111',
    autoHideMenuBar: true,
    title: 'Pinteless',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // o preload usa require() para carregar content.js no mundo isolado
      spellcheck: false
    }
  });
  win.__pjrViewer = true;
  if (saved.maximized) win.maximize();

  win.on('focus', () => { lastViewer = win; });
  const remember = () => {
    if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
    store.window = { ...(win.isMaximized() ? store.window : win.getBounds()), maximized: win.isMaximized() };
    saveStore();
  };
  win.on('resize', remember);
  win.on('move', remember);
  win.on('close', remember);

  const wc = win.webContents;

  // content.css, como a extensão faz (insertCSS ignora a CSP do site)
  const css = fs.readFileSync(path.join(EXT_DIR, 'content.css'), 'utf8');
  wc.on('dom-ready', () => { if (isPinterest(wc.getURL())) wc.insertCSS(css).catch(() => {}); });

  wc.setWindowOpenHandler(({ url }) => {
    if (isPinterest(url)) { createViewer(url); return { action: 'deny' }; }
    if (isLogin(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: { width: 520, height: 720, autoHideMenuBar: true, parent: win }
      };
    }
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  wc.on('will-navigate', (e, url) => {
    if (isPinterest(url) || isLogin(url)) return;
    e.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });

  wc.on('page-title-updated', (e, title) => {
    e.preventDefault();
    win.setTitle(title && !/^pinterest$/i.test(title) ? `${title} — Pinteless` : 'Pinteless');
  });

  wc.on('context-menu', (_e, p) => {
    const items = [];
    if (p.mediaType === 'image' && p.srcURL) {
      items.push(
        { label: 'Salvar imagem como…', click: () => wc.downloadURL(p.srcURL) },
        { label: 'Copiar imagem', click: () => wc.copyImageAt(p.x, p.y) },
        { label: 'Copiar endereço da imagem', click: () => clipboard.writeText(p.srcURL) },
        { label: 'Abrir imagem no navegador', click: () => shell.openExternal(p.srcURL) },
        { type: 'separator' }
      );
    }
    if (p.linkURL) {
      items.push(
        { label: 'Abrir link em nova janela', click: () => isPinterest(p.linkURL) ? createViewer(p.linkURL) : shell.openExternal(p.linkURL) },
        { label: 'Copiar endereço do link', click: () => clipboard.writeText(p.linkURL) },
        { type: 'separator' }
      );
    }
    if (p.isEditable) {
      items.push({ role: 'cut', label: 'Recortar' }, { role: 'copy', label: 'Copiar' }, { role: 'paste', label: 'Colar' }, { type: 'separator' });
    } else if (p.selectionText) {
      items.push({ role: 'copy', label: 'Copiar' }, { type: 'separator' });
    }
    items.push(
      { label: 'Voltar', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
      { label: 'Avançar', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
      { label: 'Recarregar', click: () => wc.reload() },
      { label: 'Copiar endereço da página', click: () => clipboard.writeText(wc.getURL()) },
      { label: 'Abrir página no navegador', click: () => shell.openExternal(wc.getURL()) }
    );
    Menu.buildFromTemplate(items).popup({ window: win });
  });

  // botões "voltar/avançar" do mouse
  win.on('app-command', (_e, cmd) => {
    if (cmd === 'browser-backward' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    if (cmd === 'browser-forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
  });

  win.loadURL(url);
  lastViewer = win;
  return win;
}

let settingsWin = null;
function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 360, height: 680,
    resizable: true, minimizable: false, maximizable: false,
    autoHideMenuBar: true,
    title: 'Configurações — Pinteless',
    icon: path.join(__dirname, 'build', 'icon.png'),
    parent: currentViewer() || undefined,
    webPreferences: {
      preload: path.join(__dirname, 'settings-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  settingsWin.setMenu(null);
  settingsWin.loadFile(path.join(EXT_DIR, 'popup.html'));
  settingsWin.on('closed', () => { settingsWin = null; });
}

function focused() { return BrowserWindow.getFocusedWindow() || currentViewer(); }
function focusedViewerWc() {
  const w = focused();
  return w && w.__pjrViewer ? w.webContents : (currentViewer() && currentViewer().webContents);
}

function buildMenu() {
  const nav = fn => () => { const wc = focusedViewerWc(); if (wc) fn(wc); };
  const template = [
    {
      label: 'Arquivo',
      submenu: [
        { label: 'Nova janela', accelerator: 'CmdOrCtrl+N', click: () => createViewer() },
        { label: 'Configurações…', accelerator: 'CmdOrCtrl+,', click: openSettings },
        { type: 'separator' },
        { role: 'quit', label: 'Sair' }
      ]
    },
    {
      label: 'Exibir',
      submenu: [
        {
          label: 'Abrir / fechar galeria', accelerator: 'Alt+Shift+G', registerAccelerator: false,
          click: () => { const w = currentViewer(); if (w) sendToViewer(w, { type: 'pjr-toggle' }).catch(() => {}); }
        },
        { type: 'separator' },
        { label: 'Início', accelerator: 'Alt+Home', click: nav(wc => wc.loadURL(HOME_URL)) },
        { label: 'Voltar', accelerator: 'Alt+Left', click: nav(wc => wc.navigationHistory.canGoBack() && wc.navigationHistory.goBack()) },
        { label: 'Avançar', accelerator: 'Alt+Right', click: nav(wc => wc.navigationHistory.canGoForward() && wc.navigationHistory.goForward()) },
        { label: 'Recarregar', accelerator: 'F5', click: nav(wc => wc.reload()) },
        { label: 'Recarregar', accelerator: 'CmdOrCtrl+R', visible: false, click: nav(wc => wc.reload()) },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Zoom padrão' },
        { role: 'zoomIn', label: 'Aumentar zoom', accelerator: 'CmdOrCtrl+=' },
        { role: 'zoomOut', label: 'Diminuir zoom' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Tela cheia', accelerator: 'F11' },
        { role: 'toggleDevTools', label: 'Ferramentas de desenvolvedor', accelerator: 'CmdOrCtrl+Shift+I' }
      ]
    },
    {
      label: 'Ajuda',
      submenu: [
        { label: 'Página do projeto', click: () => shell.openExternal('https://github.com/mrlagosta2/pinteless') },
        { label: 'Pasta de dados do app', click: () => shell.openPath(app.getPath('userData')) }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- ciclo de vida ----------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const w = currentViewer();
    if (w) { if (w.isMinimized()) w.restore(); w.focus(); } else createViewer();
  });

  app.setAppUserModelId('com.mrlagosta2.pinteless');

  app.whenReady().then(() => {
    loadStore();
    cleanUserAgent();
    buildMenu();
    createViewer(process.env.PINTELESS_START_URL || HOME_URL);
    app.on('activate', () => { if (!viewerWindows().length) createViewer(); });
  });

  app.on('window-all-closed', () => {
    clearTimeout(saveTimer);
    try { fs.writeFileSync(STORE_FILE(), JSON.stringify(store, null, 2)); } catch {}
    if (process.platform !== 'darwin') app.quit();
  });
}
