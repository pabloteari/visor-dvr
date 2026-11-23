'use strict';
/* Linha do tempo de um dia: trechos gravados por câmera, posição atual e seleção de recorte.
   Tempos em "segundos ingênuos" (horário do DVR tratado como UTC). */

const TL_COLORS = ['#22c55e', '#eab308', '#06b6d4', '#f97316', '#a855f7', '#ec4899', '#84cc16', '#14b8a6'];
const TL_TICKS = [1, 5, 10, 30, 60, 300, 600, 900, 1800, 3600, 7200, 10800];
const DAY = 86400;

function tlFmt(t, withSec = true) {
  const d = new Date(t * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}` + (withSec ? `:${p(d.getUTCSeconds())}` : '');
}

class Timeline {
  constructor(canvas, tip, { onSeek, onSelect, onHover, onLeave }) {
    this.c = canvas;
    this.tip = tip;
    this.tipText = tip.querySelector('span') || tip;
    this.onSeek = onSeek;
    this.onSelect = onSelect;
    this.onHover = onHover || (() => {});
    this.onLeave = onLeave || (() => {});
    this.day = 0;
    this.v0 = 0;
    this.v1 = DAY;
    this.rows = [];        // [{ name, color, segs: [{start,end}] }]
    this.playhead = null;
    this.now = null;
    this.sel = null;       // { a, b }
    this.drag = null;
    this.bind();
    new ResizeObserver(() => this.draw()).observe(canvas);
  }

  setDay(day) {
    this.day = day;
    this.v0 = day;
    this.v1 = day + DAY;
    this.draw();
  }

  setRows(rows) { this.rows = rows; this.draw(); }
  setPlayhead(t) { this.playhead = t; this.draw(); }
  setNow(t) { this.now = t; this.draw(); }
  setSelection(a, b) { this.sel = a != null && b != null ? { a: Math.min(a, b), b: Math.max(a, b) } : null; this.draw(); }

  zoom(factor, center) {
    const span = Math.min(DAY, Math.max(60, (this.v1 - this.v0) * factor));
    const c = center ?? (this.playhead != null && this.playhead >= this.v0 && this.playhead <= this.v1
      ? this.playhead : (this.v0 + this.v1) / 2);
    const ratio = (c - this.v0) / (this.v1 - this.v0);
    this.v0 = c - span * ratio;
    this.v1 = this.v0 + span;
    this.clamp();
    this.draw();
  }

  pan(seconds) {
    this.v0 += seconds;
    this.v1 += seconds;
    this.clamp();
    this.draw();
  }

  resetZoom() { this.setDay(this.day); }

  clamp() {
    const span = this.v1 - this.v0;
    if (this.v0 < this.day) { this.v0 = this.day; this.v1 = this.day + span; }
    if (this.v1 > this.day + DAY) { this.v1 = this.day + DAY; this.v0 = this.v1 - span; }
  }

  xToT(x) { return this.v0 + (x / this.c.clientWidth) * (this.v1 - this.v0); }
  tToX(t) { return ((t - this.v0) / (this.v1 - this.v0)) * this.c.clientWidth; }

  bind() {
    const c = this.c;
    const pos = (e) => e.clientX - c.getBoundingClientRect().left;
    c.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      this.drag = { x0: pos(e), t0: this.xToT(pos(e)), moved: false };
    });
    window.addEventListener('mousemove', (e) => {
      const x = pos(e);
      if (this.drag) {
        if (Math.abs(x - this.drag.x0) > 4) this.drag.moved = true;
        if (this.drag.moved) this.setSelection(this.drag.t0, this.snap(this.xToT(x)));
      }
      const r = c.getBoundingClientRect();
      if (this.drag || (e.clientY >= r.top && e.clientY <= r.bottom && x >= 0 && x <= r.width)) {
        this.tip.style.display = 'block';
        this.tip.style.left = `${Math.max(0, Math.min(r.width, x))}px`;
        const t = this.snap(this.xToT(x));
        this.tipText.textContent = this.drag?.moved && this.sel
          ? `${tlFmt(this.sel.a)} → ${tlFmt(this.sel.b)}`
          : tlFmt(t);
        if (this.drag?.moved) this.onLeave(); else this.onHover(t);
      } else if (this.tip.style.display !== 'none') {
        this.tip.style.display = 'none';
        this.onLeave();
      }
    });
    window.addEventListener('mouseup', (e) => {
      if (!this.drag) return;
      const d = this.drag;
      this.drag = null;
      if (d.moved && this.sel) this.onSelect(this.sel.a, this.sel.b);
      else this.onSeek(this.snap(this.xToT(pos(e))));
    });
    c.addEventListener('mouseleave', () => { if (!this.drag) { this.tip.style.display = 'none'; this.onLeave(); } });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        const d = e.shiftKey ? e.deltaY : e.deltaX;
        this.pan((d / c.clientWidth) * (this.v1 - this.v0));
      } else {
        this.zoom(e.deltaY > 0 ? 1.25 : 0.8, this.xToT(pos(e)));
      }
    }, { passive: false });
  }

  // Arredonda para um valor "redondo" conforme o zoom (1 s quando bem aproximado).
  snap(t) {
    const perPx = (this.v1 - this.v0) / this.c.clientWidth;
    const step = perPx > 30 ? 60 : perPx > 3 ? 10 : 1;
    return Math.round(t / step) * step;
  }

  draw() {
    const c = this.c;
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    g.fillStyle = '#0c0e12';
    g.fillRect(0, 0, w, h);

    // Escala de horas
    const span = this.v1 - this.v0;
    const step = TL_TICKS.find((s) => (s / span) * w >= 80) || 10800;
    g.font = '11px ui-monospace, Consolas, monospace';
    g.textBaseline = 'top';
    for (let t = Math.ceil(this.v0 / step) * step; t <= this.v1; t += step) {
      const x = Math.round(this.tToX(t)) + 0.5;
      g.strokeStyle = '#262b35';
      g.beginPath(); g.moveTo(x, 16); g.lineTo(x, h); g.stroke();
      g.fillStyle = '#8b93a3';
      g.fillText(tlFmt(t, step < 60), x + 3, 2);
    }

    // Trechos gravados
    const top = 20;
    const rowH = Math.max(6, Math.min(14, Math.floor((h - top - 4) / Math.max(1, this.rows.length)) - 3));
    this.rows.forEach((row, i) => {
      const y = top + i * (rowH + 3);
      g.fillStyle = '#181c24';
      g.fillRect(0, y, w, rowH);
      g.fillStyle = row.color;
      for (const s of row.segs) {
        if (s.end < this.v0 || s.start > this.v1) continue;
        const x0 = Math.max(0, this.tToX(s.start));
        const x1 = Math.min(w, this.tToX(s.end));
        g.fillRect(x0, y, Math.max(1, x1 - x0), rowH);
      }
      // Movimento: faixa vermelha na metade de baixo da linha da câmera.
      g.fillStyle = '#ef4444';
      for (const s of row.segs) {
        if (!s.motion || s.end < this.v0 || s.start > this.v1) continue;
        const x0 = Math.max(0, this.tToX(s.start));
        const x1 = Math.min(w, this.tToX(s.end));
        g.fillRect(x0, y + Math.ceil(rowH / 2), Math.max(2, x1 - x0), Math.floor(rowH / 2));
      }
      g.fillStyle = row.color;
      if (rowH >= 10) {
        g.fillStyle = 'rgba(0,0,0,.75)';
        g.font = '10px system-ui, sans-serif';
        g.fillText(row.name, 4, y + 1);
      }
    });

    // Futuro (depois do "agora" do DVR)
    if (this.now != null && this.now < this.v1) {
      const x = Math.max(0, this.tToX(this.now));
      g.fillStyle = 'rgba(15,17,21,.75)';
      g.fillRect(x, 16, w - x, h - 16);
    }

    // Seleção
    if (this.sel) {
      const x0 = this.tToX(this.sel.a);
      const x1 = this.tToX(this.sel.b);
      g.fillStyle = 'rgba(59,130,246,.28)';
      g.fillRect(x0, 16, Math.max(2, x1 - x0), h - 16);
      g.fillStyle = '#3b82f6';
      g.fillRect(x0 - 1, 16, 2, h - 16);
      g.fillRect(x1 - 1, 16, 2, h - 16);
    }

    // Posição atual
    if (this.playhead != null && this.playhead >= this.v0 && this.playhead <= this.v1) {
      const x = Math.round(this.tToX(this.playhead));
      g.fillStyle = '#ef4444';
      g.fillRect(x - 1, 14, 2, h - 14);
      g.beginPath(); g.moveTo(x - 5, 12); g.lineTo(x + 5, 12); g.lineTo(x, 18); g.fill();
    }
  }
}

window.Timeline = Timeline;
window.TL_COLORS = TL_COLORS;
