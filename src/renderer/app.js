'use strict';
/* global mpegts, Timeline, TL_COLORS */

const api = window.dvr;
const $ = (id) => document.getElementById(id);

// Ao trocar de horário, a conexão antiga é fechada de propósito e o mpegts.js avisa "Early-EOF".
window.addEventListener('unhandledrejection', (e) => {
  if (/Early-EOF/.test(e.reason?._message || '')) e.preventDefault();
});
const errMsg = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

// ---------- preferências salvas ----------
const pref = {
  get(k, def) { try { const v = localStorage.getItem(k); return v == null ? def : JSON.parse(v); } catch { return def; } },
  set(k, v) { localStorage.setItem(k, JSON.stringify(v)); },
};

// ---------- tempo ("segundos ingênuos": horário do DVR tratado como UTC) ----------
const p2 = (n) => String(n).padStart(2, '0');
function fmt(t, sep = ' ') {
  const d = new Date(t * 1000);
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}${sep}` +
    `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`;
}
const fmtBr = (t) => { const s = fmt(t); return `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)} ${s.slice(11)}`; };
const fmtBrDay = (t) => fmtBr(t).slice(0, 10);
// Aceita "dd/mm/aaaa hh:mm[:ss]", "dd/mm/aaaa" ou só "hh:mm[:ss]" (usa o dia informado).
function parseBr(str, day = null) {
  const s = (str || '').trim();
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (m) {
    const [d, mo, y, h, mi, se] = [+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)];
    const t = Date.UTC(y, mo - 1, d, h, mi, se) / 1000;
    const back = new Date(t * 1000);
    if (back.getUTCDate() !== d || back.getUTCMonth() !== mo - 1 || h > 23 || mi > 59 || se > 59) return null;
    return t;
  }
  m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (m && day != null && +m[1] < 24 && +m[2] < 60 && +(m[3] || 0) < 60) return day + +m[1] * 3600 + +m[2] * 60 + +(m[3] || 0);
  return null;
}
const dayOf = (t) => Math.floor(t / 86400) * 86400;
const dur = (s) => {
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}h${p2(m)}m${p2(r)}s` : m ? `${m}m${p2(r)}s` : `${r}s`;
};

// ---------- estado ----------
const S = {
  channels: [],         // todos os canais do DVR [{channel, name}]
  shown: [],            // canais exibidos na grade, na ordem
  clockOffset: 0,       // relógio do DVR - relógio do computador
  mode: 'live',         // 'live' | 'playback'
  paused: false,
  pausedAt: null,
  pbStart: 0,           // horário pedido ao DVR para a reprodução atual
  pbSpeed: 1,           // velocidade com que a reprodução atual foi aberta
  speed: [1, 2, 4, 8, 16].includes(pref.get('speed', 1)) ? pref.get('speed', 1) : 1,
  single: null,         // canal ampliado (duplo clique) ou null
  day: 0,
  recs: {},             // canal -> [{start,end,motion}] do dia exibido
  hadRec: new Set(),    // canais com gravação (hoje ou ontem)
  tiles: new Map(),     // canal -> { el, video, state, player, gen, lastT, stallSince, zoom }
};
const dvrNow = () => Date.now() / 1000 + S.clockOffset;
const chName = (ch) => S.channels.find((c) => c.channel === ch)?.name || `Canal ${ch}`;

function toast(msg, ms = 3500) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.h);
  toast.h = setTimeout(() => t.classList.remove('show'), ms);
}

// ---------- posição atual ----------
function position() {
  if (S.mode === 'live') return dvrNow();
  if (S.paused) return S.pausedAt;
  for (const ch of visibleChannels()) {
    const v = S.tiles.get(ch)?.video;
    if (v && v.readyState >= 2 && v.currentTime > 0) return S.pbStart + v.currentTime * S.pbSpeed;
  }
  return S.pbStart;
}

const visibleChannels = () => (S.single ? [S.single] : S.shown);

// ---------- câmeras exibidas e ordem ----------
const hasRecordings = (ch) => S.hadRec?.has(ch) || (S.recs[ch] || []).length > 0;
function computeShown() {
  const all = S.channels.map((c) => c.channel);
  const withRec = all.filter(hasRecordings);
  const saved = pref.get('gridLayout', null);
  if (!saved) return withRec.length ? withRec : all.slice(0, 4);
  const order = saved.order.filter((ch) => all.includes(ch));
  for (const ch of all) if (!order.includes(ch)) order.push(ch);
  const hidden = new Set(saved.hidden);
  // Canal novo (que não existia quando o layout foi salvo) aparece só se tiver gravação.
  for (const ch of all) if (!saved.order.includes(ch) && !withRec.includes(ch)) hidden.add(ch);
  const shown = order.filter((ch) => !hidden.has(ch));
  return shown.length ? shown : withRec.length ? withRec : all.slice(0, 4);
}

function saveLayout() {
  const all = S.channels.map((c) => c.channel);
  const order = [...S.shown, ...all.filter((ch) => !S.shown.includes(ch))];
  pref.set('gridLayout', { order, hidden: all.filter((ch) => !S.shown.includes(ch)) });
}

function applyShown(shown, save = true) {
  const at = position();
  S.shown = shown;
  if (S.single && !shown.includes(S.single)) S.single = null;
  if (save) saveLayout();
  stopAll();
  buildGrid();
  drawRows();
  syncCutCams();
  if (S.mode === 'live' && !S.paused) startAll();
  else { S.paused = false; startAll(at); }
}

// ---------- grade ----------
function buildGrid() {
  const grid = $('grid');
  grid.innerHTML = '';
  S.tiles.clear();
  for (const ch of S.shown) {
    const el = document.createElement('div');
    el.className = 'tile';
    el.dataset.ch = ch;
    el.innerHTML = '<video muted playsinline></video><div class="state"></div>' +
      '<div class="name" draggable="true" title="Arraste para mudar a ordem"></div>' +
      '<div class="tools"><button class="zoomLabel" title="Zoom (roda do mouse). Clique para voltar a 1×">1×</button>' +
      '<button class="snap" title="Salvar foto deste quadro">📷</button></div>';
    el.querySelector('.name').textContent = chName(ch);
    grid.appendChild(el);
    const video = el.querySelector('video');
    video.addEventListener('ended', () => onEnded(ch));
    const t = { el, video, state: el.querySelector('.state'), player: null, gen: 0, lastT: 0, stallSince: 0, zoom: { z: 1, x: 0, y: 0 } };
    S.tiles.set(ch, t);
    bindTile(ch, t);
  }
  layoutGrid();
}

function bindTile(ch, t) {
  const el = t.el;
  el.addEventListener('dblclick', (e) => { if (!e.target.closest('.tools')) toggleSingle(ch); });
  el.querySelector('.zoomLabel').onclick = (e) => { e.stopPropagation(); setZoom(t, 1, 0, 0); };
  el.querySelector('.snap').onclick = (e) => { e.stopPropagation(); takeSnapshot(ch); };

  // Zoom digital: roda do mouse aproxima em torno do cursor; arrastar move a imagem.
  el.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = el.getBoundingClientRect();
    const u = (e.clientX - r.left) / r.width;
    const v = (e.clientY - r.top) / r.height;
    const { z, x, y } = t.zoom;
    const nz = Math.min(8, Math.max(1, z * (e.deltaY < 0 ? 1.25 : 0.8)));
    setZoom(t, nz, u - (u - x) * (nz / z), v - (v - y) * (nz / z));
  }, { passive: false });
  el.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || t.zoom.z <= 1 || e.target.closest('.tools, .name')) return;
    e.preventDefault();
    const r = el.getBoundingClientRect();
    const start = { cx: e.clientX, cy: e.clientY, x: t.zoom.x, y: t.zoom.y };
    el.classList.add('panning');
    const move = (ev) => setZoom(t, t.zoom.z, start.x + (ev.clientX - start.cx) / r.width, start.y + (ev.clientY - start.cy) / r.height);
    const up = () => { el.classList.remove('panning'); window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });

  // Arrastar pelo nome para trocar a câmera de lugar.
  const name = el.querySelector('.name');
  name.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', String(ch)); e.dataTransfer.effectAllowed = 'move'; });
  el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('drag-over'); });
  el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    el.classList.remove('drag-over');
    const from = Number(e.dataTransfer.getData('text/plain'));
    if (!from || from === ch) return;
    const order = [...S.shown];
    const i = order.indexOf(from);
    const j = order.indexOf(ch);
    if (i < 0 || j < 0) return;
    [order[i], order[j]] = [order[j], order[i]];
    S.shown = order;
    // Só reordena os elementos, sem reconectar as câmeras.
    const grid = $('grid');
    for (const c of order) grid.appendChild(S.tiles.get(c).el);
    saveLayout();
    drawRows();
    syncCutCams();
  });
}

function setZoom(t, z, x, y) {
  z = Math.min(8, Math.max(1, z));
  x = Math.min(0, Math.max(1 - z, x));
  y = Math.min(0, Math.max(1 - z, y));
  if (z <= 1.001) { z = 1; x = 0; y = 0; }
  t.zoom = { z, x, y };
  t.video.style.transform = z === 1 ? '' : `translate(${x * 100}%, ${y * 100}%) scale(${z})`;
  t.el.classList.toggle('zoomed', z > 1);
  t.el.querySelector('.zoomLabel').textContent = `${z.toFixed(z < 2 ? 1 : 0).replace('.0', '')}×`;
}

function layoutGrid() {
  const n = visibleChannels().length;
  const cols = n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4;
  $('grid').style.setProperty('--cols', cols);
  for (const [ch, t] of S.tiles) t.el.classList.toggle('single-hidden', Boolean(S.single) && ch !== S.single);
}

function stopTile(t) {
  t.gen++;
  if (t.player) {
    try { t.player.pause(); t.player.unload(); t.player.detachMediaElement(); t.player.destroy(); } catch { /* já encerrado */ }
    t.player = null;
  }
  t.video.removeAttribute('src');
  t.video.load();
}

function stopAll() { for (const t of S.tiles.values()) stopTile(t); }

// Guarda o quadro que está na tela como "poster" do vídeo, para não ficar preto enquanto a
// próxima conexão abre. Reduz para 640 px de largura (rápido e leve).
function keepFrame(t) {
  const v = t.video;
  if (!t.player || !v.videoWidth || v.readyState < 2) return;
  try {
    const w = Math.min(640, v.videoWidth);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = Math.round((v.videoHeight / v.videoWidth) * w);
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
    v.poster = c.toDataURL('image/jpeg', 0.8);
  } catch { /* sem quadro disponível */ }
}

function setLoading(t, on, text = '') {
  t.el.classList.toggle('loading', on);
  t.state.textContent = on ? text : '';
}

// Sem quadro guardado: busca uma imagem rápida para preencher (foto do ao vivo ou miniatura da gravação).
async function placeholder(ch, t, gen, start) {
  try {
    const src = S.mode === 'live' ? await api.liveFrame({ channel: ch }) : await api.thumb({ channel: ch, t: start });
    if (src && gen === t.gen && t.el.classList.contains('loading') && !t.video.poster) t.video.poster = src;
  } catch { /* fica o fundo animado */ }
}

async function startTile(ch, start) {
  const t = S.tiles.get(ch);
  if (!t) return;
  keepFrame(t);
  stopTile(t);
  const gen = t.gen;
  setLoading(t, true, S.mode === 'live' ? 'Conectando…' : `Carregando ${fmtBr(start).slice(11)}…`);
  if (!t.video.poster) placeholder(ch, t, gen, start);
  t.lastT = 0;
  t.stallSince = Date.now();
  let url;
  try {
    url = await api.openStream({
      channel: ch, mode: S.mode, start, quality: S.single === ch ? 'single' : 'grid',
      lite: pref.get('liveQuality', 'alta') === 'leve',
      speed: S.mode === 'playback' ? S.pbSpeed : 1,
    });
  } catch (e) {
    setLoading(t, true, errMsg(e));
    return;
  }
  if (gen !== t.gen) return;
  const live = S.mode === 'live';
  const player = mpegts.createPlayer({ type: 'mpegts', isLive: true, url }, {
    enableWorker: false,
    enableStashBuffer: false,
    liveBufferLatencyChasing: live,
    liveBufferLatencyMaxLatency: 2.5,
    liveBufferLatencyMinRemain: 0.4,
    autoCleanupSourceBuffer: true,
    autoCleanupMaxBackwardDuration: 20,
    autoCleanupMinBackwardDuration: 10,
  });
  t.player = player;
  player.on(mpegts.Events.ERROR, () => {
    if (gen !== t.gen) return;
    setLoading(t, true, 'Sem sinal, tentando de novo…');
    setTimeout(() => { if (gen === t.gen) restartTile(ch); }, 4000);
  });
  player.attachMediaElement(t.video);
  player.load();
  t.video.play().catch(() => {});
  t.video.onplaying = () => { if (gen === t.gen) setLoading(t, false); };
}

function restartTile(ch) {
  if (S.paused) return;
  if (S.mode === 'live') startTile(ch);
  else startAll(position()); // na gravação, reinicia todas para manter a sincronia
}

function onEnded(ch) {
  if (S.mode === 'playback' && !S.paused && ch === visibleChannels()[0]) startAll(position());
}

function startAll(start) {
  if (S.mode === 'playback') {
    S.pbStart = Math.floor(start);
    S.pbSpeed = S.speed;
  }
  for (const [ch, t] of S.tiles) {
    if (visibleChannels().includes(ch)) startTile(ch, S.pbStart);
    else stopTile(t);
  }
  updateModeUi();
}

// Detecta imagem congelada (o DVR às vezes para de mandar dados sem fechar a conexão).
setInterval(() => {
  if (S.paused) return;
  for (const ch of visibleChannels()) {
    const t = S.tiles.get(ch);
    if (!t?.player) continue;
    const ct = t.video.currentTime;
    if (ct !== t.lastT) { t.lastT = ct; t.stallSince = Date.now(); continue; }
    if (Date.now() - t.stallSince > 15000) {
      t.stallSince = Date.now();
      setLoading(t, true, 'Reconectando…');
      restartTile(ch);
      if (S.mode === 'playback') return;
    }
  }
}, 2000);

// ---------- navegação ----------
function covered(t) {
  return S.shown.some((ch) => (S.recs[ch] || []).some((s) => t >= s.start && t < s.end));
}
function nextRecording(t) {
  let best = null;
  for (const ch of S.shown) for (const s of S.recs[ch] || []) if (s.start > t && (best == null || s.start < best)) best = s.start;
  return best;
}

async function seek(t) {
  if (t >= dvrNow() - 5) { goLive(); return; }
  if (dayOf(t) !== S.day) await loadDay(dayOf(t));
  if (!covered(t)) {
    const n = nextRecording(t);
    if (n == null || n > dvrNow() - 5) { toast('Não há gravação nesse horário.'); return; }
    toast(`Sem gravação nesse horário. Indo para ${fmtBr(n).slice(11)}.`);
    t = n;
  }
  S.mode = 'playback';
  S.paused = false;
  startAll(t);
}

function goLive() {
  S.mode = 'live';
  S.paused = false;
  startAll();
  if (dayOf(dvrNow()) !== S.day) loadDay(dayOf(dvrNow()));
}

function togglePause() {
  if (S.paused) {
    S.paused = false;
    if (S.mode === 'live') startAll(); else startAll(S.pausedAt);
  } else {
    S.pausedAt = position();
    if (S.mode === 'live') S.mode = 'playback';
    S.paused = true;
    // Guarda o último quadro como imagem e encerra a conexão com o DVR.
    for (const t of S.tiles.values()) {
      keepFrame(t);
      stopTile(t);
      setLoading(t, false);
    }
  }
  updateModeUi();
}

function step(d) {
  const base = position();
  S.paused = false;
  seek(Math.max(0, base + d));
}

function setSpeed(x) {
  S.speed = x;
  pref.set('speed', x);
  $('speed').value = String(x);
  if (S.mode === 'playback' && !S.paused) startAll(position());
  else if (S.mode === 'live' && x !== 1) toast('A velocidade vale para as gravações. Volte no tempo para usar.');
}

// Movimento: pula para o início do próximo/anterior trecho marcado pelo DVR.
function motionStarts() {
  const out = [];
  for (const ch of S.shown) for (const s of S.recs[ch] || []) if (s.motion) out.push(s.start);
  return out.sort((a, b) => a - b);
}
function jumpEvent(dir) {
  const pos = position();
  const starts = motionStarts();
  const t = dir > 0 ? starts.find((s) => s > pos + 1) : [...starts].reverse().find((s) => s < pos - 3);
  if (t == null) {
    toast(starts.length ? `Nenhum movimento ${dir > 0 ? 'depois' : 'antes'} deste horário no dia ${fmtBrDay(S.day)}.`
      : `Nenhum movimento marcado em ${fmtBrDay(S.day)}.`);
    return;
  }
  // Começa 3 s antes para ver a chegada.
  seek(Math.max(t - 3, dayOf(t)));
}

function toggleSingle(ch) {
  const at = position();
  S.single = S.single === ch ? null : ch;
  layoutGrid();
  if (S.paused) {
    S.paused = false;
    startAll(at);
  } else startAll(S.mode === 'live' ? undefined : at);
  syncCutCams();
}

function updateModeUi() {
  const m = $('mode');
  m.className = 'mode' + (S.paused ? ' paused' : S.mode === 'playback' ? ' playback' : '');
  const sp = S.mode === 'playback' && !S.paused && S.pbSpeed > 1 ? ` ${S.pbSpeed}×` : '';
  m.textContent = S.paused ? 'PAUSADO' : S.mode === 'live' ? 'AO VIVO' : 'GRAVAÇÃO' + sp;
  $('playPause').textContent = S.paused ? '▶' : '⏸';
  $('goLive').disabled = S.mode === 'live' && !S.paused;
}

// ---------- foto ----------
async function takeSnapshot(ch) {
  const t = S.mode === 'live' && !S.paused ? null : Math.floor(position());
  const li = addJob(`Foto ${chName(ch)} ${t == null ? '(ao vivo)' : fmtBr(t).slice(11)}`);
  li.set('salvando…');
  try {
    const file = await api.snapshot({ channel: ch, name: chName(ch), t });
    li.done(file);
    toast('Foto salva.');
  } catch (e) {
    li.fail(errMsg(e));
  }
}

// ---------- dia / linha do tempo ----------
const thumbs = new Map();
let hoverKey = null;
let hoverTimer = null;
let thumbBusy = false;
let thumbWanted = null;

const timeline = new Timeline($('timeline'), $('tip'), {
  onSeek: (t) => seek(t),
  onSelect: (a, b) => setCut(a, b),
  onHover: (t) => hoverPreview(t),
  onLeave: () => { clearTimeout(hoverTimer); hoverKey = null; $('tip').classList.remove('has-img'); },
});

// Prévia: miniatura do horário sob o mouse (da câmera ampliada ou da primeira da grade).
function hoverPreview(t) {
  const ch = S.single || S.shown[0];
  if (!ch || t > dvrNow() - 10 || !(S.recs[ch] || []).some((s) => t >= s.start && t < s.end)) {
    hoverKey = null;
    $('tip').classList.remove('has-img');
    return;
  }
  const tt = Math.round(t / 5) * 5;
  const key = `${ch}:${tt}`;
  if (key === hoverKey) return;
  hoverKey = key;
  if (thumbs.has(key)) { showThumb(key); return; }
  $('tip').classList.remove('has-img');
  clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => requestThumb(ch, tt, key), 250);
}

function showThumb(key) {
  const src = thumbs.get(key);
  if (key !== hoverKey || !src) return;
  $('tipImg').src = src;
  $('tip').classList.add('has-img');
}

async function requestThumb(ch, t, key) {
  if (thumbBusy) { thumbWanted = [ch, t, key]; return; }
  thumbBusy = true;
  try {
    const src = await api.thumb({ channel: ch, t });
    if (src) {
      thumbs.set(key, src);
      if (thumbs.size > 300) thumbs.delete(thumbs.keys().next().value);
      showThumb(key);
    }
  } catch { /* sem prévia nesse ponto */ }
  thumbBusy = false;
  if (thumbWanted) {
    const [c, tt, k] = thumbWanted;
    thumbWanted = null;
    if (k === hoverKey && !thumbs.has(k)) requestThumb(c, tt, k);
  }
}

async function loadDay(day) {
  S.day = day;
  $('day').value = fmtBrDay(day);
  $('day').classList.remove('invalid');
  timeline.setDay(day);
  timeline.setRows([]);
  try {
    S.recs = await api.recordings({ channels: S.channels.map((c) => c.channel), start: day, end: day + 86399 });
  } catch (e) {
    S.recs = {};
    toast('Erro ao buscar gravações: ' + errMsg(e));
  }
  drawRows();
}

function drawRows() {
  timeline.setRows(S.shown.map((ch, i) => ({
    name: chName(ch),
    color: TL_COLORS[i % TL_COLORS.length],
    segs: S.recs[ch] || [],
  })));
}

let lastPosDay = null;
function tick() {
  const pos = position();
  $('clock').textContent = fmtBr(pos);
  timeline.setNow(dvrNow());
  timeline.setPlayhead(pos);
  // Acompanha a virada do dia durante a reprodução.
  const pd = dayOf(pos);
  if (lastPosDay != null && pd !== lastPosDay && lastPosDay === S.day) loadDay(pd);
  lastPosDay = pd;
  requestAnimationFrame(() => setTimeout(tick, 250));
}

// Atualiza as gravações do dia de hoje (novos trechos e movimentos) a cada minuto.
setInterval(() => { if (S.channels.length && S.day === dayOf(dvrNow())) refreshToday(); }, 60000);
async function refreshToday() {
  try {
    S.recs = await api.recordings({ channels: S.channels.map((c) => c.channel), start: S.day, end: S.day + 86399 });
    drawRows();
  } catch { /* tenta no próximo minuto */ }
}

// ---------- HD ----------
async function refreshStorage() {
  try {
    const st = await api.storage({ channels: S.shown });
    const gb = (b) => (b / 1e9 >= 1000 ? `${(b / 1e12).toFixed(1)} TB` : `${Math.round(b / 1e9)} GB`);
    const pct = st.total ? Math.round((st.used / st.total) * 100) : 0;
    let txt = `HD ${gb(st.total)} · ${pct}% usado`;
    let warn = false;
    if (st.oldest) {
      const days = (st.now - st.oldest) / 86400;
      txt += ` · guarda ~${days >= 2 ? Math.floor(days) + ' dias' : Math.round(days * 24) + ' h'} (desde ${fmtBr(st.oldest).slice(0, 16)})`;
      warn = days < 3;
    }
    $('hdInfo').textContent = txt;
    $('hdInfo').classList.toggle('warn', warn);
    $('hdInfo').title = pct >= 99
      ? 'O HD está cheio: o DVR apaga a gravação mais antiga para gravar a nova. Salve recortes importantes antes que sumam.'
      : 'Espaço do HD do DVR';
  } catch { /* mostra na próxima atualização */ }
}
setInterval(() => { if (S.channels.length) refreshStorage(); }, 30 * 60000);

// ---------- lista de tarefas (recortes e fotos) ----------
function addJob(label) {
  const li = document.createElement('li');
  li.innerHTML = '<span class="n"></span><progress max="1" value="0"></progress><span class="s">na fila</span>';
  li.querySelector('.n').textContent = label;
  $('jobs').prepend(li);
  while ($('jobs').children.length > 30) $('jobs').lastChild.remove();
  const bar = li.querySelector('progress');
  const s = li.querySelector('.s');
  return {
    set(text, frac) { s.textContent = text; if (frac == null) bar.removeAttribute('value'); else bar.value = frac; },
    done(file) {
      bar.value = 1;
      li.className = 'ok';
      s.textContent = 'pronto';
      const b = document.createElement('button');
      b.className = 'link';
      b.textContent = 'mostrar na pasta';
      b.onclick = () => api.showFile(file);
      li.appendChild(b);
    },
    fail(msg) { li.className = 'err'; s.textContent = 'erro: ' + msg; },
  };
}

// ---------- recorte ----------
function setCut(a, b) {
  if (a != null) $('cutStart').value = fmtBr(a);
  if (b != null) $('cutEnd').value = fmtBr(b);
  refreshCut();
}

function refreshCut() {
  const a = parseBr($('cutStart').value, S.day);
  const b = parseBr($('cutEnd').value, S.day);
  $('cutStart').classList.toggle('invalid', a == null);
  $('cutEnd').classList.toggle('invalid', b == null);
  timeline.setSelection(a, b);
  $('cutLen').textContent = a != null && b != null ? (b > a ? dur(b - a) : 'fim antes do início') : '';
  if (a != null && b != null) pref.set('lastCut', { a, b });
}

function syncCutCams() {
  const box = $('cutCams');
  box.innerHTML = '';
  for (const ch of S.shown) {
    const l = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = ch;
    cb.checked = S.single ? ch === S.single : true;
    l.append(cb, document.createTextNode(chName(ch)));
    box.appendChild(l);
  }
}

async function runCut() {
  const start = parseBr($('cutStart').value, S.day);
  const end = parseBr($('cutEnd').value, S.day);
  if (start == null || end == null || end <= start) { toast('Escolha início e fim do recorte.'); return; }
  const items = [...$('cutCams').querySelectorAll('input:checked')].map((cb) => ({ channel: Number(cb.value), name: chName(Number(cb.value)) }));
  if (!items.length) { toast('Marque pelo menos uma câmera.'); return; }
  const separate = $('cutSeparate').checked;
  const grid = $('cutGrid').checked;
  if (!separate && !grid) { toast('Marque "arquivos separados", "vídeo em grade" ou os dois.'); return; }

  const span = `${fmtBr(start).slice(11)} → ${fmtBr(end).slice(11)}`;
  const rows = new Map();
  for (const it of items) rows.set(it.channel, addJob(`${it.name}  ${span}`));
  if (grid) rows.set('grade', addJob(`Grade (${items.length} câmeras)  ${span}`));
  const gridRow = rows.get('grade');
  const off = api.onExportProgress((p) => {
    const job = rows.get(p.key);
    if (!job) return;
    if (p.stage === 'baixando') {
      job.set(`baixando ${(p.got / 1048576).toFixed(1)} MB` + (p.total ? ` de ${(p.total / 1048576).toFixed(1)} MB` : ''),
        p.total ? p.got / p.total : 0);
      gridRow?.set('aguardando as câmeras…', 0);
    } else if (p.stage === 'baixado') job.set('baixado (usado na grade)', 1);
    else if (p.stage === 'convertendo') job.set(p.key === 'grade' ? 'montando a grade…' : 'convertendo para MP4…');
    else if (p.stage === 'pronto') job.done(p.file);
    else if (p.stage === 'erro') job.fail(p.error);
  });
  $('cutGo').disabled = true;
  try {
    await api.exportClip({ items, start, end, format: $('cutFormat').value, separate, grid });
  } catch (e) {
    toast('Erro no recorte: ' + errMsg(e));
  } finally {
    off();
    $('cutGo').disabled = false;
  }
}

async function showOutDir() {
  const c = await api.getConfig();
  $('cutDir').textContent = `Pasta: ${c.outDir}`;
  $('cutDir').title = `${c.outDir} (clique para alterar)`;
}

// ---------- câmeras da grade ----------
function openCams() {
  const box = $('camsList');
  box.innerHTML = '';
  for (const c of S.channels) {
    const l = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = c.channel;
    cb.checked = S.shown.includes(c.channel);
    const has = hasRecordings(c.channel);
    l.append(cb, document.createTextNode(`${c.channel}. ${c.name}`));
    if (!has) { const sm = document.createElement('small'); sm.textContent = '(sem gravação, só ao vivo)'; l.append(sm); }
    box.appendChild(l);
  }
  $('camsDlg').showModal();
}

function applyCams() {
  const checked = [...$('camsList').querySelectorAll('input:checked')].map((cb) => Number(cb.value));
  if (!checked.length) { toast('Deixe pelo menos uma câmera.'); return false; }
  // Mantém a ordem atual e põe as novas no fim.
  const shown = [...S.shown.filter((ch) => checked.includes(ch)), ...checked.filter((ch) => !S.shown.includes(ch))];
  if (shown.join() !== S.shown.join()) applyShown(shown);
  return true;
}

// ---------- configurações ----------
async function openSettings(required = false) {
  const c = await api.getConfig();
  $('cfgHost').value = c.host || '';
  $('cfgUser').value = c.user || 'admin';
  $('cfgPass').value = '';
  $('cfgPass').placeholder = c.hasPass ? '(senha salva, deixe em branco para manter)' : '';
  $('cfgMsg').textContent = '';
  $('cfgMsg').className = 'msg';
  $('cfgCancel').hidden = required;
  $('settings').showModal();
}

async function saveSettings() {
  const c = { host: $('cfgHost').value.trim(), user: $('cfgUser').value.trim(), pass: $('cfgPass').value };
  const msg = $('cfgMsg');
  msg.className = 'msg';
  msg.textContent = 'Testando conexão…';
  $('cfgSave').disabled = true;
  try {
    const r = await api.testConfig(c);
    await api.setConfig(c);
    msg.textContent = `Conectado: ${r.type} (${r.channels} canais)`;
    $('settings').close();
    await init();
  } catch (e) {
    msg.className = 'msg err';
    msg.textContent = errMsg(e);
  } finally {
    $('cfgSave').disabled = false;
  }
}

// ---------- início ----------
async function init() {
  stopAll();
  let info;
  try {
    info = await api.info();
  } catch (e) {
    toast(errMsg(e), 6000);
    openSettings(true);
    return;
  }
  S.channels = info.channels;
  S.clockOffset = info.now - Date.now() / 1000;
  S.day = dayOf(info.now);
  $('day').value = fmtBrDay(S.day);
  timeline.setDay(S.day);
  // Monta a grade já, com as câmeras que gravavam da última vez, e liga o ao vivo.
  // A busca de gravações (lenta no DVR, até ~15 s) vem depois, em segundo plano.
  S.hadRec = new Set(pref.get('hadRec', []));
  S.recs = {};
  S.shown = computeShown();
  S.single = null;
  buildGrid();
  drawRows();
  syncCutCams();
  showOutDir();
  goLive();
  setTimeout(async () => {
    await loadDayAllChannels(S.day);
    pref.set('hadRec', [...S.hadRec]);
    const shown = computeShown();
    if (shown.join() !== S.shown.join()) applyShown(shown, false);
    else { drawRows(); syncCutCams(); }
    refreshStorage();
  }, 1500);
  const last = pref.get('lastCut', null);
  if (!$('cutStart').value) {
    if (last && last.b > last.a) setCut(last.a, last.b);
    else { const now = Math.floor(info.now); setCut(now - 300, now - 240); }
  }
}

// Busca hoje e ontem: uma câmera que gravou ontem mas não hoje ainda conta como "grava".
async function loadDayAllChannels(day) {
  const chs = S.channels.map((c) => c.channel);
  let recs = {};
  try {
    recs = await api.recordings({ channels: chs, start: day - 86400, end: day + 86399 });
  } catch { /* sem gravações */ }
  S.recs = {};
  for (const ch of chs) S.recs[ch] = (recs[ch] || []).filter((s) => s.end > day);
  S.hadRec = new Set(chs.filter((ch) => (recs[ch] || []).length));
}

// ---------- eventos ----------
document.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => step(Number(b.dataset.step))));
$('playPause').onclick = togglePause;
$('goLive').onclick = goLive;
$('speed').value = String(S.speed);
$('speed').onchange = () => setSpeed(Number($('speed').value));
$('prevEvent').onclick = () => jumpEvent(-1);
$('nextEvent').onclick = () => jumpEvent(1);
$('liveQuality').value = pref.get('liveQuality', 'alta') === 'leve' ? 'leve' : 'alta';
$('liveQuality').onchange = () => {
  pref.set('liveQuality', $('liveQuality').value);
  if (S.mode === 'live' && !S.paused) startAll();
};
$('jumpBtn').onclick = () => {
  const t = parseBr($('jumpTo').value, S.day);
  $('jumpTo').classList.toggle('invalid', t == null);
  if (t == null) toast('Use dd/mm/aaaa hh:mm:ss ou só hh:mm:ss.');
  else seek(t);
};
$('jumpTo').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('jumpBtn').click(); });
$('settingsBtn').onclick = () => openSettings(false);
$('cfgSave').onclick = saveSettings;
$('cfgCancel').onclick = () => $('settings').close();
$('settings').addEventListener('cancel', (e) => { if ($('cfgCancel').hidden) e.preventDefault(); });
$('camsBtn').onclick = openCams;
$('camsClose').onclick = () => { if (applyCams()) $('camsDlg').close(); };
$('camsDlg').addEventListener('cancel', () => applyCams());
$('camsReset').onclick = () => {
  localStorage.removeItem('gridLayout');
  $('camsDlg').close();
  applyShown(computeShown());
  localStorage.removeItem('gridLayout');
};
$('dayPrev').onclick = () => loadDay(S.day - 86400);
$('dayNext').onclick = () => { if (S.day + 86400 <= dvrNow()) loadDay(S.day + 86400); };
$('day').onchange = () => {
  const t = parseBr($('day').value);
  if (t == null) { $('day').classList.add('invalid'); toast('Use dd/mm/aaaa.'); return; }
  loadDay(dayOf(t));
};
$('day').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('day').onchange(); });
$('zoomIn').onclick = () => timeline.zoom(0.5);
$('zoomOut').onclick = () => timeline.zoom(2);
$('zoomDay').onclick = () => timeline.resetZoom();
$('cutStart').addEventListener('input', refreshCut);
$('cutEnd').addEventListener('input', refreshCut);
$('cutStartNow').onclick = () => setCut(Math.floor(position()), null);
$('cutEndNow').onclick = () => setCut(null, Math.floor(position()));
$('cutGo').onclick = runCut;
$('cutDir').onclick = async () => { if (await api.chooseDir()) showOutDir(); };
for (const [id, key, def] of [['cutSeparate', 'cutSeparate', true], ['cutGrid', 'cutGrid', false]]) {
  $(id).checked = pref.get(key, def);
  $(id).onchange = () => pref.set(key, $(id).checked);
}
$('cutFormat').value = pref.get('cutFormat', 'original') === 'compativel' ? 'compativel' : 'original';
$('cutFormat').onchange = () => pref.set('cutFormat', $('cutFormat').value);

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea') || $('settings').open || $('camsDlg').open) return;
  if (e.code === 'Space') { e.preventDefault(); togglePause(); }
  else if (e.key === 'ArrowLeft') step(e.shiftKey ? -60 : -10);
  else if (e.key === 'ArrowRight') step(e.shiftKey ? 60 : 10);
  else if (e.key === '[') jumpEvent(-1);
  else if (e.key === ']') jumpEvent(1);
  else if (e.key === 'Escape' && S.single) toggleSingle(S.single);
});

// Janela escondida no ícone da barra: desconecta as câmeras (não gasta CPU nem rede)
// e volta como estava ao reabrir.
let resumeOnShow = null;
api.onVisibility((visible) => {
  if (!visible) {
    resumeOnShow = S.paused ? null : S.mode;
    if (!S.paused) togglePause();
  } else if (resumeOnShow === 'live') goLive();
  else if (resumeOnShow === 'playback' && S.paused) togglePause();
  if (visible) resumeOnShow = null;
});
api.onGoLive(() => goLive());

// Ganchos para o teste automatizado (scripts/smoke.js).
window.__visor = {
  S, seek, goLive, togglePause, toggleSingle, setCut, runCut, position, fmt, parseBr,
  setSpeed, jumpEvent, takeSnapshot, setZoom, applyShown, requestThumb, thumbs, motionStarts,
};

updateModeUi();
tick();
init();
