'use strict';
// Onde estão os arquivos da extensão (content.js, page.js, popup.html...).
// Em desenvolvimento: a raiz do repositório. No app empacotado: a pasta "ext"
// copiada pelo electron-builder.
const path = require('path');
const fs = require('fs');

const packaged = path.join(__dirname, 'ext');
const EXT_DIR = fs.existsSync(path.join(packaged, 'content.js')) ? packaged : path.join(__dirname, '..');

module.exports = { EXT_DIR };
