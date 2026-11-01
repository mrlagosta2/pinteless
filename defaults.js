// Configurações padrão, compartilhadas entre content script e popup.
var PJR_DEFAULTS = {
  autoOpen: false,        // abrir a galeria automaticamente ao carregar o Pinterest
  mode: 'height',         // 'height' = altura alvo da linha | 'count' = N imagens por linha
  rowHeight: 320,         // px (modo altura)
  perRow: 4,              // imagens por linha (modo quantidade)
  gap: 6,                 // espaço entre imagens, px
  maxRowVh: 100,          // altura máxima de uma linha, em % da altura da janela
  lastRow: 'left',        // 'left' = sem esticar, alinhada à esquerda | 'justify' | 'hide'
  thumbQuality: 'auto',   // 'auto' | '474x' | '736x' | 'originals'
  hideAds: true,          // ocultar pins promovidos
  hideVideos: false,      // ocultar pins de vídeo
  clickAction: 'lightbox',// 'lightbox' | 'pin' | 'newtab'
  radius: 4,              // arredondamento dos cantos, px
  background: '#111111',
  showButton: true        // botão flutuante para abrir/fechar
};

var PJR_API = typeof browser !== 'undefined' ? browser : chrome;

// No app desktop (Electron) este arquivo é carregado via require().
if (typeof module === 'object' && module.exports) module.exports = { PJR_DEFAULTS };
