'use strict';
// Configuração salva na pasta de dados do usuário. A senha é cifrada com o
// cofre do sistema (Keychain no Mac, DPAPI no Windows, keyring no Linux).

const fs = require('node:fs');
const path = require('node:path');
const { app, safeStorage } = require('electron');

const file = () => path.join(app.getPath('userData'), 'config.json');

function load() {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { /* primeira execução */ }
  let pass = '';
  if (raw.passEnc && safeStorage.isEncryptionAvailable()) {
    try { pass = safeStorage.decryptString(Buffer.from(raw.passEnc, 'base64')); } catch { pass = ''; }
  }
  const cfg = { host: raw.host || '', user: raw.user || 'admin', pass, outDir: raw.outDir || '', bounds: raw.bounds || null };
  // Para desenvolvimento: variáveis de ambiente preenchem o que estiver vazio.
  if (!cfg.host && process.env.DVR_HOST) cfg.host = process.env.DVR_HOST;
  if (!raw.user && process.env.DVR_USER) cfg.user = process.env.DVR_USER;
  if (!cfg.pass && process.env.DVR_PASS) cfg.pass = process.env.DVR_PASS;
  return cfg;
}

function save(cfg) {
  const out = { host: cfg.host, user: cfg.user, outDir: cfg.outDir || '', bounds: cfg.bounds || null };
  if (cfg.pass) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('O sistema não oferece armazenamento seguro para a senha.');
    out.passEnc = safeStorage.encryptString(cfg.pass).toString('base64');
  }
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(out, null, 2), { mode: 0o600 });
}

module.exports = { load, save };
