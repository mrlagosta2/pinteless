/* Pinteless — roda no contexto da própria página (world: MAIN).
 * Faz as chamadas à API interna como o próprio site: mesma origem, mesmos
 * cookies e os mesmos cabeçalhos que o Pinterest usa (copiados das requisições
 * que ele mesmo faz). O content script pede via postMessage.
 */
(() => {
  'use strict';
  if (window.__pjrPageLoaded) return;
  window.__pjrPageLoaded = true;

  // Cabeçalhos x-* que o Pinterest envia nas chamadas /resource/ (versão do app, handler, etc.)
  const captured = {};
  const SKIP = new Set(['x-pinterest-source-url', 'x-csrftoken', 'content-type', 'content-length']);
  function remember(url, name, value) {
    try {
      if (!String(url).includes('/resource/')) return;
      const k = String(name).toLowerCase();
      if (k.startsWith('x-') && !SKIP.has(k)) captured[k] = String(value);
    } catch {}
  }

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = typeof input === 'string' ? input : input && input.url;
      const h = (init && init.headers) || (input instanceof Request ? input.headers : null);
      if (h) {
        if (h instanceof Headers) h.forEach((v, k) => remember(url, k, v));
        else if (Array.isArray(h)) h.forEach(([k, v]) => remember(url, k, v));
        else for (const k in h) remember(url, k, h[k]);
      }
    } catch {}
    return origFetch.apply(this, arguments);
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSet = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (method, url) { this.__pjrUrl = url; return origOpen.apply(this, arguments); };
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) { remember(this.__pjrUrl, k, v); return origSet.apply(this, arguments); };

  function csrf() {
    const m = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  }

  function appVersion() {
    try { return JSON.parse(document.getElementById('__PWS_DATA__').textContent).appVersion || ''; } catch { return ''; }
  }

  async function call({ resource, action, options }) {
    const enc = encodeURIComponent;
    const source = location.pathname + location.search;
    const data = JSON.stringify({ options, context: {} });
    const headers = {
      'accept': 'application/json, text/javascript, */*, q=0.01',
      'x-requested-with': 'XMLHttpRequest',
      'x-pinterest-appstate': 'active',
      ...captured,
      'x-csrftoken': csrf(),
      'x-pinterest-source-url': source
    };
    if (!headers['x-app-version'] && appVersion()) headers['x-app-version'] = appVersion();
    let res;
    if (action === 'get') {
      res = await origFetch(`/resource/${resource}/get/?source_url=${enc(source)}&data=${enc(data)}&_=${Date.now()}`,
        { headers, credentials: 'include' });
    } else {
      headers['content-type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
      res = await origFetch(`/resource/${resource}/${action}/`,
        { method: 'POST', headers, credentials: 'include', body: `source_url=${enc(source)}&data=${enc(data)}` });
    }
    let json = null;
    try { json = await res.json(); } catch {}
    const err = json && json.resource_response && json.resource_response.error;
    if (!res.ok || !json || err) {
      const msg = (err && (err.message_detail || err.message)) || `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return json.resource_response.data;
  }

  window.addEventListener('message', async e => {
    if (e.source !== window || !e.data || e.data.source !== 'pjr-req') return;
    const { id, payload } = e.data;
    try {
      const data = await call(payload);
      window.postMessage({ source: 'pjr-res', id, ok: true, data: JSON.stringify(data) }, location.origin);
    } catch (err) {
      window.postMessage({ source: 'pjr-res', id, ok: false, error: String(err && err.message || err) }, location.origin);
    }
  });
})();
