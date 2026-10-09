// Mesure de « Masquer une personne en entier » (EdgeTAM) sur les vidéos réelles du banc : le site suit une personne choisie
// d'office (le plus grand visage de l'image 30, corps déduit du visage), puis on regarde, image par image, si son visage
// reste sous la silhouette (70 % de sa surface au moins, comme entrainement/eval-reel.mjs).
// Visage de référence : la piste de visage du site pour cette personne (30 i/s), et sur les images corrigées à la main,
// le visage annoté qui correspond à cette piste.
// Usage : PORT=5180 node outils/dev-server.mjs (autre terminal, branche avec « Masquer une personne »),
// puis SITE=http://localhost:5180/ node entrainement/eval-corps.mjs [dossier des banques] [extraits séparés par des virgules]
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA = process.argv[2] || 'D:/datasets/skred-eval';
const ONLY = process.argv[3] ? process.argv[3].split(',') : null;
const LABEL = process.env.LABEL || 'corps';
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9337;
const SITE = process.env.SITE || 'http://localhost:5180/';
const START = 30;          // image de départ du suivi (1 s)
const MIN_FACE = 0.05;     // visage choisi : au moins 5 % du petit côté de l'image
const LOW = 256;
const here = dirname(fileURLToPath(import.meta.url));
const out = join(DATA, 'reel', LABEL);
mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ref = JSON.parse(readFileSync(join(DATA, 'reel', 'reel.json'), 'utf8'));
const clips = [...new Set(ref.map((e) => e.clip))].filter((c) => !ONLY || ONLY.some((o) => c.startsWith(o)));
mkdirSync(join(here, '..', 'test', 'reel'), { recursive: true });
for (const c of clips) if (!existsSync(join(here, '..', 'test', 'reel', c))) copyFileSync(join(DATA, 'reel', 'clips', c), join(here, '..', 'test', 'reel', c));

const chrome = spawn(CHROME, [
  ...(process.env.VISIBLE ? [] : ['--headless=new']), '--enable-unsafe-webgpu',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'skred-'))}`,
  '--autoplay-policy=no-user-gesture-required', '--window-size=900,900', '--no-first-run', 'about:blank',
], { stdio: 'ignore' });
let page;
for (let i = 0; i < 50 && !page; i++) {
  await sleep(200);
  try { page = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((t) => t.type === 'page'); } catch { /* pas encore prêt */ }
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
let nextId = 1;
const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const id = nextId++; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const run = async (expression) => {
  const r = await send('Runtime.evaluate', { expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails.exception || r.result.exceptionDetails));
  return r.result.result.value;
};

const iou = (a, b) => {
  const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)), y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return x * y / (a.w * a.h + b.w * b.h - x * y);
};
// Part du visage (cadre en pixels de la vidéo) sous la silhouette (256 × 256 étirée sur toute l'image).
function coverage(f, bits, W, H) {
  if (!bits) return 0;
  const n = 24;
  let hit = 0;
  for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) {
    const x = (f.x + (b + 0.5) * f.w / n) / W, y = (f.y + (a + 0.5) * f.h / n) / H;
    if (bits[Math.min(LOW - 1, Math.floor(y * LOW)) * LOW + Math.min(LOW - 1, Math.floor(x * LOW))]) hit++;
  }
  return hit / (n * n);
}

const results = [];
for (const clip of clips) {
  const entries = ref.filter((e) => e.clip === clip);
  const e0 = entries.find((e) => e.frame === START) || entries[0];
  const side = Math.min(e0.W, e0.H);
  const face = e0.faces.filter((f) => f[2] / side >= MIN_FACE).sort((a, b) => b[2] - a[2])[0];
  if (!face) { console.log(clip.padEnd(45), 'aucun visage assez grand'); continue; }

  await send('Page.navigate', { url: SITE });
  await sleep(1000);
  await run(`while (!window.skred || document.getElementById('file').disabled) await new Promise(r => setTimeout(r, 100));`);
  await run(`const b = await (await fetch('test/reel/${clip}')).blob(); const dt = new DataTransfer(); dt.items.add(new File([b], '${clip}', { type: 'video/mp4' }));
    const inp = document.getElementById('file'); inp.files = dt.files; inp.dispatchEvent(new Event('change'));`);
  await run(`while (document.getElementById('s-review').hidden && document.getElementById('fatal').hidden) await new Promise(r => setTimeout(r, 200));`);

  // corps déduit du visage : 3 largeurs de visage, du haut de la tête à 7 hauteurs de visage plus bas
  const [fx, fy, fw, fh] = face;
  // TOUCHER=1 : un toucher sur le torse (une hauteur de visage sous le menton), comme un utilisateur ; la plus grande découpe est gardée
  const body = process.env.TOUCHER ? [(fx + fw / 2) / e0.W, (fy + 2 * fh) / e0.H].map((v) => Math.min(0.999, Math.max(0, v)))
    : [(fx + fw / 2 - 1.5 * fw) / e0.W, (fy - 0.2 * fh) / e0.H, (fx + fw / 2 + 1.5 * fw) / e0.W, (fy + 7 * fh) / e0.H].map((v) => Math.min(1, Math.max(0, v)));
  const started = Date.now();
  const got = await run(`const k = window.skred, S = k.S;
    const sx = S.W / ${e0.W}, sy = S.H / ${e0.H};
    const target = { x: ${fx} * sx, y: ${fy} * sy, w: ${fw} * sx, h: ${fh} * sy };
    const iou = ${iou.toString()};
    const cand = (S.frames[${START}] || []).map(b => ({ b, v: iou(b, target) })).sort((a, b) => b.v - a.v)[0];
    const track = cand && cand.v > 0.2 ? cand.b.track : null;
    await k.goTo(${START} / S.fps);
    const t0 = performance.now();
    await k.maskPerson(${JSON.stringify(body)});
    const ms = performance.now() - t0;
    const p = S.persons[S.persons.length - 1];
    // silhouettes compactées (8 points par octet) : le résultat entier doit passer en un seul message
    const sils = {};
    if (p) for (const [i, s] of p.sils) {
      const packed = new Uint8Array(s.bits.length / 8);
      for (let j = 0; j < s.bits.length; j++) if (s.bits[j]) packed[j >> 3] |= 1 << (j & 7);
      let bin = ''; for (let j = 0; j < packed.length; j += 4096) bin += String.fromCharCode(...packed.subarray(j, j + 4096));
      sils[i] = btoa(bin);
    }
    const faces = S.frames.map((list, j) => { const d = track && track.dets.get(j); return d ? { x: d.x, y: d.y, w: d.w, h: d.h } : null; });
    // planche : 8 images exportées telles quelles (masques compris), entre deux silhouettes calculées
    const shots = [];
    if (p) for (const f of [16, 46, 76, 106, 136, 166, 196, 226]) {
      if (f >= S.frames.length) break;
      await k.goTo(f / S.fps);
      const c = document.createElement('canvas'); c.width = 480; c.height = Math.round(480 * S.H / S.W);
      const x = c.getContext('2d'); x.drawImage(document.getElementById('view'), 0, 0, c.width, c.height);
      shots.push(c.toDataURL('image/jpeg', 0.6));
    }
    return { W: S.W, H: S.H, fps: S.fps, n: S.frames.length, ms, gpu: !/sans carte graphique/.test(document.getElementById('hint').textContent) && !!navigator.gpu,
      found: !!p, sils, faces, track: !!track, hint: document.getElementById('hint').textContent, shots };`);
  const secs = (Date.now() - started) / 1000;
  shotsToDisk(clip, got.shots);
  if (!got.found) { console.log(clip.padEnd(45), 'échec :', got.hint); results.push({ clip, echec: got.hint }); continue; }

  const unpack = (b) => { const packed = Buffer.from(b, 'base64'), bits = new Uint8Array(LOW * LOW); for (let j = 0; j < bits.length; j++) bits[j] = (packed[j >> 3] >> (j & 7)) & 1; return bits; };
  const sils = new Map(Object.entries(got.sils).map(([i, b]) => [+i, unpack(b)]));
  const silAt = (f) => { const i = Math.round(f / got.fps * 10); return sils.get(i) || sils.get(i - 1) || sils.get(i + 1); };
  // 1. piste du visage, 30 i/s : images où le visage vu par le site dépasse de la silhouette
  let seen = 0, leak = 0, seenOn = 0, leakOn = 0;
  const leaks = [];
  got.faces.forEach((f, j) => {
    if (!f) return;
    const on = j % 3 === 0;
    seen++; if (on) seenOn++;
    if (coverage(f, silAt(j), got.W, got.H) < 0.7) { leak++; if (on) leakOn++; leaks.push(j); }
  });
  // 2. images corrigées à la main : le visage annoté qui correspond à la piste
  const checked = [];
  for (const e of entries.filter((x) => x.checked)) {
    const f = got.faces[e.frame];
    if (!f) continue;
    const sx = got.W / e.W, sy = got.H / e.H;
    const best = e.faces.map((g) => ({ x: g[0] * sx, y: g[1] * sy, w: g[2] * sx, h: g[3] * sy })).sort((a, b) => iou(b, f) - iou(a, f))[0];
    if (best && iou(best, f) > 0.3) checked.push({ frame: e.frame, couvert: +coverage(best, silAt(e.frame), got.W, got.H).toFixed(2) });
  }
  // 3. surface de la silhouette à chaque échantillon (0,1 s) : un effondrement ou un saut = suivi perdu
  const area = [...sils.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => +(b.reduce((s, v) => s + v, 0) / (LOW * LOW)).toFixed(3));
  const r = { clip, gpu: got.gpu, secondes: Math.round(got.ms / 1000), echantillons: sils.size, pisteVisage: got.track, visageVu: seen, visageDepasse: leak,
    surEchantillon: `${leakOn}/${seenOn}`, entreEchantillons: `${leak - leakOn}/${seen - seenOn}`, imagesDepasse: leaks, corrigees: checked, surface: area,
    surfaceMin: Math.min(...area), surfaceMax: Math.max(...area), cadre: body.map((v) => +v.toFixed(3)) };
  results.push(r);
  console.log(clip.padEnd(45), `${got.gpu ? 'gpu' : 'wasm'} ${r.secondes}s (${Math.round(secs)}s en tout)  visage dépasse ${leak}/${seen}`
    + `  (sur échantillon ${r.surEchantillon}, entre ${r.entreEchantillons})  corrigées ${checked.map((c) => c.couvert).join(' ')}  surface ${r.surfaceMin}-${r.surfaceMax}`);
  writeFileSync(join(DATA, 'reel', `resultat-${LABEL}.json`), JSON.stringify(results, null, 1));
}
ws.close();
chrome.kill();

function shotsToDisk(clip, shots) {
  shots.forEach((d, i) => writeFileSync(join(out, `${clip.replace(/\.mp4$/, '')}-${i}.jpg`), Buffer.from(d.split(',')[1], 'base64')));
}
