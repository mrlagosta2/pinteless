/* Pinteless — content script
 * Coleta os pins que o Pinterest renderiza (o grid dele é virtualizado e
 * descarta itens fora da tela, então guardamos cada um assim que aparece)
 * e os exibe numa galeria própria, em linhas justificadas que preservam a
 * proporção das imagens.
 */
(() => {
  'use strict';
  if (window.__pjrLoaded) return;
  window.__pjrLoaded = true;

  const api = PJR_API;
  let S = { ...PJR_DEFAULTS };

  const items = [];          // { id, ratio, thumb, full, href, isAd, isVideo, el, img }
  const byId = new Map();
  let active = false;
  let pageKey = location.pathname + location.search;

  let root, grid, toolbar, counter, sizeLabel, modeBtn, fab, lightbox;
  let lbIndex = -1;
  let hoverItem = null;
  let activeChip = null;

  // ---------- utilidades ----------

  const QUALITY_ORDER = ['236x', '474x', '564x', '736x', '1200x', 'originals'];

  function parseSrcset(img) {
    const urls = [];
    const srcset = img.getAttribute('srcset') || '';
    for (const part of srcset.split(',')) {
      const u = part.trim().split(/\s+/)[0];
      if (u) urls.push(u);
    }
    const src = img.getAttribute('src');
    if (src) urls.push(src);
    return urls;
  }

  function sizeOf(url) {
    const m = url.match(/i\.pinimg\.com\/([^/]+)\//);
    return m ? m[1] : null;
  }

  // Melhor URL disponível até a qualidade pedida; se não houver, reescreve a URL.
  function pickUrl(urls, quality) {
    const want = QUALITY_ORDER.indexOf(quality);
    let best = null, bestRank = -1;
    for (const u of urls) {
      const r = QUALITY_ORDER.indexOf(sizeOf(u));
      if (r > bestRank && r <= want) { best = u; bestRank = r; }
    }
    if (best && bestRank === want) return best;
    const base = best || urls[0];
    if (!base) return null;
    // 'originals' pode ter extensão diferente (png/webp); só reescrevemos para tamanhos fixos (sempre .jpg)
    if (quality !== 'originals' && /i\.pinimg\.com\/[^/]+\//.test(base)) {
      return base.replace(/i\.pinimg\.com\/[^/]+\//, `i.pinimg.com/${quality}/`).replace(/\.(png|webp|gif)$/i, '.jpg');
    }
    return base;
  }

  function ratioFromDom(img) {
    let el = img.parentElement;
    for (let i = 0; i < 4 && el; i++, el = el.parentElement) {
      const pb = el.style && el.style.paddingBottom;
      if (pb && pb.endsWith('%')) {
        const v = parseFloat(pb);
        if (v > 0) return 100 / v;
      }
    }
    if (img.naturalWidth && img.naturalHeight) return img.naturalWidth / img.naturalHeight;
    return 0;
  }

  // ---------- coleta ----------

  function collect() {
    const pins = document.querySelectorAll('[data-test-id="pin"][data-test-pin-id], [data-test-pin-id]');
    let added = 0;
    for (const pin of pins) {
      if (root && root.contains(pin)) continue;
      const id = pin.getAttribute('data-test-pin-id');
      if (!id || byId.has(id)) continue;
      const img = pin.querySelector('img[srcset*="pinimg.com"], img[src*="i.pinimg.com"]');
      if (!img) continue;
      const urls = parseSrcset(img).filter(u => u.includes('pinimg.com'));
      if (!urls.length) continue;
      const ratio = ratioFromDom(img);
      const link = pin.querySelector('a[href*="/pin/"]');
      const item = {
        id,
        urls,
        ratio: ratio || 1,
        ratioKnown: !!ratio,
        href: link ? link.getAttribute('href') : `/pin/${id}/`,
        isAd: !/^\d+$/.test(id),
        isVideo: !!pin.querySelector('video, [data-test-id="pinrep-video"]'),
        alt: (img.getAttribute('alt') || '').replace(/^Contém uma imagem de:\s*/i, '')
      };
      byId.set(id, item);
      items.push(item);
      added++;
    }
    if (added && active) scheduleLayout();
    if (counter) updateCounter();
    return added;
  }

  // ---------- galeria ----------

  function buildUI() {
    root = document.createElement('div');
    root.id = 'pjr-root';

    toolbar = document.createElement('div');
    toolbar.id = 'pjr-toolbar';
    toolbar.innerHTML = `
      <button data-act="smaller" title="Menor (−)">−</button>
      <span class="pjr-size"></span>
      <button data-act="bigger" title="Maior (+)">+</button>
      <button data-act="mode" class="pjr-mode" title="Alternar modo"></button>
      <span class="pjr-count"></span>
      <span class="pjr-chip"></span>
      <button data-act="top" title="Topo">↑</button>
      <button data-act="close" title="Fechar (Esc)">✕</button>`;
    sizeLabel = toolbar.querySelector('.pjr-size');
    modeBtn = toolbar.querySelector('.pjr-mode');
    counter = toolbar.querySelector('.pjr-count');
    activeChip = toolbar.querySelector('.pjr-chip');
    toolbar.addEventListener('click', e => {
      const act = e.target.closest('button')?.dataset.act;
      if (act === 'smaller') adjustSize(-1);
      else if (act === 'bigger') adjustSize(1);
      else if (act === 'mode') save({ mode: S.mode === 'height' ? 'count' : 'height' });
      else if (act === 'top') root.scrollTo({ top: 0, behavior: 'smooth' });
      else if (act === 'close') setActive(false);
    });

    grid = document.createElement('div');
    grid.id = 'pjr-grid';

    const status = document.createElement('div');
    status.id = 'pjr-status';
    status.textContent = 'Carregando mais imagens…';

    root.append(toolbar, grid, status);
    document.documentElement.appendChild(root);

    root.addEventListener('scroll', onScroll, { passive: true });
    // teclas digitadas na galeria não devem acionar atalhos do Pinterest
    for (const t of ['keydown', 'keyup', 'keypress']) root.addEventListener(t, e => e.stopPropagation());
    buildTopbar();
    updateActiveUI();
    applyStyleVars();
  }

  // Qualidade automática: menor tamanho do Pinterest que cubra a caixa na tela.
  function thumbFor(item, boxW) {
    if (S.thumbQuality !== 'auto') return pickUrl(item.urls, S.thumbQuality);
    const need = boxW * (window.devicePixelRatio || 1);
    const q = need <= 236 ? '236x' : need <= 474 ? '474x' : need <= 736 ? '736x' : 'originals';
    return pickUrl(item.urls, q);
  }

  function buildItem(item) {
    const a = document.createElement('a');
    a.className = 'pjr-item';
    a.href = item.href;
    a.title = item.alt;
    const img = document.createElement('img');
    img.decoding = 'async';
    img.alt = item.alt;
    img.addEventListener('load', () => {
      if (!item.ratioKnown && img.naturalWidth) {
        item.ratio = img.naturalWidth / img.naturalHeight;
        item.ratioKnown = true;
        scheduleLayout();
      }
    });
    img.addEventListener('error', () => {
      // se a qualidade pedida não existir, volta para a URL original do srcset
      const fallback = item.urls[item.urls.length - 1];
      if (img.getAttribute('src') !== fallback) img.src = fallback;
    });
    a.appendChild(img);
    const qa = document.createElement('button');
    qa.className = 'pjr-qa';
    qa.title = 'Salvar na pasta ativa (S)';
    qa.textContent = '＋';
    qa.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); quickSave(item); });
    a.appendChild(qa);
    a.addEventListener('click', e => onItemClick(e, item));
    a.addEventListener('mouseenter', () => { hoverItem = item; });
    a.addEventListener('mouseleave', () => { if (hoverItem === item) hoverItem = null; });
    item.el = a;
    item.img = img;
  }

  function visible(item) {
    if (S.hideAds && item.isAd) return false;
    if (S.hideVideos && item.isVideo) return false;
    return true;
  }

  let layoutPending = false;
  function scheduleLayout() {
    if (layoutPending || !active) return;
    layoutPending = true;
    requestAnimationFrame(() => { layoutPending = false; layout(); });
  }

  // Calcula posições só em memória (barato); o DOM é tocado apenas em render().
  let shownList = [];
  function layout() {
    if (!grid) return;
    const W = grid.clientWidth;
    if (W <= 0) return;
    const g = S.gap;
    const maxH = window.innerHeight * S.maxRowVh / 100;
    const shown = items.filter(visible);
    for (const it of items) it.placed = false;

    let y = 0;
    let row = [];
    let sum = 0;
    let lastFullH = null;

    const place = (rowItems, h, x0) => {
      let x = x0;
      for (const it of rowItems) {
        const w = it.ratio * h;
        it.x = Math.round(x);
        it.y = Math.round(y);
        it.w = Math.round(x + w) - it.x;
        it.h = Math.round(h);
        it.placed = true;
        x += w + g;
      }
    };

    const flush = (isLast) => {
      if (!row.length) return;
      const gaps = g * (row.length - 1);
      let h = (W - gaps) / sum;
      let x0 = 0;
      if (isLast && S.lastRow === 'hide' && lastFullH !== null) { row = []; sum = 0; return; }
      if (isLast && S.lastRow !== 'justify') {
        const target = S.mode === 'height' ? S.rowHeight : (lastFullH ?? h);
        if (h > target) h = target;
      }
      if (h > maxH) {
        h = maxH;
        x0 = (W - (sum * h + gaps)) / 2; // linha alta demais: limita e centraliza
      }
      place(row, h, x0);
      if (!isLast) lastFullH = h;
      y += h + g;
      row = []; sum = 0;
    };

    for (const it of shown) {
      row.push(it);
      sum += it.ratio;
      if (S.mode === 'count') {
        if (row.length >= S.perRow) flush(false);
      } else if (sum * S.rowHeight + g * (row.length - 1) >= W) {
        flush(false);
      }
    }
    flush(true);
    shownList = shown.filter(it => it.placed);
    grid.style.height = `${Math.max(0, y - g)}px`;
    render(true);
    checkNeedMore();
  }

  // Virtualização: só ficam no DOM as imagens perto da área visível.
  const mounted = new Set();
  function render(force = false) {
    if (!grid || !active) return;
    const top = root.scrollTop - grid.offsetTop;
    const vh = root.clientHeight;
    const from = top - vh * 1.5, to = top + vh * 2.5;

    // busca binária pelo primeiro item cujo fundo passa de "from"
    let lo = 0, hi = shownList.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (shownList[m].y + shownList[m].h < from) lo = m + 1; else hi = m; }
    const want = new Set();
    for (let i = lo; i < shownList.length && shownList[i].y <= to; i++) want.add(shownList[i]);

    for (const it of mounted) {
      if (!want.has(it)) {
        it.el.remove();
        it.el = it.img = null; // libera a imagem decodificada
        mounted.delete(it);
      }
    }
    for (const it of want) {
      const isNew = !mounted.has(it);
      if (isNew) buildItem(it);
      if (isNew || force) {
        const s = it.el.style;
        s.transform = `translate(${it.x}px, ${it.y}px)`;
        s.width = `${it.w}px`;
        s.height = `${it.h}px`;
        const url = thumbFor(it, it.w);
        // só troca a imagem se precisar de uma maior (evita recarregar ao diminuir)
        if (isNew || QUALITY_ORDER.indexOf(sizeOf(url)) > QUALITY_ORDER.indexOf(sizeOf(it.img.getAttribute('src') || ''))) it.img.src = url;
      }
      if (isNew) { grid.appendChild(it.el); mounted.add(it); markSaved(it); }
    }
  }

  function unmountAll() {
    for (const it of mounted) { it.el.remove(); it.el = it.img = null; }
    mounted.clear();
  }

  function updateCounter() {
    const n = items.filter(visible).length;
    counter.textContent = `${n} imagens`;
  }

  function updateToolbar() {
    if (!toolbar) return;
    if (S.mode === 'height') {
      sizeLabel.textContent = `${S.rowHeight}px`;
      modeBtn.textContent = 'Altura';
      modeBtn.title = 'Modo: altura alvo da linha (clique para N por linha)';
    } else {
      sizeLabel.textContent = `${S.perRow} / linha`;
      modeBtn.textContent = 'Por linha';
      modeBtn.title = 'Modo: N imagens por linha (clique para altura alvo)';
    }
    updateCounter();
  }

  function applyStyleVars() {
    if (!root) return;
    root.style.setProperty('--pjr-bg', S.background);
    root.style.setProperty('--pjr-gap', `${S.gap}px`);
    root.style.setProperty('--pjr-radius', `${S.radius}px`);
    updateToolbar();
  }

  function adjustSize(dir) {
    if (S.mode === 'height') save({ rowHeight: Math.min(1200, Math.max(80, S.rowHeight + dir * 40)) });
    else save({ perRow: Math.min(12, Math.max(1, S.perRow - dir)) });
  }

  // ---------- carregar mais ----------
  // O Pinterest carrega mais pins quando a janela dele rola até o fim. A galeria
  // fica por cima; rolamos a página de baixo programaticamente.

  let lastTrigger = 0;
  function triggerLoad() {
    const now = Date.now();
    if (now - lastTrigger < 500) return;
    lastTrigger = now;
    const el = document.scrollingElement || document.documentElement;
    window.scrollTo(0, el.scrollHeight);
  }

  function checkNeedMore() {
    if (!active || !root) return;
    const remaining = root.scrollHeight - root.scrollTop - root.clientHeight;
    const near = remaining < root.clientHeight * 2;
    root.classList.toggle('pjr-loading', near);
    if (near) triggerLoad();
  }

  let scrollPending = false;
  function onScroll() {
    if (scrollPending) return;
    scrollPending = true;
    requestAnimationFrame(() => { scrollPending = false; render(); checkNeedMore(); });
  }

  // ---------- clique / lightbox com painel lateral ----------

  function onItemClick(e, item) {
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return; // deixa abrir em nova aba
    if (S.clickAction === 'pin') return; // navegação normal
    e.preventDefault();
    if (S.clickAction === 'newtab') { window.open(item.href, '_blank', 'noopener'); return; }
    openLightbox(items.filter(visible).indexOf(item));
  }

  let panel, pickerOpen = false, saveAfterPick = false;

  function buildLightbox() {
    lightbox = document.createElement('div');
    lightbox.id = 'pjr-lightbox';
    lightbox.innerHTML = `
      <button class="pjr-lb-prev" title="Anterior (←)">‹</button>
      <img class="pjr-lb-img" alt="">
      <button class="pjr-lb-next" title="Próxima (→)">›</button>
      <button class="pjr-lb-x" title="Fechar (Esc)">✕</button>
      <aside class="pjr-panel">
        <div class="pjr-p-label">Pasta ativa</div>
        <button class="pjr-p-active" data-a="pick" title="Trocar pasta ativa">
          <span class="pjr-p-thumb"></span><span class="pjr-p-name"></span><span class="pjr-p-caret">▾</span>
        </button>
        <div class="pjr-p-picker" hidden>
          <input class="pjr-p-filter" placeholder="Buscar pasta…" spellcheck="false">
          <div class="pjr-p-list"></div>
          <button class="pjr-p-newbtn" data-a="new">＋ Nova pasta</button>
          <form class="pjr-p-new" hidden>
            <input placeholder="Nome da pasta" required maxlength="100">
            <label><input type="checkbox"> secreta</label>
            <button>Criar</button>
          </form>
        </div>
        <button class="pjr-p-save" data-a="save"></button>
        <div class="pjr-p-links">
          <a class="pjr-p-pin" target="_blank" rel="noopener">↗ Abrir pin</a>
          <a class="pjr-p-orig" target="_blank" rel="noopener">⬚ Original</a>
        </div>
        <div class="pjr-p-hint"><b>S</b> salva · <b>← →</b> navegam</div>
      </aside>`;
    panel = lightbox.querySelector('.pjr-panel');
    const img = lightbox.querySelector('.pjr-lb-img');
    img.addEventListener('load', positionPanel);

    lightbox.addEventListener('click', e => {
      const act = e.target.closest('[data-a]')?.dataset.a;
      if (e.target.closest('.pjr-lb-prev')) openLightbox(lbIndex - 1);
      else if (e.target.closest('.pjr-lb-next')) openLightbox(lbIndex + 1);
      else if (e.target.closest('.pjr-lb-x') || e.target === lightbox) closeLightbox();
      else if (act === 'pick') { saveAfterPick = false; togglePicker(); }
      else if (act === 'save') { const it = currentLbItem(); if (it) quickSave(it); }
      else if (act === 'new') { const f = panel.querySelector('.pjr-p-new'); f.hidden = false; e.target.hidden = true; f.querySelector('input').focus(); }
      else if (act === 'board') {
        const b = boards?.find(x => x.id === e.target.closest('[data-id]').dataset.id);
        if (b) chooseBoard(b);
      }
    });
    const filter = panel.querySelector('.pjr-p-filter');
    filter.addEventListener('input', renderBoardList);
    filter.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); panel.querySelector('.pjr-p-board')?.click(); }
    });
    panel.querySelector('.pjr-p-new').addEventListener('submit', async e => {
      e.preventDefault();
      const f = e.currentTarget, btn = f.querySelector('button');
      const name = f.querySelector('input').value.trim();
      if (!name) return;
      btn.disabled = true;
      try {
        chooseBoard(await createBoard(name, f.querySelector('input[type=checkbox]').checked));
        f.reset(); f.hidden = true; panel.querySelector('.pjr-p-newbtn').hidden = false;
      } catch (err) { toast(`Não foi possível criar a pasta: ${err.message}`, true); }
      btn.disabled = false;
    });
    root.appendChild(lightbox);
  }

  function currentLbItem() { return lbIndex >= 0 ? items.filter(visible)[lbIndex] : null; }

  function openLightbox(index) {
    const list = items.filter(visible);
    if (index < 0 || index >= list.length) return;
    lbIndex = index;
    const it = list[index];
    if (!lightbox) buildLightbox();
    const full = pickUrl(it.urls, 'originals');
    const img = lightbox.querySelector('.pjr-lb-img');
    img.src = it.img ? it.img.getAttribute('src') : thumbFor(it, it.w || 400); // mostra já a miniatura em cache
    const hi = new Image();
    hi.onload = () => { if (lbIndex === index) img.src = full; };
    hi.src = full;
    img.alt = it.alt;
    panel.querySelector('.pjr-p-pin').href = it.href;
    panel.querySelector('.pjr-p-orig').href = full;
    lightbox.classList.add('pjr-open');
    updatePanel();
    positionPanel();
    if (index > list.length - 6) triggerLoad();
  }

  function closeLightbox() {
    if (lightbox) lightbox.classList.remove('pjr-open');
    closePicker();
    lbIndex = -1;
  }

  // painel à esquerda da imagem, alinhado ao topo dela
  function positionPanel() {
    if (!lightbox || !lightbox.classList.contains('pjr-open')) return;
    const r = lightbox.querySelector('.pjr-lb-img').getBoundingClientRect();
    const pw = panel.offsetWidth, ph = panel.offsetHeight, vh = window.innerHeight;
    const left = Math.max(12, r.left - pw - 24);
    const top = Math.min(Math.max(12, r.top), vh - ph - 12);
    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(top)}px`;
  }

  function updatePanel() {
    if (!panel) return;
    const it = currentLbItem();
    const nameEl = panel.querySelector('.pjr-p-name');
    const thumbEl = panel.querySelector('.pjr-p-thumb');
    nameEl.textContent = activeBoard ? activeBoard.name : 'Escolher pasta…';
    thumbEl.style.backgroundImage = activeBoard?.thumb ? `url("${activeBoard.thumb}")` : '';
    const btn = panel.querySelector('.pjr-p-save');
    const saved = it && activeBoard && it.savedTo?.has(activeBoard.id);
    btn.disabled = !it || it.isAd || saved || savingIds.has(it?.id);
    btn.classList.toggle('pjr-done', !!saved);
    btn.textContent = it?.isAd ? 'Anúncio: não dá para salvar'
      : saved ? '✓ Salvo'
      : savingIds.has(it?.id) ? 'Salvando…'
      : activeBoard ? '＋ Salvar' : '＋ Salvar (escolha a pasta)';
  }

  function togglePicker() { pickerOpen ? closePicker() : openPicker(); }

  function openPicker() {
    if (!panel) return;
    pickerOpen = true;
    panel.querySelector('.pjr-p-picker').hidden = false;
    panel.querySelector('.pjr-p-caret').textContent = '▴';
    const filter = panel.querySelector('.pjr-p-filter');
    filter.value = '';
    const list = panel.querySelector('.pjr-p-list');
    list.innerHTML = '<div class="pjr-p-note">Carregando pastas…</div>';
    loadBoards().then(renderBoardList).catch(err => {
      const it = currentLbItem();
      list.innerHTML = `<div class="pjr-p-note">Erro ao carregar pastas: ${esc(err.message)}${it ? `<br><a class="pjr-p-native" href="${esc(it.href)}" target="_blank" rel="noopener">Salvar pelo próprio Pinterest ↗</a>` : ''}</div>`;
    });
    setTimeout(() => filter.focus({ preventScroll: true }), 0);
    positionPanel();
  }

  function closePicker() {
    if (!panel) return;
    pickerOpen = false;
    saveAfterPick = false;
    panel.querySelector('.pjr-p-picker').hidden = true;
    panel.querySelector('.pjr-p-caret').textContent = '▾';
    positionPanel();
  }

  function renderBoardList() {
    if (!panel || !boards || !pickerOpen) return;
    const q = panel.querySelector('.pjr-p-filter').value.trim().toLowerCase();
    const list = q ? boards.filter(b => b.name.toLowerCase().includes(q)) : boards;
    panel.querySelector('.pjr-p-list').innerHTML = list.length ? list.map(b => `
      <button class="pjr-p-board ${activeBoard?.id === b.id ? 'pjr-cur' : ''}" data-a="board" data-id="${esc(b.id)}">
        <span class="pjr-p-thumb" ${b.thumb ? `style="background-image:url('${esc(b.thumb)}')"` : ''}></span>
        <span class="pjr-p-bname">${esc(b.name)}</span>${b.secret ? '<span class="pjr-p-lock" title="Secreta">🔒</span>' : ''}
      </button>`).join('') : '<div class="pjr-p-note">Nenhuma pasta encontrada</div>';
    positionPanel();
  }

  function chooseBoard(b) {
    const andSave = saveAfterPick;
    setActiveBoard(b);
    closePicker();
    toast(`Pasta ativa: “${b.name}”`);
    const it = currentLbItem();
    if (andSave && it) quickSave(it);
  }

  // ---------- API interna do Pinterest ----------
  // As chamadas são feitas pelo page.js, dentro da própria página do Pinterest
  // (mesma origem, cookies e cabeçalhos do site). Aqui só pedimos e esperamos a resposta.
  const enc = encodeURIComponent;
  let reqSeq = 0;
  const pendingReq = new Map();
  window.addEventListener('message', e => {
    if (e.source !== window || !e.data || e.data.source !== 'pjr-res') return;
    const p = pendingReq.get(e.data.id);
    if (!p) return;
    pendingReq.delete(e.data.id);
    clearTimeout(p.t);
    if (e.data.ok) p.resolve(JSON.parse(e.data.data)); else p.reject(new Error(e.data.error));
  });

  function pinApi(resource, action, options) {
    return new Promise((resolve, reject) => {
      const id = `${Date.now()}-${++reqSeq}`;
      const t = setTimeout(() => { pendingReq.delete(id); reject(new Error('sem resposta do Pinterest')); }, 20000);
      pendingReq.set(id, { resolve, reject, t });
      window.postMessage({ source: 'pjr-req', id, payload: { resource, action, options } }, location.origin);
    });
  }

  let pwsCache;
  function pwsData() {
    if (pwsCache !== undefined) return pwsCache;
    try { pwsCache = JSON.parse(document.getElementById('__PWS_DATA__').textContent); } catch { pwsCache = null; }
    return pwsCache;
  }

  function myUsername() {
    const u = pwsData()?.context?.user?.username;
    if (u) return u;
    const a = document.querySelector('[data-test-id="header-profile"] a[href], a[data-test-id="boards-tab"][href]');
    const m = a && a.getAttribute('href').match(/^\/([^/]+)\//);
    return m ? m[1] : null;
  }

  let boards = null;       // [{ id, name, thumb, secret }]
  let boardsLoading = null;
  function loadBoards(force = false) {
    if (boards && !force) return Promise.resolve(boards);
    if (boardsLoading && !force) return boardsLoading;
    const username = myUsername();
    if (!username) return Promise.reject(new Error('Faça login no Pinterest'));
    boardsLoading = pinApi('BoardsResource', 'get', {
      username, page_size: 250, privacy_filter: 'all', sort: 'last_pinned_to',
      field_set_key: 'profile_grid_item', include_archived: true
    }).then(list => {
      boards = (list || []).filter(b => b && b.id && b.type !== 'story').map(b => ({
        id: String(b.id), name: b.name, thumb: b.image_thumbnail_url || b.image_cover_url || '', secret: b.privacy === 'secret'
      }));
      return boards;
    }).finally(() => { boardsLoading = null; });
    return boardsLoading;
  }

  async function savePin(item, board) {
    await pinApi('RepinResource', 'create', {
      board_id: board.id, pin_id: item.id, description: '', link: '', title: '',
      section_id: null, is_buyable_pin: false, carousel_slot_index: 0
    });
    (item.savedTo ||= new Set()).add(board.id);
  }

  async function createBoard(name, secret) {
    const b = await pinApi('BoardResource', 'create', { name, description: '', privacy: secret ? 'secret' : 'public' });
    const board = { id: String(b.id), name: b.name || name, thumb: '', secret };
    if (boards) boards.unshift(board);
    return board;
  }

  // Pasta ativa: destino do "salvar com um clique" (botão ＋ na foto, painel e tecla S)
  let activeBoard = null;
  const savingIds = new Set();
  api.storage.local.get('pjrActiveBoard').then(r => { activeBoard = r.pjrActiveBoard || null; updateActiveUI(); });

  function setActiveBoard(b) {
    activeBoard = { id: b.id, name: b.name, thumb: b.thumb || '', secret: !!b.secret };
    api.storage.local.set({ pjrActiveBoard: activeBoard });
    updateActiveUI();
  }

  function updateActiveUI() {
    updatePanel();
    if (activeChip) {
      activeChip.textContent = activeBoard ? `📌 ${activeBoard.name}` : '📌 sem pasta ativa';
      activeChip.title = activeBoard ? `Pasta ativa: ${activeBoard.name} (clique numa foto para trocar)` : 'Abra uma foto e escolha a pasta ativa';
    }
    for (const it of mounted) markSaved(it);
  }

  function markSaved(it) {
    if (!it.el) return;
    const saved = !!(activeBoard && it.savedTo?.has(activeBoard.id));
    it.el.classList.toggle('pjr-saved', saved);
    it.el.classList.toggle('pjr-saving', savingIds.has(it.id));
    const qa = it.el.querySelector('.pjr-qa');
    if (qa) qa.textContent = saved ? '✓' : savingIds.has(it.id) ? '…' : '＋';
  }

  async function quickSave(item) {
    if (item.isAd) { toast('Pins promovidos não podem ser salvos', true); return; }
    if (!activeBoard) {
      // ainda não há pasta ativa: abre a foto com a lista de pastas; ao escolher, já salva
      const idx = items.filter(visible).indexOf(item);
      if (lbIndex !== idx) openLightbox(idx);
      saveAfterPick = true;
      if (!pickerOpen) { openPicker(); saveAfterPick = true; }
      return;
    }
    if (item.savedTo?.has(activeBoard.id) || savingIds.has(item.id)) return;
    const board = activeBoard;
    savingIds.add(item.id);
    markSaved(item); updatePanel();
    try {
      await savePin(item, board);
      toast(`Salvo em “${board.name}”`);
    } catch (err) {
      toast(`Erro ao salvar: ${err.message}`, true);
    }
    savingIds.delete(item.id);
    markSaved(item); updatePanel();
  }

  // ---------- toast ----------
  let toastEl, toastT;
  function toast(msg, isError = false) {
    if (!root) return;
    if (!toastEl) { toastEl = document.createElement('div'); toastEl.id = 'pjr-toast'; root.appendChild(toastEl); }
    toastEl.textContent = msg;
    toastEl.classList.toggle('pjr-err', isError);
    toastEl.classList.add('pjr-show');
    clearTimeout(toastT);
    toastT = setTimeout(() => toastEl.classList.remove('pjr-show'), 2600);
  }

  const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---------- barra de pesquisa/abas escondida no topo ----------
  let topbar, topInput, topTabs, topHideT;
  let homeTabs = [];
  api.storage.local.get('pjrTabs').then(r => { if (Array.isArray(r.pjrTabs)) homeTabs = r.pjrTabs; harvestTabs(); });

  // abas do feed inicial ("low poly", "backgrounds"…) vêm no JSON inicial da página
  function harvestTabs() {
    const el = document.getElementById('__PWS_INITIAL_PROPS__');
    if (!el) return;
    let found = [];
    try {
      const walk = o => {
        if (!o || typeof o !== 'object') return;
        if (o.type === 'home_feed_tab' && o.name && o.action?.url) { found.push({ name: o.name, url: o.action.url }); return; }
        for (const k in o) walk(o[k]);
      };
      walk(JSON.parse(el.textContent));
    } catch { return; }
    if (found.length) { homeTabs = found; api.storage.local.set({ pjrTabs: found }); renderTabs(); }
  }

  function buildTopbar() {
    topbar = document.createElement('div');
    topbar.id = 'pjr-topbar';
    topbar.innerHTML = `
      <form class="pjr-t-form"><input type="search" placeholder="Pesquisar no Pinterest  ( / )" spellcheck="false"><button title="Pesquisar">⌕</button></form>
      <div class="pjr-t-tabs"></div>`;
    topInput = topbar.querySelector('input');
    topTabs = topbar.querySelector('.pjr-t-tabs');
    const hot = document.createElement('div');
    hot.id = 'pjr-hotzone'; // faixa invisível no topo que revela a barra
    hot.addEventListener('mouseenter', () => showTop());
    topbar.addEventListener('mouseenter', () => clearTimeout(topHideT));
    topbar.addEventListener('mouseleave', () => { if (document.activeElement !== topInput) topHideT = setTimeout(hideTop, 350); });
    topInput.addEventListener('blur', () => { topHideT = setTimeout(() => { if (!topbar.matches(':hover')) hideTop(); }, 200); });
    topbar.querySelector('form').addEventListener('submit', e => {
      e.preventDefault();
      const q = topInput.value.trim();
      if (q) navigate(`/search/pins/?q=${enc(q)}&rs=typed`);
    });
    topTabs.addEventListener('click', e => {
      const b = e.target.closest('[data-url], [data-pill]');
      if (!b) return;
      if (b.dataset.url) navigate(b.dataset.url);
      else {
        const pill = [...document.querySelectorAll('[data-test-id="one-bar-pill"]')].find(p => p.textContent.trim() === b.dataset.pill);
        if (pill) { hideTop(); pill.click(); }
      }
    });
    root.append(hot, topbar);
    // fecha quando o mouse se afasta (ex.: passou pela borda sem querer)
    root.addEventListener('mousemove', e => {
      if (!topbar.classList.contains('pjr-open') || document.activeElement === topInput) return;
      if (e.clientY > topbar.getBoundingClientRect().bottom + 60) hideTop();
    }, { passive: true });
  }

  function renderTabs() {
    if (!topTabs) return;
    const user = myUsername();
    const here = location.pathname + location.search;
    const fixed = [{ name: 'Início', url: '/' }, { name: 'Explorar', url: '/today/' }];
    if (user) fixed.push({ name: 'Suas pastas', url: `/${user}/` });
    const tab = t => `<button data-url="${esc(t.url)}" class="${here === t.url ? 'pjr-cur' : ''}">${esc(t.name)}</button>`;
    let html = fixed.map(tab).join('');
    if (homeTabs.length) html += '<span class="pjr-t-sep"></span>' + homeTabs.map(tab).join('');
    // refinamentos da busca atual (as "pílulas" do Pinterest)
    const pills = [...document.querySelectorAll('[data-test-id="one-bar-pill"]')]
      .filter(p => !root.contains(p)).map(p => p.textContent.trim()).filter(Boolean);
    if (pills.length) html += '<span class="pjr-t-sep"></span>' + [...new Set(pills)].map(t => `<button data-pill="${esc(t)}" class="pjr-pill">${esc(t)}</button>`).join('');
    topTabs.innerHTML = html;
    const q = new URLSearchParams(location.search).get('q');
    if (q && document.activeElement !== topInput) topInput.value = q;
  }

  function showTop(focus = false) {
    if (!topbar) return;
    clearTimeout(topHideT);
    renderTabs();
    topbar.classList.add('pjr-open');
    if (focus) { topInput.focus(); topInput.select(); }
  }
  function hideTop() {
    if (!topbar) return;
    topbar.classList.remove('pjr-open');
    if (document.activeElement === topInput) topInput.blur();
  }

  // Navegação dentro do app do Pinterest (sem recarregar). Se o app não reagir, recarrega.
  function navigate(url) {
    closeLightbox(); hideTop();
    const target = new URL(url, location.origin);
    if (target.pathname + target.search === location.pathname + location.search) return;
    try {
      history.pushState(null, '', target.pathname + target.search);
      window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
    } catch { location.assign(url); return; }
    const key = location.pathname + location.search;
    setTimeout(() => {
      if (location.pathname + location.search === key && items.length === 0) {
        sessionStorage.setItem('pjr-reopen', '1');
        location.reload();
      }
    }, 3000);
  }

  // ---------- ativar / desativar ----------

  function setActive(on) {
    if (on === active) return;
    active = on;
    if (on) {
      if (!root) { buildUI(); observeGrid(); }
      root.classList.add('pjr-visible');
      document.documentElement.classList.add('pjr-active');
      collect();
      layout();
    } else if (root) {
      closeLightbox();
      hideTop();
      unmountAll();
      root.classList.remove('pjr-visible');
      document.documentElement.classList.remove('pjr-active');
    }
    if (fab) fab.classList.toggle('pjr-on', on);
  }

  function buildFab() {
    fab = document.createElement('button');
    fab.id = 'pjr-fab';
    fab.title = 'Pinteless (Alt+Shift+G)';
    fab.textContent = '▤';
    fab.addEventListener('click', () => setActive(!active));
    document.documentElement.appendChild(fab);
    fab.style.display = S.showButton ? '' : 'none';
  }

  // ---------- configurações ----------

  function save(patch) {
    Object.assign(S, patch);
    api.storage.sync.set(patch);
    onSettingsChanged(Object.keys(patch));
  }

  function onSettingsChanged(keys) {
    if (fab) fab.style.display = S.showButton ? '' : 'none';
    if (keys.includes('thumbQuality')) {
      unmountAll();
    }
    applyStyleVars();
    scheduleLayout();
  }

  api.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    const keys = [];
    for (const k of Object.keys(changes)) {
      if (k in PJR_DEFAULTS && changes[k].newValue !== undefined) { S[k] = changes[k].newValue; keys.push(k); }
    }
    if (keys.length) onSettingsChanged(keys);
  });

  api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === 'pjr-toggle') { setActive(!active); sendResponse({ active }); }
    else if (msg && msg.type === 'pjr-status') sendResponse({ active, count: items.length });
  });

  // ---------- teclado ----------

  document.addEventListener('keydown', e => {
    const t = e.target;
    const typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    if (e.altKey && e.shiftKey && (e.key === 'G' || e.key === 'g' || e.code === 'KeyG')) {
      e.preventDefault(); e.stopPropagation();
      setActive(!active);
      return;
    }
    if (!active) return;
    if (typing) {
      if (e.key === 'Escape' && root && root.contains(t)) {
        e.preventDefault();
        if (panel && panel.contains(t)) closePicker(); else hideTop();
      }
      return;
    }
    let handled = true;
    if (e.key === 'Escape') {
      if (pickerOpen) closePicker();
      else if (topbar?.classList.contains('pjr-open')) hideTop();
      else if (lbIndex >= 0) closeLightbox();
      else setActive(false);
    }
    else if (e.key === 's' || e.key === 'S') {
      const it = lbIndex >= 0 ? currentLbItem() : hoverItem;
      if (it) quickSave(it); else handled = false;
    }
    else if (e.key === '/' || (e.key.toLowerCase() === 'k' && (e.ctrlKey || e.metaKey))) showTop(true);
    else if (lbIndex >= 0 && e.key === 'ArrowRight') openLightbox(lbIndex + 1);
    else if (lbIndex >= 0 && e.key === 'ArrowLeft') openLightbox(lbIndex - 1);
    else if (e.key === '+' || e.key === '=') adjustSize(1);
    else if (e.key === '-' || e.key === '_') adjustSize(-1);
    else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  }, true);

  // ---------- inicialização ----------

  window.addEventListener('resize', () => { scheduleLayout(); positionPanel(); });
  // a barra de rolagem da galeria muda a largura útil sem disparar 'resize'
  let lastW = 0;
  const ro = new ResizeObserver(() => {
    if (grid && grid.clientWidth !== lastW) { lastW = grid.clientWidth; scheduleLayout(); }
  });
  const observeGrid = () => grid && ro.observe(grid);

  const mo = new MutationObserver(() => {
    clearTimeout(mo._t);
    mo._t = setTimeout(collect, 150);
  });
  mo.observe(document.body, { childList: true, subtree: true });

  // Pinterest é SPA: ao trocar de página, recomeça a coleta.
  setInterval(() => {
    const key = location.pathname + location.search;
    if (key !== pageKey) {
      pageKey = key;
      unmountAll();
      shownList = [];
      items.length = 0;
      byId.clear();
      closeLightbox();
      if (root) root.scrollTop = 0;
      setTimeout(renderTabs, 1200);
      setTimeout(() => { collect(); scheduleLayout(); }, 300);
    } else if (active) {
      checkNeedMore();
    }
  }, 700);

  api.storage.sync.get(PJR_DEFAULTS).then(stored => {
    S = { ...PJR_DEFAULTS, ...stored };
    buildFab();
    collect();
    let reopen = false;
    try { reopen = sessionStorage.getItem('pjr-reopen') === '1'; sessionStorage.removeItem('pjr-reopen'); } catch {}
    if (S.autoOpen || reopen) setActive(true);
  });
})();
