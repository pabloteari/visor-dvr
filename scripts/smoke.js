'use strict';
// Teste de ponta a ponta contra o DVR real. Uso (Linux, sem abrir janela na tela):
//   set -a; . ../.env; set +a; xvfb-run -a npx electron --no-sandbox scripts/smoke.js
// Salva capturas, fotos e recortes em $SMOKE_OUT (padrão: /tmp/visor-smoke).

const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow } = require('electron');

const OUT = process.env.SMOKE_OUT || '/tmp/visor-smoke';
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'clips'), { recursive: true });
app.setPath('userData', path.join(OUT, 'userdata'));
app.setPath('videos', path.join(OUT, 'clips'));

require('../src/main/main.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[smoke]', ...a);
const results = [];
const check = (name, ok, info = '') => { results.push({ name, ok }); log(ok ? 'OK  ' : 'FALHOU', name, info); };
const naive = (s) => Date.parse(s.replace(' ', 'T') + 'Z') / 1000;

async function shot(win, name) {
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, name), img.toPNG());
}

app.whenReady().then(async () => {
  let win;
  while (!(win = BrowserWindow.getAllWindows()[0])) await sleep(100);
  win.setSize(1400, 900);
  win.webContents.on('console-message', (e) => { if (['warning', 'error'].includes(e.level)) log('console:', e.message); });
  const js = (code) => win.webContents.executeJavaScript(code);
  await new Promise((r) => win.webContents.once('did-finish-load', r));
  const state = () => js(`({ mode: __visor.S.mode, paused: __visor.S.paused, speed: __visor.S.pbSpeed,
    pbStart: __visor.S.pbStart, pos: __visor.position(), shown: __visor.S.shown,
    tiles: [...__visor.S.tiles.values()].map(t => ({ ready: t.video.readyState, w: t.video.videoWidth, st: t.state.textContent })) })`);
  const waitFor = async (code, ms) => { for (let i = 0; i < ms / 500; i++) { if (await js(code)) return true; await sleep(500); } return false; };

  try {
    // 1. Ao vivo (stream principal, 960 de largura)
    await sleep(12000);
    let s = await state();
    check('ao vivo: 4 câmeras tocando no stream principal', s.mode === 'live' && s.tiles.length >= 4 && s.tiles.every((t) => t.ready >= 2 && t.w === 960), JSON.stringify(s.tiles));
    await shot(win, '01-ao-vivo.png');

    // 2. HD
    const hd = await js(`document.getElementById('hdInfo').textContent`);
    check('informação do HD', /HD .*guarda/.test(hd), hd);

    // 3. Reprodução 1x
    const T = naive(process.env.SMOKE_SEEK || '2026-11-23 10:00:00');
    await js(`__visor.seek(${T})`);
    await sleep(12000);
    s = await state();
    check('gravação 1x a partir das 10:00:00', s.mode === 'playback' && s.pbStart === T && s.pos > T + 3 && s.pos < T + 15, `pos=${s.pos - T}s`);
    await shot(win, '02-gravacao-1x.png');

    // 4. Velocidades
    for (const x of [4, 16]) {
      await js(`__visor.setSpeed(${x})`);
      await waitFor(`__visor.S.tiles.values().next().value.video.readyState >= 2 && __visor.S.tiles.values().next().value.video.currentTime > 1`, 20000);
      const a = await js('__visor.position()');
      const ta = Date.now();
      await sleep(6000);
      const b = await js('__visor.position()');
      const rate = (b - a) / ((Date.now() - ta) / 1000);
      s = await state();
      check(`velocidade ${x}x`, s.speed === x && rate > x * 0.6 && rate < x * 1.4 && s.tiles.every((t) => t.ready >= 2), `ritmo medido ${rate.toFixed(1)}x`);
      await shot(win, `03-velocidade-${x}x.png`);
    }
    await js(`__visor.setSpeed(1)`);
    await sleep(6000);

    // 5. Movimento
    const starts = await js(`__visor.motionStarts()`);
    check('movimentos marcados na linha do tempo', starts.length > 0, `${starts.length} trechos`);
    if (starts.length) {
      await js(`__visor.seek(${starts[0] - 120})`);
      await sleep(5000);
      await js(`__visor.jumpEvent(1)`);
      await sleep(6000);
      s = await state();
      check('pular para o próximo movimento', Math.abs(s.pbStart - (starts[0] - 3)) <= 1 && s.tiles.every((t) => t.ready >= 2),
        `foi para ${new Date(s.pbStart * 1000).toISOString().slice(11, 19)} ${JSON.stringify(s.tiles)}`);
      await shot(win, '04-movimento.png');
      await js(`__visor.seek(${T})`);
      await sleep(8000);
    }

    // 6. Zoom digital
    await js(`(() => { const t = __visor.S.tiles.get(__visor.S.shown[0]); __visor.setZoom(t, 3, -0.8, -0.3); })()`);
    const tr = await js(`__visor.S.tiles.get(__visor.S.shown[0]).video.style.transform`);
    s = await state();
    check('zoom digital (e as 4 tocando depois de voltar às 10:00)', /scale\(3\)/.test(tr) && s.tiles.every((t) => t.ready >= 2), `${tr} ${JSON.stringify(s.tiles)}`);
    await shot(win, '05-zoom.png');
    await js(`__visor.setZoom(__visor.S.tiles.get(__visor.S.shown[0]), 1, 0, 0)`);

    // 7. Foto (gravação e ao vivo)
    await js(`__visor.takeSnapshot(__visor.S.shown[1])`);
    await sleep(5000);

    // 8. Prévia
    const key = `${await js('__visor.S.shown[0]')}:${T + 300}`;
    await js(`__visor.requestThumb(__visor.S.shown[0], ${T + 300}, '${key}')`);
    await waitFor(`__visor.thumbs.has('${key}')`, 15000);
    check('miniatura de prévia', await js(`(__visor.thumbs.get('${key}') || '').startsWith('data:image/jpeg')`));

    // 9. Ordem e câmeras exibidas
    const orig = await js('__visor.S.shown');
    await js(`__visor.applyShown([${[orig[1], orig[0], orig[2]].join(',')}])`);
    await sleep(8000);
    s = await state();
    const saved = await js(`JSON.parse(localStorage.getItem('gridLayout'))`);
    check('esconder e reordenar câmeras (e lembrar)', s.shown.join() === [orig[1], orig[0], orig[2]].join() && saved.hidden.includes(orig[3]), JSON.stringify(saved));
    await shot(win, '06-tres-cameras.png');
    await js(`__visor.applyShown(${JSON.stringify(orig)})`);
    await sleep(6000);

    // 10. Recorte: separados + grade
    await js(`__visor.setCut(${T + 60}, ${T + 90}); document.getElementById('cutGrid').checked = true; document.getElementById('cutSeparate').checked = true;`);
    await js(`__visor.runCut()`);
    await waitFor(`!document.getElementById('cutGo').disabled`, 180000);
    await shot(win, '07-recorte.png');

    // Ao vivo + foto ao vivo
    await js(`__visor.goLive()`);
    await sleep(6000);
    await js(`__visor.takeSnapshot(__visor.S.shown[0])`);
    await sleep(6000);
    log('jobs:', await js(`[...document.querySelectorAll('#jobs li')].map(li => (li.className || '-') + ' ' + li.querySelector('.n').textContent + ' ' + li.querySelector('.s').textContent).join(' | ')`));
  } catch (e) {
    log('FALHA', e.stack || e);
    process.exitCode = 1;
  }
  const files = fs.readdirSync(path.join(OUT, 'clips'));
  log('arquivos:', files.join(', '));
  check('2 fotos salvas', files.filter((f) => f.endsWith('.jpg')).length === 2);
  check('recorte em grade salvo', files.some((f) => f.startsWith('Grade_')));
  check('4 recortes separados', files.filter((f) => f.endsWith('.mp4') && !f.startsWith('Grade_')).length === 4);
  log(`RESULTADO: ${results.filter((r) => r.ok).length}/${results.length} ok`);
  if (results.some((r) => !r.ok)) process.exitCode = 1;
  app.quit();
});
