(() => {
  'use strict';
  const api = PJR_API;
  const controls = [...document.querySelectorAll('[data-key]')];
  const toggle = document.getElementById('toggle');

  const fmt = {
    rowHeight: v => `${v}px`,
    perRow: v => `${v}`,
    gap: v => `${v}px`,
    maxRowVh: v => `${v}%`,
    radius: v => `${v}px`
  };

  function render(S) {
    for (const el of controls) {
      const k = el.dataset.key;
      if (el.type === 'checkbox') el.checked = !!S[k];
      else el.value = S[k];
      const out = el.parentElement.querySelector('.v');
      if (out) out.textContent = fmt[k] ? fmt[k](S[k]) : S[k];
    }
    for (const el of document.querySelectorAll('[data-show]')) {
      el.classList.toggle('hidden', el.dataset.show !== S.mode);
    }
  }

  function readValue(el) {
    if (el.type === 'checkbox') return el.checked;
    if (el.type === 'range') return Number(el.value);
    return el.value;
  }

  let S = { ...PJR_DEFAULTS };
  api.storage.sync.get(PJR_DEFAULTS).then(stored => { S = { ...PJR_DEFAULTS, ...stored }; render(S); });

  for (const el of controls) {
    el.addEventListener('input', () => {
      S[el.dataset.key] = readValue(el);
      render(S);
      api.storage.sync.set({ [el.dataset.key]: S[el.dataset.key] });
    });
  }

  document.getElementById('reset').addEventListener('click', () => {
    S = { ...PJR_DEFAULTS };
    render(S);
    api.storage.sync.set(S);
  });

  // Botão de abrir/fechar: conversa com o content script da aba ativa.
  async function activeTab() {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    return tab;
  }

  async function refreshToggle() {
    try {
      const tab = await activeTab();
      const res = await api.tabs.sendMessage(tab.id, { type: 'pjr-status' });
      toggle.textContent = res.active ? 'Fechar galeria' : 'Abrir galeria nesta aba';
      toggle.disabled = false;
    } catch {
      toggle.textContent = 'Abra uma página do Pinterest';
      toggle.disabled = true;
    }
  }

  toggle.addEventListener('click', async () => {
    const tab = await activeTab();
    await api.tabs.sendMessage(tab.id, { type: 'pjr-toggle' });
    window.close();
  });

  refreshToggle();
})();
