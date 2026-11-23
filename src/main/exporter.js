'use strict';
// Recortes, fotos e miniaturas a partir das gravações do DVR.
//   original   -> H.265 sem recodificar (rápido, sem perda; toca no Mac, VLC e navegadores atuais)
//   compativel -> H.264 recodificado (toca em qualquer lugar, inclusive WhatsApp)
//   grade      -> todas as câmeras escolhidas num vídeo só, lado a lado (H.264)

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const { FFMPEG } = require('./ffmpeg');
const { fromSec } = require('./dahua');

function safeName(s) {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'canal';
}

const stamp = (s) => fromSec(s).replace(/:/g, '-').replace(' ', '_');

function uniquePath(dir, base, ext) {
  let out = path.join(dir, base + ext);
  for (let n = 2; fs.existsSync(out); n++) out = path.join(dir, `${base}_${n}${ext}`);
  return out;
}

// Roda o ffmpeg. Com `input` (stream), alimenta a entrada padrão. Devolve a saída padrão se `capture`.
function runFfmpeg(args, { input, capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args, { stdio: [input ? 'pipe' : 'ignore', capture ? 'pipe' : 'ignore', 'pipe'] });
    let err = '';
    const chunks = [];
    p.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    if (capture) p.stdout.on('data', (d) => chunks.push(d));
    if (input) {
      p.stdin.on('error', () => {});
      input.pipe(p.stdin);
      input.on('error', () => p.stdin.end());
    }
    p.on('error', reject);
    p.on('exit', (code) => {
      input?.destroy();
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error('ffmpeg falhou: ' + (err.trim().split('\n').pop() || `código ${code}`)));
    });
  });
}

async function downloadDav(client, channel, start, end, onProgress) {
  const tmp = path.join(os.tmpdir(), `visor-dvr-${process.pid}-${Date.now()}-${channel}-${Math.random().toString(36).slice(2, 8)}.dav`);
  const res = await client.openClip(channel, start, end);
  const total = Number(res.headers['content-length']) || 0;
  let got = 0;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      got += chunk.length;
      onProgress?.({ stage: 'baixando', got, total });
      cb(null, chunk);
    },
  });
  try {
    await pipeline(res, counter, fs.createWriteStream(tmp));
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  if (got < 1024) {
    fs.rmSync(tmp, { force: true });
    throw new Error('não há gravação nesse intervalo');
  }
  return tmp;
}

// Corta exatamente no intervalo pedido. Os timestamps do .dav são o horário do DVR em segundos.
const trimFilter = (start, end) => `select='between(t\\,${start}\\,${end})',setpts=(T-${start})/TB`;

async function convertSingle(tmp, out, format) {
  const video = format === 'compativel'
    ? ['-vf', 'scale=1920:1080,setsar=1', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p']
    : ['-c:v', 'copy', '-bsf:v', 'hevc_metadata=sample_aspect_ratio=2/1', '-tag:v', 'hvc1'];
  await runFfmpeg(['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', tmp,
    '-map', '0:v:0', '-map', '0:a?', ...video, '-c:a', 'aac', '-b:a', '64k',
    '-movflags', '+faststart', '-y', out]);
}

// Monta a grade: até 4 câmeras em 2x2 (1920x1080), até 9 em 3x3.
async function convertGrid(tmps, out, start, end) {
  const n = tmps.length;
  const cols = n <= 1 ? 1 : n <= 4 ? 2 : 3;
  const rows = Math.ceil(n / cols);
  const w = 1920 / cols;
  const h = 1080 / cols;
  const inputs = tmps.flatMap((t) => ['-f', 'dhav', '-i', t]);
  const parts = tmps.map((_t, i) => `[${i}:v]${trimFilter(start, end)},fps=15,scale=${w}:${h},setsar=1[v${i}]`);
  let filter;
  if (n === 1) {
    filter = `${parts[0]};[v0]null[out]`;
  } else {
    const layout = tmps.map((_t, i) => `${(i % cols) * w}_${Math.floor(i / cols) * h}`).join('|');
    filter = `${parts.join(';')};${tmps.map((_t, i) => `[v${i}]`).join('')}` +
      `xstack=inputs=${n}:layout=${layout}:fill=black,scale=1920:${rows * h},setsar=1[out]`;
  }
  // -copyts mantém os timestamps do DVR (horário em segundos) para o corte exato.
  await runFfmpeg(['-hide_banner', '-loglevel', 'error', '-nostdin', '-copyts', ...inputs,
    '-filter_complex', filter, '-map', '[out]', '-t', String(end - start),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', '-y', out]);
}

// items: [{ channel, name }]; separate: um arquivo por câmera; grid: um vídeo com todas.
async function exportClips({ client, items, start, end, format, separate, grid, dir, onProgress }) {
  const results = [];
  const tmps = new Map();
  const end2 = fromSec(end).slice(11).replace(/:/g, '-');
  try {
    // Baixa todas em paralelo (o DVR entrega bem mais rápido que tempo real).
    await Promise.all(items.map(async (it) => {
      try {
        tmps.set(it.channel, await downloadDav(client, it.channel, start, end,
          (p) => onProgress({ key: it.channel, ...p })));
      } catch (e) {
        onProgress({ key: it.channel, stage: 'erro', error: e.message });
        results.push({ key: it.channel, error: e.message });
      }
    }));

    if (separate) {
      for (const it of items) {
        const tmp = tmps.get(it.channel);
        if (!tmp) continue;
        const out = uniquePath(dir, `${safeName(it.name)}_${stamp(start)}_a_${end2}`, '.mp4');
        onProgress({ key: it.channel, stage: 'convertendo' });
        try {
          await convertSingle(tmp, out, format);
          onProgress({ key: it.channel, stage: 'pronto', file: out });
          results.push({ key: it.channel, file: out });
        } catch (e) {
          fs.rmSync(out, { force: true });
          onProgress({ key: it.channel, stage: 'erro', error: e.message });
          results.push({ key: it.channel, error: e.message });
        }
      }
    } else {
      for (const it of items) if (tmps.has(it.channel)) onProgress({ key: it.channel, stage: 'baixado' });
    }

    if (grid) {
      const ok = items.filter((it) => tmps.has(it.channel));
      if (!ok.length) {
        onProgress({ key: 'grade', stage: 'erro', error: 'nenhuma câmera foi baixada' });
      } else {
        const out = uniquePath(dir, `Grade_${stamp(start)}_a_${end2}`, '.mp4');
        onProgress({ key: 'grade', stage: 'convertendo' });
        try {
          await convertGrid(ok.map((it) => tmps.get(it.channel)), out, start, end);
          onProgress({ key: 'grade', stage: 'pronto', file: out });
          results.push({ key: 'grade', file: out });
        } catch (e) {
          fs.rmSync(out, { force: true });
          onProgress({ key: 'grade', stage: 'erro', error: e.message });
          results.push({ key: 'grade', error: e.message });
        }
      }
    }
  } finally {
    for (const t of tmps.values()) fs.rmSync(t, { force: true });
  }
  return results;
}

// Um quadro JPEG da gravação no instante t (ou ao vivo, se t for null), no tamanho pedido.
async function grabFrame(client, channel, t, scale) {
  const vf = `scale=${scale},setsar=1`;
  if (t == null) {
    return runFfmpeg(['-hide_banner', '-loglevel', 'error', '-nostdin', '-rtsp_transport', 'tcp',
      '-i', client.liveUrl(channel, 0), '-frames:v', '1', '-vf', vf, '-q:v', '2', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1'],
    { capture: true });
  }
  const res = await client.openClip(channel, t, t + 3);
  return runFfmpeg(['-hide_banner', '-loglevel', 'error', '-nostdin', '-copyts', '-f', 'dhav', '-i', 'pipe:0',
    '-vf', `select='gte(t\\,${t})',${vf}`, '-frames:v', '1', '-q:v', '3', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1'],
  { input: res, capture: true });
}

async function snapshot({ client, channel, name, t, dir }) {
  const jpg = await grabFrame(client, channel, t, '1920:1080');
  if (!jpg.length) throw new Error('não veio imagem do DVR');
  const when = t ?? (await client.currentTime());
  const out = uniquePath(dir, `${safeName(name)}_${stamp(when)}`, '.jpg');
  fs.writeFileSync(out, jpg);
  return out;
}

async function thumbnail({ client, channel, t }) {
  const jpg = await grabFrame(client, channel, t, '320:180');
  return jpg.length ? `data:image/jpeg;base64,${jpg.toString('base64')}` : null;
}

module.exports = { exportClips, snapshot, thumbnail };
