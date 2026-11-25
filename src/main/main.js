'use strict';
const path = require('node:path');
const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage, Notification } = require('electron');
const { DahuaClient } = require('./dahua');
const { StreamServer, SPEEDS } = require('./streams');
const { exportClips, snapshot, thumbnail } = require('./exporter');
const config = require('./config');

app.setName('Visor DVR');
// Datas e horas no formato brasileiro, independente do idioma do sistema.
app.commandLine.appendSwitch('lang', 'pt-BR');

let cfg;
let client = null;
let streams;
let win;
let tray = null;
let quitting = false;

const getClient = () => {
  if (!client) {
    if (!cfg.host || !cfg.pass) throw new Error('Configure o endereço, usuário e senha do DVR.');
    client = new DahuaClient({ host: cfg.host, user: cfg.user, pass: cfg.pass });
  }
  return client;
};

// --- validação de entrada vinda da interface ---
const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const isTime = (v) => Number.isFinite(v) && v > 946684800 && v < 4102444800; // 2000..2100
function checkChannel(c) { if (!isInt(c, 1, 64)) throw new Error('canal inválido'); }
function checkHost(h) {
  if (typeof h !== 'string' || !/^[a-zA-Z0-9.-]{1,253}$/.test(h)) throw new Error('Endereço do DVR inválido');
}

function createWindow() {
  const b = cfg.bounds || {};
  win = new BrowserWindow({
    width: b.width || 1400,
    height: b.height || 900,
    x: b.x,
    y: b.y,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0f1115',
    title: 'Visor DVR',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  if (b.maximized) win.maximize();
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.on('close', (e) => {
    // Lembra tamanho e posição da janela.
    try {
      cfg.bounds = { ...win.getNormalBounds(), maximized: win.isMaximized() };
      config.save(cfg);
    } catch { /* sem permissão para salvar: ignora */ }
    // Com o ícone na barra, fechar só esconde (e desconecta as câmeras). "Sair" fecha de verdade.
    if (tray && !quitting) {
      e.preventDefault();
      win.hide();
      win.webContents.send('app:visibility', false);
      if (!cfg.trayHintShown && Notification.isSupported()) {
        new Notification({ title: 'Visor DVR', body: 'Continua no ícone da barra do topo. Para fechar de vez, use "Sair" nesse ícone.' }).show();
        cfg.trayHintShown = true;
        try { config.save(cfg); } catch { /* ignora */ }
      }
    }
  });
  // Links externos nunca abrem dentro do app.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

function showWindow() {
  if (!win || win.isDestroyed()) { createWindow(); return; }
  const wasHidden = !win.isVisible();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (wasHidden) win.webContents.send('app:visibility', true);
}

function createTray() {
  try {
    tray = new Tray(nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'tray.png')));
  } catch (e) {
    console.error('[barra] sem ícone na barra:', e.message);
    tray = null;
    return;
  }
  tray.setToolTip('Visor DVR');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Abrir Visor DVR', click: showWindow },
    { label: 'Ao vivo', click: () => { showWindow(); win?.webContents.send('app:live'); } },
    { type: 'separator' },
    { label: 'Sair', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', showWindow);
}

function registerIpc() {
  ipcMain.handle('config:get', () => ({
    host: cfg.host, user: cfg.user, hasPass: Boolean(cfg.pass), outDir: cfg.outDir || app.getPath('videos'),
  }));

  ipcMain.handle('config:test', async (_e, c) => {
    checkHost(c.host);
    const pass = c.pass || cfg.pass;
    const info = await new DahuaClient({ host: c.host, user: String(c.user), pass }).deviceInfo();
    return { type: info.type, channels: info.channels.length };
  });

  ipcMain.handle('config:set', async (_e, c) => {
    checkHost(c.host);
    const next = { ...cfg, host: c.host, user: String(c.user || 'admin') };
    if (c.pass) next.pass = String(c.pass);
    if (typeof c.outDir === 'string' && c.outDir) next.outDir = c.outDir;
    config.save(next);
    cfg = next;
    client = null;
    return true;
  });

  ipcMain.handle('dvr:info', () => getClient().deviceInfo());
  ipcMain.handle('dvr:now', () => getClient().currentTime());

  ipcMain.handle('dvr:recordings', async (_e, { channels, start, end }) => {
    if (!Array.isArray(channels) || !isTime(start) || !isTime(end) || end <= start) throw new Error('busca inválida');
    const c = getClient();
    const out = {};
    for (const ch of channels) checkChannel(ch);
    let failed = 0;
    for (const ch of channels) {
      try {
        out[ch] = await c.findRecordings(ch, start, end);
      } catch (err) {
        failed++;
        out[ch] = [];
        console.error(`[gravações canal ${ch}]`, err.message);
        if (/senha|tempo esgotado|ECONN|EHOST/i.test(err.message) && failed === channels.length) throw err;
      }
    }
    return out;
  });

  ipcMain.handle('stream:open', (_e, { channel, mode, start, quality, lite, speed }) => {
    checkChannel(channel);
    if (!['live', 'playback'].includes(mode)) throw new Error('modo inválido');
    if (mode === 'playback' && !isTime(start)) throw new Error('horário inválido');
    getClient();
    return streams.create({
      channel, mode, start, quality: quality === 'single' ? 'single' : 'grid', lite: lite === true,
      speed: mode === 'playback' && SPEEDS.includes(speed) ? speed : 1,
    });
  });

  ipcMain.handle('dvr:storage', async (_e, { channels }) => {
    if (!Array.isArray(channels)) throw new Error('canais inválidos');
    const c = getClient();
    const { total, used } = await c.storage();
    let oldest = null;
    for (const ch of channels) {
      checkChannel(ch);
      const o = await c.oldestRecording(ch).catch(() => null);
      if (o != null && (oldest == null || o < oldest)) oldest = o;
    }
    return { total, used, oldest, now: await c.currentTime() };
  });

  ipcMain.handle('media:thumb', (_e, { channel, t }) => {
    checkChannel(channel);
    if (!isTime(t)) throw new Error('horário inválido');
    return thumbnail({ client: getClient(), channel, t: Math.floor(t) });
  });

  ipcMain.handle('media:liveFrame', async (_e, { channel }) => {
    checkChannel(channel);
    const jpg = await getClient().snapshotJpeg(channel);
    return jpg.length > 1000 ? `data:image/jpeg;base64,${jpg.toString('base64')}` : null;
  });

  ipcMain.handle('media:snapshot', (_e, { channel, name, t }) => {
    checkChannel(channel);
    if (t != null && !isTime(t)) throw new Error('horário inválido');
    return snapshot({
      client: getClient(), channel, name: String(name || `Canal ${channel}`),
      t: t == null ? null : Math.floor(t), dir: cfg.outDir || app.getPath('videos'),
    });
  });

  ipcMain.handle('export:chooseDir', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Onde salvar os recortes',
      defaultPath: cfg.outDir || app.getPath('videos'),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    cfg.outDir = r.filePaths[0];
    config.save(cfg);
    return cfg.outDir;
  });

  ipcMain.handle('export:run', async (e, { items, start, end, format, separate, grid }) => {
    if (!isTime(start) || !isTime(end) || end <= start) throw new Error('Intervalo inválido');
    if (end - start > 6 * 3600) throw new Error('O recorte pode ter no máximo 6 horas');
    if (!['original', 'compativel'].includes(format)) throw new Error('formato inválido');
    if (!Array.isArray(items) || !items.length) throw new Error('Escolha pelo menos uma câmera');
    if (!separate && !grid) throw new Error('Escolha arquivos separados, grade ou os dois');
    if (grid && items.length > 9) throw new Error('A grade aceita no máximo 9 câmeras');
    for (const it of items) checkChannel(it.channel);
    return exportClips({
      client: getClient(),
      items: items.map((it) => ({ channel: it.channel, name: String(it.name || `Canal ${it.channel}`) })),
      start: Math.floor(start), end: Math.floor(end), format, separate: Boolean(separate), grid: Boolean(grid),
      dir: cfg.outDir || app.getPath('videos'),
      onProgress: (p) => e.sender.send('export:progress', p),
    });
  });

  ipcMain.handle('shell:show', (_e, file) => {
    if (typeof file === 'string' && file.startsWith(cfg.outDir || app.getPath('videos'))) shell.showItemInFolder(file);
  });
}

// Uma janela só: abrir de novo (ícone, início do sistema) traz a que já está aberta.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) showWindow(); });
  app.on('before-quit', () => { quitting = true; });
}

app.whenReady().then(async () => {
  if (!app.hasSingleInstanceLock()) return;
  cfg = config.load();
  streams = new StreamServer(getClient);
  await streams.listen();
  registerIpc();
  createWindow();
  createTray();
  app.on('activate', showWindow);
});

app.on('window-all-closed', () => {
  streams?.close();
  app.quit();
});
