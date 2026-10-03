// Réel de présentation de skred, en motion design : chaque image est dessinée par render(t), t en secondes.
// Aucune vraie personne : la foule est faite de silhouettes dessinées.
// Rendu en vidéo par reel/render.mjs (Chrome sans fenêtre + ffmpeg).

export const W = 1080, H = 1920, FPS = 30, DURATION = 25;

const C = {
  paper: '#efede6', ink: '#0b0b0a', yellow: '#e4ff3a', mute: '#5a5852', dim: '#6a6862', soft: '#9c9a93',
  line: '#3a3a38', well: '#1f1f1e',
};

const canvas = document.getElementById('c');
canvas.width = W;
canvas.height = H;
const ctx = canvas.getContext('2d');

/* ---------- Outils ---------- */

const cl = (v) => Math.max(0, Math.min(1, v));
const seg = (t, a, b) => cl((t - a) / (b - a));
const lerp = (a, b, p) => a + (b - a) * p;
const eOut = (p) => 1 - Math.pow(1 - p, 3);
const eIn = (p) => p * p * p;
const eIO = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
const back = (p) => 1 + 2.70158 * Math.pow(p - 1, 3) + 1.70158 * Math.pow(p - 1, 2);

function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function hatch(a, b) {
  const c = document.createElement('canvas');
  c.width = c.height = 12;
  const x = c.getContext('2d');
  const img = x.createImageData(12, 12);
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  for (let i = 0; i < 144; i++) {
    const v = ((i % 12) + Math.floor(i / 12)) % 12 < 6 ? pa : pb;
    img.data.set([v >> 16, (v >> 8) & 255, v & 255, 255], i * 4);
  }
  x.putImageData(img, 0, 0);
  return ctx.createPattern(c, 'repeat');
}
const HATCH_LIGHT = hatch('#d8d6ce', '#cfcdc5');
const HATCH_DARK = hatch('#2a2a28', '#232321');

function font(weight, size, { stretch = 'normal', mono = false, spacing = 0 } = {}) {
  ctx.font = `${weight} ${size}px ${mono ? '"JetBrains Mono"' : 'Archivo'}`;
  ctx.fontStretch = stretch;
  ctx.letterSpacing = spacing + 'px';
}

// Titres : capitales condensées, chaque ligne monte depuis un masque, puis repart vers le haut.
function title(lines, x, y, size, t, tin, tout, { color = C.ink, align = 'left', stagger = 0.09, lh = 0.86, maxW = W - 160 } = {}) {
  lines = lines.map((s) => s.toUpperCase());
  font(900, size, { stretch: 'extra-condensed' });
  const widest = Math.max(...lines.map((s) => ctx.measureText(s).width));
  if (widest > maxW) size = Math.floor(size * maxW / widest);
  font(900, size, { stretch: 'extra-condensed' });
  ctx.textAlign = align;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = color;
  lines.forEach((s, i) => {
    const p = eOut(seg(t, tin + i * stagger, tin + i * stagger + 0.5));
    const q = tout == null ? 0 : eIn(seg(t, tout + i * 0.05, tout + i * 0.05 + 0.32));
    if (p <= 0 || q >= 1) return;
    const base = y + i * size * lh;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, base - size * 0.98, W, size * 1.12);
    ctx.clip();
    ctx.fillText(s, x, base + (1 - p) * size * 1.1 - q * size * 1.1);
    ctx.restore();
  });
  return size;
}

// Étiquette en police mono, sur un fond plein qui se déroule de gauche à droite.
function tag(text, x, y, size, p, { bg = C.yellow, fg = C.ink } = {}) {
  if (p <= 0) return;
  font(600, size, { mono: true });
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const pad = size * 0.55, w = ctx.measureText(text).width + pad * 2, h = size * 1.8;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y - h / 2, w * eOut(p), h);
  ctx.clip();
  ctx.fillStyle = bg;
  ctx.fillRect(x, y - h / 2, w, h);
  ctx.fillStyle = fg;
  ctx.fillText(text, x + pad, y + size * 0.05);
  ctx.restore();
}

// Doigt qui touche l'écran : un rond qui se pose, puis une onde.
function tap(x, y, t, t0, color = C.paper) {
  if (t < t0 - 0.3 || t > t0 + 0.55) return;
  ctx.save();
  if (t < t0 + 0.12) {
    const p = seg(t, t0 - 0.3, t0);
    ctx.globalAlpha = 0.85 * eOut(p) * (1 - seg(t, t0 + 0.02, t0 + 0.12));
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, lerp(46, 34, eOut(p)), 0, Math.PI * 2);
    ctx.fill();
  }
  if (t > t0) {
    const p = seg(t, t0, t0 + 0.55);
    ctx.globalAlpha = 1 - p;
    ctx.strokeStyle = color;
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(x, y, lerp(34, 110, eOut(p)), 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

/* ---------- La foule : des silhouettes dessinées, en gris ---------- */

const R = rng(17);
const pick = (a) => a[Math.floor(R() * a.length)];
const TONES = ['#d6d3ca', '#bfbbb1', '#aaa69c', '#c9c5bb', '#b3afa5'];
const HAIRS = ['#3a3a38', '#1f1f1e', '#5a5852', '#2a2a28', '#7c7a73'];
const SHIRTS = ['#5a5852', '#3a3a38', '#7c7a73', '#2a2a28', '#8f8c84', '#46453f'];
const ROWS = [{ y: 1060, s: 50, n: 7 }, { y: 1225, s: 68, n: 6 }, { y: 1420, s: 95, n: 4 }];
const crowd = [];
ROWS.forEach((r, row) => {
  for (let j = 0; j < r.n; j++) {
    crowd.push({
      x: (j + 0.5) / r.n * W + (R() - 0.5) * r.s * 0.9 + (row === 1 ? r.s * 0.5 : 0),
      y: r.y + (R() - 0.5) * r.s * 0.35,
      s: r.s * (0.9 + R() * 0.2),
      row, j,
      tone: pick(TONES), hair: pick(HAIRS), shirt: pick(SHIRTS), style: Math.floor(R() * 4),
      thr: R(),
    });
  }
});
// La personne suivie tout le long : premier rang, sweat jaune.
const F = crowd.find((h) => h.row === 2 && h.j === 1);
Object.assign(F, { s: 95, shirt: C.yellow, style: 0, tone: '#c9c5bb', hair: '#1f1f1e' });

function drawHead(h, dy = 0) {
  const { x, s, tone, hair, shirt, style } = h;
  const y = h.y + dy;
  // Cheveux longs, derrière la tête.
  if (style === 2) {
    ctx.fillStyle = hair;
    roundRect(x - s * 0.98, y - s * 0.75, s * 1.96, s * 2.05, s * 0.9);
    ctx.fill();
  }
  // Épaules.
  ctx.fillStyle = shirt;
  ctx.beginPath();
  ctx.ellipse(x, y + s * 2.3, s * 1.65, s * 1.2, 0, Math.PI, 0);
  ctx.lineTo(x + s * 1.65, y + s * 7);
  ctx.lineTo(x - s * 1.65, y + s * 7);
  ctx.closePath();
  ctx.fill();
  // Cou et visage.
  ctx.fillStyle = tone;
  ctx.fillRect(x - s * 0.3, y + s * 0.5, s * 0.6, s * 0.95);
  ctx.beginPath();
  ctx.ellipse(x, y, s * 0.78, s, 0, 0, Math.PI * 2);
  ctx.fill();
  // Coiffure.
  ctx.fillStyle = hair;
  if (style === 0 || style === 2) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(x - s, y - s * 1.3, s * 2, s * 0.92);
    ctx.clip();
    ctx.beginPath();
    ctx.ellipse(x, y - s * 0.06, s * 0.84, s * 1.04, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  } else if (style === 3) {
    // Bonnet.
    roundRect(x - s * 0.86, y - s * 1.12, s * 1.72, s * 0.78, [s * 0.86, s * 0.86, s * 0.1, s * 0.1]);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(x - s * 0.86, y - s * 0.52, s * 1.72, s * 0.18);
  }
  // Traits du visage.
  ctx.fillStyle = C.ink;
  for (const k of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(x + k * s * 0.3, y - s * 0.02, s * 0.075, s * 0.095, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(x + k * s * 0.3 - s * 0.14, y - s * 0.25 - (k > 0 ? s * 0.03 : 0), s * 0.28, s * 0.06);
  }
  ctx.strokeStyle = C.ink;
  ctx.lineWidth = s * 0.055;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x + s * 0.02, y + s * 0.08);
  ctx.lineTo(x + s * 0.1, y + s * 0.3);
  ctx.lineTo(x - s * 0.04, y + s * 0.33);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y + s * 0.42, s * 0.22, Math.PI * 0.2, Math.PI * 0.8);
  ctx.stroke();
}

const maskRect = (h, k = 1) => {
  const side = h.s * 2.7 * k;
  return [h.x - side / 2, h.y - side / 2 - h.s * 0.05, side, side];
};

function drawCrowd({ others = 1, rise = null } = {}) {
  for (const h of crowd) {
    const a = h === F ? 1 : others;
    if (a <= 0.001) continue;
    let dy = 0;
    if (rise != null) {
      const d = 0.12 + h.row * 0.13 + h.j * 0.05;
      dy = (1 - back(seg(rise, d, d + 0.6))) * 700;
    }
    ctx.globalAlpha = a;
    drawHead(h, dy);
  }
  ctx.globalAlpha = 1;
}

// La même foule, comme filmée dans une rue, dans un cadre (écrans du téléphone).
function drawStreet() {
  ctx.fillStyle = '#b9b6ad';
  ctx.fillRect(0, 860, W, 1100);
  const B = rng(5);
  for (let x = -40; x < W; x += 150 + B() * 90) {
    const h = 260 + B() * 260, w = 120 + B() * 110;
    ctx.fillStyle = B() > 0.5 ? '#a5a299' : '#9a978e';
    ctx.fillRect(x, 1240 - h, w, h);
    ctx.fillStyle = 'rgba(239,237,230,0.35)';
    for (let wy = 1240 - h + 24; wy < 1200; wy += 52) for (let wx = x + 18; wx < x + w - 24; wx += 40) ctx.fillRect(wx, wy, 20, 28);
  }
  ctx.fillStyle = '#cfccc3';
  ctx.fillRect(0, 1240, W, 800);
}

function drawCrowdIn(x, y, w, h, masked) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  const RX = 0, RY = 880, RW = W, RH = 1080;
  const k = Math.max(w / RW, h / RH);
  ctx.translate(x + (w - RW * k) / 2 - RX * k, y + (h - RH * k) / 2 - RY * k);
  ctx.scale(k, k);
  drawStreet();
  drawCrowd();
  if (masked) {
    ctx.fillStyle = C.ink;
    crowd.forEach((hd, i) => {
      const m = masked(hd, i);
      if (m > 0) ctx.fillRect(...maskRect(hd, m));
    });
  }
  ctx.restore();
}

/* ---------- 1 à 3 : le flou, l'IA, le carré noir ---------- */

const T = { x: 540, y: 1135 };   // où la personne suivie est amenée, en gros plan
const ZOOM = 300 / F.s;
const SCAN_FROM = 640, SCAN_TO = 1960;

function camera(t) {
  const p = eIO(seg(t, 2.25, 3.0));
  const z = Math.exp(p * Math.log(ZOOM));
  let tx = F.x - F.x * z + (T.x - F.x) * p;
  let ty = F.y - F.y * z + (T.y - F.y) * p;
  if (t > 6.8 && t < 7.2) {
    const a = 18 * (1 - seg(t, 6.8, 7.2));
    tx += a * Math.sin(t * 95);
    ty += a * Math.cos(t * 81);
  }
  return { z, tx, ty, p };
}

function scanLine(y, label) {
  const g = ctx.createLinearGradient(0, y - 160, 0, y);
  g.addColorStop(0, 'rgba(228,255,58,0)');
  g.addColorStop(1, 'rgba(228,255,58,0.38)');
  ctx.fillStyle = g;
  ctx.fillRect(0, y - 160, W, 160);
  ctx.fillStyle = C.yellow;
  ctx.fillRect(0, y - 5, W, 10);
  tag(label, 60, y - 40, 38, 1);
}

function story(t) {
  ctx.fillStyle = C.paper;
  ctx.fillRect(0, 0, W, H);
  const cam = camera(t);
  const withCam = (fn) => { ctx.save(); ctx.setTransform(cam.z, 0, 0, cam.z, cam.tx, cam.ty); fn(); ctx.restore(); };
  const blur = 7.5 * eIO(seg(t, 1.2, 2.0)) * cam.z;
  const s1 = seg(t, 4.3, 5.3);
  const sharpTo = t < 4.3 ? -1 : lerp(SCAN_FROM, SCAN_TO, eIO(s1));
  const opts = { others: 1 - cam.p, rise: t < 2 ? t : null };

  // Partie encore floue (sous la ligne de l'IA), puis partie redevenue nette (au-dessus).
  if (sharpTo < H) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, Math.max(0, sharpTo), W, H);
    ctx.clip();
    if (blur > 0.3) ctx.filter = `blur(${blur}px)`;
    withCam(() => drawCrowd(opts));
    ctx.filter = 'none';
    ctx.restore();
  }
  if (sharpTo > 0) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, W, sharpTo);
    ctx.clip();
    withCam(() => drawCrowd(opts));
    ctx.restore();
  }
  if (t > 4.3 && t < 5.35) scanLine(sharpTo, 'IA · DÉFLOUTAGE');
  tag('VISAGE RETROUVÉ', 560, 845, 38, seg(t, 5.35, 5.6) * (1 - seg(t, 6.0, 6.15)), { bg: C.ink, fg: C.yellow });

  // Le carré noir tombe sur le visage, et l'IA ne retrouve plus rien.
  if (t >= 6.55) {
    const p = eOut(seg(t, 6.55, 6.8));
    let [x, y, w, h] = maskRect(F, lerp(1.9, 1, p));
    const end = maskRect(F);
    // Le carré s'étend à tout l'écran pour passer à la suite.
    const wp = eIO(seg(t, 9.9, 10.4));
    withCam(() => {
      ctx.globalAlpha = cl(p * 3);
      ctx.fillStyle = C.ink;
      if (wp <= 0) ctx.fillRect(x, y, w, h);
      ctx.globalAlpha = 1;
    });
    if (wp > 0) {
      const sx = end[0] * cam.z + cam.tx, sy = end[1] * cam.z + cam.ty, sw = end[2] * cam.z;
      ctx.fillStyle = C.ink;
      ctx.fillRect(lerp(sx, 0, wp), lerp(sy, 0, wp), lerp(sw, W, wp), lerp(sw, H, wp));
    }
  }
  if (t > 7.55 && t < 8.4) scanLine(lerp(SCAN_FROM, SCAN_TO, eIO(seg(t, 7.55, 8.4))), 'IA · DÉFLOUTAGE');
  tag('RIEN À RETROUVER', 520, 690, 38, seg(t, 8.4, 8.65) * (1 - seg(t, 9.75, 9.9)), { bg: C.ink, fg: C.yellow });

  title(['Tu floutes', 'les visages', 'avant de', 'poster ?'], 80, 400, 160, t, 0.25, 2.3);
  title(['Un flou,', 'une IA peut', "l'enlever."], 80, 400, 160, t, 2.8, 6.0, { stagger: 0.35 });
  title(['Un carré noir,', 'non.'], 80, 400, 160, t, 6.2, 8.45, { stagger: 0.55 });
  title(["Il n'y a plus", 'rien dessous.'], 80, 400, 160, t, 8.55, 9.8, { stagger: 0.15 });
}

/* ---------- 4 : l'application, sur un téléphone ---------- */

const PH = { x: 260, y: 490, w: 560, h: 1100 };
const SC = { x: PH.x + 16, y: PH.y + 16, w: PH.w - 32, h: PH.h - 32 };
const K = SC.w / 390;   // taille d'un pixel de l'application dans le téléphone dessiné
const SCREENS = [['gallery', 10.3], ['scan', 11.95], ['review', 14.15], ['export', 14.95], ['done', 15.6]];
const FRAME = { x: 32, y: 360, s: 342 * K };

function brand() {
  font(800, 20 * K, { spacing: -0.6 * K });
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('skred', 16 * K, 44 * K);
}

function bigText(s, y) {
  font(900, 92 * K, { stretch: 'extra-condensed' });
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(s, FRAME.x, y);
}

function fitText(s, x, y, maxW, weight, size, opts = {}) {
  font(weight, size, opts);
  const w = ctx.measureText(s).width;
  if (w > maxW) font(weight, size * maxW / w, opts);
  ctx.fillText(s, x, y);
}

const SHARE_ICON = { x: 2.5, y: 0 };   // position calculée dans gallery()

function gallery(t) {
  const { w, h } = SC;
  ctx.fillStyle = '#121211';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = C.soft;
  font(500, 12 * K, { mono: true });
  ctx.textAlign = 'left';
  ctx.fillText('12:00', 20 * K, 26 * K);
  ctx.fillStyle = C.paper;
  font(800, 26 * K);
  ctx.fillText('Galerie', 20 * K, 80 * K);
  const gap = 3 * K, cell = (w - gap * 2) / 3;
  const G = rng(3);
  for (let i = 0; i < 15; i++) {
    const cx = (i % 3) * (cell + gap), cy = 104 * K + Math.floor(i / 3) * (cell + gap);
    if (i === 1) {
      drawCrowdIn(cx, cy, cell, cell);
      const p = back(seg(t, 10.85, 11.1));
      if (p > 0) {
        ctx.fillStyle = C.yellow;
        ctx.beginPath();
        ctx.arc(cx + cell - 18 * K, cy + 18 * K, 11 * K * p, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = C.ink;
        ctx.lineWidth = 2.5 * K;
        ctx.beginPath();
        ctx.moveTo(cx + cell - 23 * K, cy + 18 * K);
        ctx.lineTo(cx + cell - 19 * K, cy + 22 * K);
        ctx.lineTo(cx + cell - 13 * K, cy + 14 * K);
        ctx.stroke();
      }
    } else {
      ctx.fillStyle = ['#3a3a38', '#2a2a28', '#46453f', '#5a5852', '#323230'][Math.floor(G() * 5)];
      ctx.fillRect(cx, cy, cell, cell);
      ctx.fillStyle = 'rgba(239,237,230,0.06)';
      ctx.fillRect(cx, cy + cell * (0.4 + G() * 0.3), cell, cell);
    }
  }
  // Menu de partage.
  const p = eOut(seg(t, 11.05, 11.4));
  if (p <= 0) return;
  const sh = 250 * K, y = h - sh * p;
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = C.paper;
  roundRect(0, y, w, sh + 20, [18 * K, 18 * K, 0, 0]);
  ctx.fill();
  ctx.fillStyle = C.ink;
  font(800, 18 * K);
  ctx.textAlign = 'left';
  ctx.fillText('Partager', 22 * K, y + 44 * K);
  const apps = ['Messages', 'E-mail', 'skred', 'Fichiers'];
  apps.forEach((name, i) => {
    const cx = (i + 0.5) * w / 4, cy = y + 112 * K, r = 28 * K;
    if (name === 'skred') {
      ctx.fillStyle = C.ink;
      roundRect(cx - r, cy - r, r * 2, r * 2, 12 * K);
      ctx.fill();
      ctx.fillStyle = '#000';
      ctx.strokeStyle = C.paper;
      ctx.lineWidth = 3 * K;
      ctx.fillRect(cx - r * 0.55, cy - r * 0.55, r * 1.1, r * 1.1);
      ctx.strokeRect(cx - r * 0.55, cy - r * 0.55, r * 1.1, r * 1.1);
      SHARE_ICON.x = cx;
      SHARE_ICON.y = cy;
    } else {
      ctx.fillStyle = '#d8d6ce';
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = C.mute;
      font(700, 18 * K, { mono: true });
      ctx.textAlign = 'center';
      ctx.fillText(name[0], cx, cy + 6 * K);
    }
    ctx.fillStyle = C.ink;
    font(500, 11 * K, { mono: true });
    ctx.textAlign = 'center';
    ctx.fillText(name, cx, cy + r + 22 * K);
  });
  tap(SHARE_ICON.x, SHARE_ICON.y, t, 11.65, C.ink);
}

function scanScreen(t) {
  const p = seg(t, 12.05, 13.9);
  const pct = Math.floor(100 * eIO(p));
  ctx.fillStyle = C.paper;
  ctx.fillRect(0, 0, SC.w, SC.h);
  ctx.fillStyle = C.ink;
  brand();
  bigText(pct + '%', FRAME.y - 18 * K);
  ctx.fillStyle = HATCH_LIGHT;
  ctx.fillRect(FRAME.x, FRAME.y, FRAME.s, FRAME.s);
  // Les visages se couvrent au fur et à mesure de l'analyse.
  drawCrowdIn(FRAME.x, FRAME.y, FRAME.s, FRAME.s, (hd) => back(seg(eIO(p), hd.thr * 0.85, hd.thr * 0.85 + 0.1)));
  ctx.fillStyle = 'rgba(11,11,10,0.5)';
  const fh = FRAME.s * eIO(p);
  ctx.fillRect(FRAME.x, FRAME.y + FRAME.s - fh, FRAME.s, fh);
  ctx.fillStyle = C.dim;
  font(500, 10 * K, { mono: true });
  ctx.textAlign = 'left';
  ctx.fillText('IMAGE EN COURS', FRAME.x + 12 * K, FRAME.y + 22 * K);
  link('Annuler', FRAME.x, SC.h - 40 * K, C.ink);
}

function link(s, x, y, color) {
  ctx.fillStyle = color;
  font(500, 13 * K, { mono: true });
  ctx.textAlign = 'left';
  ctx.fillText(s, x, y);
  ctx.fillRect(x, y + 5 * K, ctx.measureText(s).width, 1.5 * K);
}

const GO = { x: 0, y: 0 };

function reviewScreen(t) {
  const { w, h } = SC;
  ctx.fillStyle = C.ink;
  ctx.fillRect(0, 0, w, h);
  const deck = 190 * K;
  ctx.fillStyle = HATCH_DARK;
  ctx.fillRect(0, 0, w, h - deck);
  const img = w;
  drawCrowdIn(0, (h - deck - img) / 2, w, img, () => 1);
  // Bandeau d'aide.
  ctx.fillStyle = C.paper;
  ctx.fillRect(16 * K, 16 * K, w - 32 * K, 52 * K);
  ctx.fillStyle = C.ink;
  ctx.textAlign = 'left';
  fitText('Touche un visage pour le', 28 * K, 38 * K, w - 56 * K, 800, 14 * K);
  fitText('masquer ou le démasquer.', 28 * K, 57 * K, w - 56 * K, 800, 14 * K);
  // Ligne de temps.
  const ty = h - deck + 16 * K, th = 36 * K, step = 36 * K, gap = 6 * K;
  ctx.strokeStyle = C.line;
  ctx.lineWidth = 2 * K;
  ctx.strokeRect(16 * K, ty, step, th);
  ctx.strokeRect(w - 16 * K - step, ty, step, th);
  ctx.fillStyle = C.paper;
  font(700, 18 * K, { mono: true });
  ctx.textAlign = 'center';
  ctx.fillText('‹', 16 * K + step / 2, ty + th / 2 + 6 * K);
  ctx.fillText('›', w - 16 * K - step / 2, ty + th / 2 + 6 * K);
  const tx = 16 * K + step + gap, tw = w - 2 * (16 * K + step + gap);
  ctx.fillStyle = C.well;
  ctx.fillRect(tx, ty, tw, th);
  const L = rng(9);
  ctx.fillStyle = C.yellow;
  for (let r = 0; r < 6; r++) {
    const a = L() * 0.3, b = a + 0.4 + L() * 0.3;
    ctx.fillRect(tx + tw * a, ty + 4 * K + r * 5 * K, tw * Math.min(1, b - a), 3 * K);
  }
  ctx.fillStyle = C.paper;
  ctx.fillRect(tx + tw * seg(t, 14.15, 15.0) * 0.5, ty - 3 * K, 2.5 * K, th + 6 * K);
  // Boutons.
  const ry = ty + th + 14 * K, rh = 56 * K;
  let x = 16 * K;
  ctx.lineWidth = 2 * K;
  for (const kind of ['play', 'style', 'son']) {
    if (kind === 'son') {
      ctx.fillStyle = C.paper;
      ctx.fillRect(x, ry, rh, rh);
      ctx.fillStyle = C.ink;
      font(700, 11 * K, { mono: true });
      ctx.textAlign = 'center';
      ctx.fillText('SON', x + rh / 2, ry + rh / 2 + 4 * K);
    } else {
      ctx.strokeStyle = C.line;
      ctx.strokeRect(x, ry, rh, rh);
      ctx.fillStyle = C.paper;
      if (kind === 'style') ctx.fillRect(x + rh / 2 - 9 * K, ry + rh / 2 - 9 * K, 18 * K, 18 * K);
      else {
        ctx.beginPath();
        ctx.moveTo(x + rh / 2 - 6 * K, ry + rh / 2 - 9 * K);
        ctx.lineTo(x + rh / 2 + 9 * K, ry + rh / 2);
        ctx.lineTo(x + rh / 2 - 6 * K, ry + rh / 2 + 9 * K);
        ctx.fill();
      }
    }
    x += rh + 6 * K;
  }
  const gw = w - 16 * K - x;
  ctx.fillStyle = C.paper;
  ctx.fillRect(x, ry, gw, rh);
  ctx.fillStyle = C.ink;
  font(900, 20 * K, { stretch: 'condensed' });
  ctx.textAlign = 'center';
  ctx.fillText('EXPORTER', x + gw / 2, ry + rh / 2 + 7 * K);
  GO.x = x + gw / 2;
  GO.y = ry + rh / 2;
  tap(GO.x, GO.y, t, 14.75, C.ink);
}

function exportScreen(t) {
  const p = seg(t, 15.0, 15.5);
  ctx.fillStyle = C.paper;
  ctx.fillRect(0, 0, SC.w, SC.h);
  ctx.fillStyle = C.ink;
  brand();
  bigText(Math.floor(100 * p) + '%', FRAME.y - 18 * K);
  ctx.fillStyle = HATCH_LIGHT;
  ctx.fillRect(FRAME.x, FRAME.y, FRAME.s, FRAME.s);
  drawCrowdIn(FRAME.x, FRAME.y, FRAME.s, FRAME.s, () => 1);
  ctx.fillStyle = 'rgba(11,11,10,0.5)';
  ctx.fillRect(FRAME.x, FRAME.y, FRAME.s * p, FRAME.s);
  ctx.fillStyle = C.ink;
  ctx.textAlign = 'left';
  fitText("Garde l'écran allumé.", FRAME.x, FRAME.y + FRAME.s + 34 * K, FRAME.s, 800, 17 * K);
  link('Annuler', FRAME.x, SC.h - 40 * K, C.ink);
}

function doneScreen(t) {
  ctx.fillStyle = C.paper;
  ctx.fillRect(0, 0, SC.w, SC.h);
  ctx.fillStyle = C.ink;
  brand();
  bigText('PRÊTE.', FRAME.y - 18 * K);
  ctx.fillStyle = HATCH_DARK;
  ctx.fillRect(FRAME.x, FRAME.y, FRAME.s, FRAME.s);
  drawCrowdIn(FRAME.x, FRAME.y, FRAME.s, FRAME.s, () => 1);
  ctx.fillStyle = C.ink;
  ctx.textAlign = 'left';
  fitText('Regarde-la en entier avant de poster.', FRAME.x, FRAME.y + FRAME.s + 34 * K, FRAME.s, 800, 17 * K);
  const cy = SC.h - 110 * K, ch = 64 * K;
  ctx.fillRect(FRAME.x, cy, FRAME.s, ch);
  ctx.fillStyle = C.paper;
  font(900, 22 * K, { stretch: 'condensed' });
  ctx.textAlign = 'left';
  ctx.fillText('TÉLÉCHARGER', FRAME.x + 20 * K, cy + ch / 2 + 8 * K);
  ctx.textAlign = 'right';
  ctx.fillText('↓', FRAME.x + FRAME.s - 20 * K, cy + ch / 2 + 8 * K);
  // Notification : le téléchargement est parti tout seul.
  const p = eOut(seg(t, 15.85, 16.2));
  if (p > 0) {
    const nh = 66 * K, ny = lerp(-nh - 10 * K, 10 * K, p);
    ctx.fillStyle = C.well;
    roundRect(10 * K, ny, SC.w - 20 * K, nh, 16 * K);
    ctx.fill();
    ctx.fillStyle = C.yellow;
    roundRect(22 * K, ny + 15 * K, 36 * K, 36 * K, 8 * K);
    ctx.fill();
    ctx.fillStyle = C.ink;
    font(800, 22 * K);
    ctx.textAlign = 'center';
    ctx.fillText('↓', 40 * K, ny + 41 * K);
    ctx.fillStyle = C.paper;
    ctx.textAlign = 'left';
    fitText('video-masquee.mp4', 72 * K, ny + 30 * K, SC.w - 100 * K, 800, 15 * K);
    ctx.fillStyle = C.soft;
    fitText('Téléchargement terminé', 72 * K, ny + 50 * K, SC.w - 100 * K, 500, 11 * K, { mono: true });
  }
}

const DRAW = { gallery, scan: scanScreen, review: reviewScreen, export: exportScreen, done: doneScreen };

function phone(t) {
  const enter = eOut(seg(t, 10.35, 10.95));
  const oy = (1 - enter) * 1500;
  ctx.save();
  ctx.translate(0, oy);
  ctx.fillStyle = '#2a2a28';
  roundRect(PH.x, PH.y, PH.w, PH.h, 72);
  ctx.fill();
  ctx.strokeStyle = C.mute;
  ctx.lineWidth = 3;
  ctx.stroke();
  roundRect(SC.x, SC.y, SC.w, SC.h, 56);
  ctx.clip();
  let i = 0;
  while (i + 1 < SCREENS.length && t >= SCREENS[i + 1][1]) i++;
  const [name, start] = SCREENS[i];
  const p = i > 0 ? eIO(seg(t, start, start + 0.32)) : 1;
  if (p < 1) {
    ctx.save();
    ctx.translate(SC.x - p * SC.w, SC.y);
    DRAW[SCREENS[i - 1][0]](t);
    ctx.restore();
  }
  ctx.save();
  ctx.translate(SC.x + (1 - p) * SC.w, SC.y);
  DRAW[name](t);
  ctx.restore();
  ctx.restore();
}

function app(t) {
  ctx.fillStyle = C.ink;
  ctx.fillRect(0, 0, W, H);
  phone(t);
  const o = { color: C.paper, align: 'center', stagger: 0.12, maxW: W - 140 };
  title(['Partage ta vidéo', 'à skred.'], 540, 330, 104, t, 10.6, 13.55, o);
  title(['Les visages sont', 'masqués tout seuls.'], 540, 330, 104, t, 13.7, 15.55, o);
  title(['Et la vidéo', 'se télécharge.'], 540, 330, 104, t, 15.75, 17.3, o);
}

/* ---------- 5 : les promesses ---------- */

function promises(t) {
  const items = [
    { lines: ['Rien ne quitte', 'ton téléphone.'], tin: 17.9 },
    { lines: ['Pas de compte.'], tin: 18.7 },
    { lines: ['Gratuit.'], tin: 19.4 },
  ];
  font(900, 100, { stretch: 'extra-condensed' });
  const widest = Math.max(...items.flatMap((it) => it.lines.map((s) => ctx.measureText(s.toUpperCase()).width)));
  const size = Math.min(150, Math.floor(100 * (W - 200 - 80) / widest));
  const gap = size * 1.6;
  const block = items.reduce((a, it) => a + size * 0.86 * (it.lines.length - 1), 0) + gap * (items.length - 1);
  let y = 1000 - block / 2 + size * 0.36;
  for (const it of items) {
    const q = eIn(seg(t, 20.7, 21.0));
    const b = back(seg(t, it.tin - 0.05, it.tin + 0.3)) * (1 - q);
    if (b > 0) {
      const side = size * 0.72;
      ctx.fillStyle = C.ink;
      ctx.fillRect(80 + side / 2 * (1 - b), y - side + side / 2 * (1 - b), side * b, side * b);
    }
    title(it.lines, 200, y, size, t, it.tin, 20.7, { maxW: W - 280 });
    y += size * 0.86 * (it.lines.length - 1) + gap;
  }
}

/* ---------- 6 : fin ---------- */

function ending(t) {
  ctx.fillStyle = C.paper;
  ctx.fillRect(0, 0, W, H);
  const side = 440, cx = 540, cy = 810;
  const fp = back(seg(t, 21.0, 21.35));
  if (fp > 0 && t < 21.75) {
    // Un visage apparaît dans un cadre...
    ctx.save();
    const s = side * fp;
    ctx.beginPath();
    ctx.rect(cx - s / 2, cy - s / 2, s, s);
    ctx.clip();
    ctx.fillStyle = HATCH_LIGHT;
    ctx.fillRect(cx - s / 2, cy - s / 2, s, s);
    drawHead({ ...F, x: cx, y: cy - 10, s: 125 * fp });
    ctx.restore();
  }
  // ... et le carré noir tombe dessus : c'est le logo.
  const sp = eOut(seg(t, 21.45, 21.7));
  if (sp > 0) {
    const s = side * lerp(1.7, 1, sp);
    ctx.globalAlpha = cl(sp * 3);
    ctx.fillStyle = C.ink;
    ctx.fillRect(cx - s / 2, cy - s / 2, s, s);
    ctx.globalAlpha = 1;
  }
  const lp = eOut(seg(t, 21.8, 22.3));
  if (lp > 0) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 1100, W, 190);
    ctx.clip();
    ctx.fillStyle = C.ink;
    font(800, 190, { spacing: -6 });
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('skred', cx, 1250 + (1 - lp) * 200);
    ctx.restore();
  }
  const up = seg(t, 22.2, 22.5);
  ctx.globalAlpha = up;
  ctx.fillStyle = C.ink;
  font(600, 46, { mono: true });
  ctx.textAlign = 'center';
  ctx.fillText('skred.vercel.app', cx, 1340);
  ctx.globalAlpha = 1;
  const bp = eOut(seg(t, 22.55, 22.9));
  if (bp > 0) {
    font(900, 84, { stretch: 'extra-condensed' });
    const label = 'LIEN EN BIO', w = ctx.measureText(label).width + 56;
    ctx.save();
    ctx.beginPath();
    ctx.rect(cx - w / 2, 1385, w * bp, 104);
    ctx.clip();
    ctx.fillStyle = C.yellow;
    ctx.fillRect(cx - w / 2, 1385, w, 104);
    ctx.fillStyle = C.ink;
    ctx.fillText(label, cx, 1467);
    ctx.restore();
  }
  ctx.globalAlpha = seg(t, 23.0, 23.4);
  ctx.fillStyle = C.mute;
  font(500, 31, { mono: true });
  ctx.fillText('Vérifie toujours ta vidéo avant de poster.', cx, 480);
  ctx.globalAlpha = 1;
}

/* ---------- Une image ---------- */

export function render(t) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.filter = 'none';
  ctx.globalAlpha = 1;
  if (t < 10.4) story(t);
  else if (t < 17.9) app(t);
  if (t >= 17.45 && t < 21) {
    const p = eIO(seg(t, 17.45, 17.9));
    ctx.fillStyle = C.paper;
    ctx.fillRect(0, H * (1 - p), W, H);
    promises(t);
  }
  if (t >= 21) ending(t);
}

await document.fonts.load('900 100px Archivo');
await document.fonts.load('800 100px Archivo');
await document.fonts.load('500 30px "JetBrains Mono"');
await document.fonts.load('600 30px "JetBrains Mono"');
window.render = render;
window.reel = { W, H, FPS, DURATION };
render(0);
window.ready = true;
