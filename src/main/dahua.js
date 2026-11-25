'use strict';
// Cliente da API HTTP do DVR (padrão Dahua, usado pela Intelbras), com autenticação Digest.

const http = require('node:http');
const crypto = require('node:crypto');

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

function parseChallenge(header) {
  const out = {};
  const re = /(\w+)=(?:"([^"]*)"|([^,\s]+))/g;
  let m;
  while ((m = re.exec(header))) out[m[1].toLowerCase()] = m[2] ?? m[3];
  return out;
}

// Datas do DVR são horário local do aparelho, sem fuso. Internamente usamos
// "segundos ingênuos": a string tratada como se fosse UTC, para evitar fuso e horário de verão.
function toSec(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(str);
  if (!m) throw new Error('data inválida: ' + str);
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000;
}

function fromSec(sec, sep = ' ') {
  const d = new Date(sec * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}${sep}` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

function parseKv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

class DahuaClient {
  constructor({ host, user, pass, port = 80 }) {
    this.host = host;
    this.port = port;
    this.user = user;
    this.pass = pass;
  }

  // Neste DVR cada "nonce" do Digest vale para UMA requisição só (testado: reusar dá 401,
  // e pedir um novo não invalida os anteriores). Por isso cada requisição pega o seu desafio,
  // e várias em paralelo não interferem umas nas outras.
  authHeader(method, uri, c) {
    const ha1 = md5(`${this.user}:${c.realm}:${this.pass}`);
    const ha2 = md5(`${method}:${uri}`);
    const nc = '00000001';
    const cnonce = crypto.randomBytes(8).toString('hex');
    const qop = c.qop ? c.qop.split(',')[0].trim() : null;
    const response = qop
      ? md5(`${ha1}:${c.nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
      : md5(`${ha1}:${c.nonce}:${ha2}`);
    let h = `Digest username="${this.user}", realm="${c.realm}", nonce="${c.nonce}", uri="${uri}", ` +
      `response="${response}", algorithm=MD5`;
    if (qop) h += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
    if (c.opaque !== undefined) h += `, opaque="${c.opaque}"`;
    return h;
  }

  send(uri, timeout, auth) {
    return new Promise((resolve, reject) => {
      const headers = auth ? { Authorization: auth } : {};
      const req = http.get({ host: this.host, port: this.port, path: uri, headers, timeout }, resolve);
      req.on('timeout', () => req.destroy(new Error('tempo esgotado falando com o DVR')));
      req.on('error', reject);
    });
  }

  // Faz um GET autenticado e devolve a resposta (stream). Uma tentativa só com a senha:
  // se o DVR recusar, é usuário/senha errados (insistir poderia bloquear a conta no DVR).
  async rawGet(uri, { timeout = 15000 } = {}) {
    const first = await this.send(uri, timeout, null);
    if (first.statusCode !== 401) return first;
    first.resume();
    const www = first.headers['www-authenticate'] || '';
    if (!/^Digest/i.test(www)) throw new Error('DVR pediu autenticação não suportada');
    const res = await this.send(uri, timeout, this.authHeader('GET', uri, parseChallenge(www)));
    if (res.statusCode === 401) {
      res.resume();
      throw new Error('Usuário ou senha incorretos');
    }
    return res;
  }

  async getText(uri) {
    const res = await this.rawGet(uri);
    const chunks = [];
    for await (const c of res) chunks.push(c);
    const body = Buffer.concat(chunks).toString('utf8');
    if (res.statusCode !== 200) {
      const err = new Error(`DVR respondeu ${res.statusCode}: ${body.slice(0, 200).trim()}`);
      err.status = res.statusCode;
      throw err;
    }
    return body;
  }

  async deviceInfo() {
    const type = parseKv(await this.getText('/cgi-bin/magicBox.cgi?action=getDeviceType')).type || '';
    const titles = parseKv(await this.getText('/cgi-bin/configManager.cgi?action=getConfig&name=ChannelTitle'));
    const count = Number(parseKv(await this.getText('/cgi-bin/devVideoInput.cgi?action=getCollect')).result) || 0;
    const channels = [];
    for (let i = 0; i < count; i++) {
      channels.push({ channel: i + 1, name: titles[`table.ChannelTitle[${i}].Name`] || `Canal ${i + 1}` });
    }
    const now = await this.currentTime();
    return { type, channels, now };
  }

  async currentTime() {
    return toSec(parseKv(await this.getText('/cgi-bin/global.cgi?action=getCurrentTime')).result || '');
  }

  // Lista os trechos gravados de um canal entre start e end (segundos ingênuos).
  async findRecordings(channel, start, end) {
    const enc = (s) => encodeURIComponent(fromSec(s));
    const obj = parseKv(await this.getText('/cgi-bin/mediaFileFind.cgi?action=factory.create')).result;
    if (!obj) throw new Error('DVR não criou a busca de gravações');
    const out = [];
    try {
      let ok;
      try {
        ok = await this.getText(`/cgi-bin/mediaFileFind.cgi?action=findFile&object=${obj}` +
          `&condition.Channel=${channel}&condition.StartTime=${enc(start)}&condition.EndTime=${enc(end)}`);
      } catch (e) {
        if (e.status === 400) return out; // o DVR responde 400 quando o canal não tem nada gravado
        throw e;
      }
      if (!/OK/.test(ok)) return out;
      for (let guard = 0; guard < 100; guard++) {
        const kv = parseKv(await this.getText(`/cgi-bin/mediaFileFind.cgi?action=findNextFile&object=${obj}&count=100`));
        const found = Number(kv.found) || 0;
        for (let i = 0; i < found; i++) {
          const s = kv[`items[${i}].StartTime`];
          const e = kv[`items[${i}].EndTime`];
          if (!s || !e) continue;
          // Trechos gravados por evento vêm marcados com Flags=Event e Events=VideoMotion.
          let motion = false;
          for (let j = 0; j < 8; j++) {
            const ev = kv[`items[${i}].Events[${j}]`];
            const fl = kv[`items[${i}].Flags[${j}]`];
            if (ev === 'VideoMotion' || fl === 'Event') motion = true;
          }
          out.push({ start: toSec(s), end: toSec(e), motion });
        }
        if (found < 100) break;
      }
    } finally {
      await this.getText(`/cgi-bin/mediaFileFind.cgi?action=close&object=${obj}`).catch(() => {});
      await this.getText(`/cgi-bin/mediaFileFind.cgi?action=destroy&object=${obj}`).catch(() => {});
    }
    out.sort((a, b) => a.start - b.start);
    return out;
  }

  // Foto instantânea do ao vivo (JPEG pequeno, chega em ~0,2 s). Usada enquanto o vídeo conecta.
  async snapshotJpeg(channel) {
    const res = await this.rawGet(`/cgi-bin/snapshot.cgi?channel=${channel}`, { timeout: 8000 });
    const chunks = [];
    for await (const c of res) chunks.push(c);
    if (res.statusCode !== 200) throw new Error(`DVR respondeu ${res.statusCode} à foto`);
    return Buffer.concat(chunks);
  }

  // Início da gravação mais antiga do canal (o HD apaga o mais velho quando enche).
  async oldestRecording(channel) {
    const obj = parseKv(await this.getText('/cgi-bin/mediaFileFind.cgi?action=factory.create')).result;
    if (!obj) return null;
    try {
      const now = await this.currentTime();
      await this.getText(`/cgi-bin/mediaFileFind.cgi?action=findFile&object=${obj}&condition.Channel=${channel}` +
        `&condition.StartTime=${encodeURIComponent('2000-01-01 00:00:00')}&condition.EndTime=${encodeURIComponent(fromSec(now))}`);
      const kv = parseKv(await this.getText(`/cgi-bin/mediaFileFind.cgi?action=findNextFile&object=${obj}&count=1`));
      return kv['items[0].StartTime'] ? toSec(kv['items[0].StartTime']) : null;
    } catch (e) {
      if (e.status === 400) return null;
      throw e;
    } finally {
      await this.getText(`/cgi-bin/mediaFileFind.cgi?action=close&object=${obj}`).catch(() => {});
      await this.getText(`/cgi-bin/mediaFileFind.cgi?action=destroy&object=${obj}`).catch(() => {});
    }
  }

  async storage() {
    const kv = parseKv(await this.getText('/cgi-bin/storageDevice.cgi?action=getDeviceAllInfo'));
    let total = 0;
    let used = 0;
    for (const [k, v] of Object.entries(kv)) {
      if (/\.TotalBytes$/.test(k)) total += Number(v) || 0;
      if (/\.UsedBytes$/.test(k)) used += Number(v) || 0;
    }
    return { total, used };
  }

  // Abre o download do intervalo gravado (arquivo .dav). Devolve a resposta HTTP.
  async openClip(channel, start, end) {
    const enc = (s) => encodeURIComponent(fromSec(s));
    const res = await this.rawGet(`/cgi-bin/loadfile.cgi?action=startLoad&channel=${channel}` +
      `&subtype=0&startTime=${enc(start)}&endTime=${enc(end)}`, { timeout: 60000 });
    if (res.statusCode !== 200) {
      res.resume();
      throw new Error(`DVR recusou o download (HTTP ${res.statusCode})`);
    }
    return res;
  }

  rtspUrl(path) {
    const u = encodeURIComponent(this.user);
    const p = encodeURIComponent(this.pass);
    return `rtsp://${u}:${p}@${this.host}:554${path}`;
  }

  liveUrl(channel, subtype) {
    return this.rtspUrl(`/cam/realmonitor?channel=${channel}&subtype=${subtype}`);
  }

}

module.exports = { DahuaClient, toSec, fromSec };
