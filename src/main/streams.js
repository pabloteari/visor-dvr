'use strict';
// Servidor HTTP local (só 127.0.0.1) que entrega cada câmera como MPEG-TS H.264
// para o player (mpegts.js). O ffmpeg é iniciado quando o player conecta e
// encerrado quando ele desconecta, então não sobra processo rodando.

const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { FFMPEG } = require('./ffmpeg');

// O DVR grava em 960x1080 (formato "1080N"), que é exibido esticado em 16:9.
const SIZES = { grid: '960:540', single: '1280:720' };
const SPEEDS = [1, 2, 4, 8, 16];
// O Chromium abre no máximo 6 conexões por endereço:porta. Com várias portas, cabem grades maiores
// e a troca de horário não fica esperando as conexões antigas fecharem.
const PORTS = 3;

class StreamServer {
  constructor(getClient) {
    this.getClient = getClient;
    this.token = crypto.randomBytes(16).toString('hex');
    this.sessions = new Map();
    this.procs = new Set();
    this.active = new Map(); // canal -> encerrador da conexão em andamento
    this.next = 0;
    this.servers = Array.from({ length: PORTS }, () => http.createServer((req, res) => this.handle(req, res)));
  }

  async listen() {
    this.ports = await Promise.all(this.servers.map((srv) => new Promise((resolve) => {
      srv.listen(0, '127.0.0.1', () => resolve(srv.address().port));
    })));
  }

  // opts: { channel, mode: 'live'|'playback', start, quality: 'grid'|'single', lite, speed }
  create(opts) {
    const id = crypto.randomBytes(8).toString('hex');
    const speed = SPEEDS.includes(opts.speed) ? opts.speed : 1;
    // Cada câmera tem uma conexão por vez: a anterior é encerrada já, sem esperar o player.
    this.active.get(opts.channel)?.();
    this.sessions.set(id, { ...opts, speed, created: Date.now() });
    // Sessões nunca abertas expiram em 1 minuto.
    setTimeout(() => {
      const s = this.sessions.get(id);
      if (s && !s.opened) this.sessions.delete(id);
    }, 60000).unref();
    const port = this.ports[this.next++ % this.ports.length];
    return `http://127.0.0.1:${port}/${this.token}/${id}.ts`;
  }

  // Devolve { args, http: true } quando a entrada vem do download HTTP do DVR (reprodução acelerada).
  plan(s) {
    const client = this.getClient();
    const common = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
    const rtsp = [...common, '-rtsp_transport', 'tcp', '-fflags', '+genpts+discardcorrupt'];
    const out = ['-an', '-f', 'mpegts', '-muxdelay', '0', 'pipe:1'];
    const x264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
      '-g', '30', '-bf', '0', '-pix_fmt', 'yuv420p'];
    const size = SIZES[s.quality] || SIZES.grid;

    if (s.mode === 'live' && s.quality === 'grid' && s.lite) {
      // Modo leve: substream H.264 (352x240), só reempacotado (quase sem CPU).
      return { args: [...rtsp, '-fflags', '+nobuffer', '-i', client.liveUrl(s.channel, 1), '-c:v', 'copy', ...out] };
    }
    if (s.mode === 'live') {
      return { args: [...rtsp, '-i', client.liveUrl(s.channel, 0), '-vf', `scale=${size},setsar=1`, ...x264, ...out] };
    }
    // Gravação (qualquer velocidade): baixamos o trecho por HTTP e o ffmpeg dita o ritmo com -readrate.
    // Abre em ~1 s (o RTSP de reprodução do DVR leva 4 a 8 s) e permite acelerar, já que o DVR
    // entrega o download bem mais rápido que tempo real. O download começa no quadro-chave até
    // 1 s antes do segundo pedido, então o tempo relativo basta.
    // (Não usar -copyts aqui: junto com -readrate o ffmpeg trava esperando os timestamps do DVR.)
    const x = s.speed;
    const keyOnly = x >= 16 ? ['-skip_frame', 'nokey'] : []; // em 16x, só quadros-chave (bem menos CPU)
    const vf = (x === 1 ? 'setpts=PTS-STARTPTS,' : `setpts=(PTS-STARTPTS)/${x},`) +
      (x === 1 || keyOnly.length ? '' : 'fps=15,') + `scale=${size},setsar=1`;
    return {
      // 1 hora de gravação por conexão (no fim o player reabre a partir de onde parou).
      http: { start: s.start, end: s.start + Math.min(6 * 3600, 3600 * x) },
      args: [...common, ...keyOnly, '-readrate', String(x), '-f', 'dhav', '-i', 'pipe:0',
        '-vf', vf, '-fps_mode', 'vfr', ...x264, ...out],
    };
  }

  handle(req, res) {
    const m = /^\/([0-9a-f]{32})\/([0-9a-f]{16})\.ts$/.exec(req.url || '');
    const s = m && m[1] === this.token ? this.sessions.get(m[2]) : null;
    if (!s || s.opened) {
      res.writeHead(404).end();
      return;
    }
    s.opened = true;
    this.sessions.delete(m[2]);
    if (process.env.VISOR_DEBUG) console.log(`[dbg canal ${s.channel} ${Date.now() % 100000}] pedido recebido`, s.mode, s.start, `x${s.speed}`);

    let plan;
    try { plan = this.plan(s); } catch (e) { res.writeHead(500).end(e.message); return; }
    const proc = spawn(FFMPEG, plan.args, { stdio: [plan.http ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    this.procs.add(proc);
    let err = '';
    let download = null;
    proc.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    res.writeHead(200, {
      'Content-Type': 'video/mp2t',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    });
    proc.stdout.pipe(res);
    const stop = () => {
      if (proc.exitCode === null) proc.kill('SIGKILL');
      download?.destroy();
      if (!res.destroyed) res.destroy();
      if (this.active.get(s.channel) === stop) this.active.delete(s.channel);
    };
    this.active.get(s.channel)?.();
    this.active.set(s.channel, stop);
    req.on('close', stop);
    res.on('close', stop);
    proc.on('exit', (code, sig) => {
      dbg('ffmpeg saiu', code, sig, err.trim().slice(-160));
      this.procs.delete(proc);
      download?.destroy();
      if (code && err && !res.destroyed) console.error(`[ffmpeg canal ${s.channel}]`, err.trim());
      res.end();
    });

    const dbg = process.env.VISOR_DEBUG ? (...a) => console.log(`[dbg canal ${s.channel} ${Date.now() % 100000}]`, ...a) : () => {};
    proc.stdout.once('data', () => dbg('ffmpeg primeira saída'));
    if (plan.http) {
      proc.stdin.on('error', () => {}); // ffmpeg fechou antes do fim do download
      dbg('abrindo download', plan.http);
      this.getClient().openClip(s.channel, plan.http.start, plan.http.end).then((r) => {
        dbg('download respondeu', r.statusCode, r.headers['content-length']);
        r.once('data', () => dbg('download primeiros bytes'));
        download = r;
        if (proc.exitCode !== null) { r.destroy(); return; }
        r.pipe(proc.stdin);
        r.on('error', () => proc.stdin.end());
      }).catch((e) => {
        console.error(`[download canal ${s.channel}]`, e.message);
        proc.stdin.end();
      });
    }
  }

  close() {
    for (const p of this.procs) p.kill('SIGKILL');
    for (const srv of this.servers) srv.close();
  }
}

module.exports = { StreamServer, SPEEDS };
