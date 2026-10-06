// Mesure sur vidéos réelles : le site analyse chaque extrait de test/prepare-reel.py comme pour un vrai utilisateur
// (suivi d'une image à l'autre compris), puis on regarde, sur les images corrigées à la main (test/annoter-reel.py),
// si chaque visage est couvert par un masque (70 % de sa surface au moins, comme test/eval-faces.py).
// Usage : node dev-server.mjs (autre terminal), puis node test/eval-reel.mjs [dossier des banques] [nom du résultat]
// Les extraits sont copiés dans test/reel/ (non suivi par git) pour que le serveur local les serve.
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA = process.argv[2] || 'D:/datasets/skred-eval';
const LABEL = process.argv[3] || 'site';
const REEL = process.env.REEL || 'reel.json';   // autre fichier de référence, par exemple pour les vidéos de jour
const ONLY_CHECKED = !process.env.TOUT;   // TOUT=1 : compte aussi les images pas encore corrigées (pré-repérage seul)
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9336;
const SITE = process.env.SITE || 'http://localhost:5173/';
const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ref = JSON.parse(readFileSync(join(DATA, 'reel', REEL), 'utf8')).filter((e) => e.checked || !ONLY_CHECKED);
const clips = [...new Set(ref.map((e) => e.clip))];
mkdirSync(join(here, 'reel'), { recursive: true });
for (const c of clips) if (!existsSync(join(here, 'reel', c))) copyFileSync(join(DATA, 'reel', 'clips', c), join(here, 'reel', c));

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'skred-'))}`,
  '--autoplay-policy=no-user-gesture-required', '--window-size=420,900', '--no-first-run', 'about:blank',
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

function coverage(f, masks) {
  const n = 24;
  let hit = 0;
  for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) {
    const x = f[0] + (b + 0.5) * f[2] / n, y = f[1] + (a + 0.5) * f[3] / n;
    if (masks.some((m) => x >= m.x && x <= m.x + m.w && y >= m.y && y <= m.y + m.h)) hit++;
  }
  return hit / (n * n);
}

const BANDS = [[0.03, 0.12], [0.12, 0.25], [0.25, 9]];
// VARIANTES='{"nom": {"judge": {...}, "track": {...}}, ...}' : après une seule analyse par extrait, le tri des détections
// et le suivi sont refaits avec chaque jeu de réglages (window.skred.rejudge) : mêmes détections pour toutes les variantes.
const VARIANTS = process.env.VARIANTES ? JSON.parse(process.env.VARIANTES) : { [LABEL]: null };
const acc = Object.fromEntries(Object.keys(VARIANTS).map((v) => [v, { total: BANDS.map(() => 0), missed: BANDS.map(() => 0), area: 0, off: 0, n: 0, perClip: {}, detail: [] }]));

// Part de l'image sous un masque, et part masquée loin de tout visage repéré (visage agrandi de moitié de chaque côté).
function areas(e, masks) {
  const G = 120;
  let a = 0, o = 0;
  for (let gy = 0; gy < G; gy++) for (let gx = 0; gx < G; gx++) {
    const x = (gx + 0.5) * e.W / G, y = (gy + 0.5) * e.H / G;
    if (!masks.some((m) => x >= m.x && x <= m.x + m.w && y >= m.y && y <= m.y + m.h)) continue;
    a++;
    if (!e.faces.some((f) => x >= f[0] - f[2] / 2 && x <= f[0] + 1.5 * f[2] && y >= f[1] - f[3] / 2 && y <= f[1] + 1.5 * f[3])) o++;
  }
  return [a / (G * G), o / (G * G)];
}

for (const clip of clips) {
  await send('Page.navigate', { url: SITE });
  await sleep(1000);
  await run(`while (!window.skred || document.getElementById('file').disabled) await new Promise(r => setTimeout(r, 100));`);
  await run(`const b = await (await fetch('test/reel/${clip}')).blob(); const dt = new DataTransfer(); dt.items.add(new File([b], '${clip}', { type: 'video/mp4' }));
    const inp = document.getElementById('file'); inp.files = dt.files; inp.dispatchEvent(new Event('change'));`);
  await run(`while (document.getElementById('s-review').hidden && document.getElementById('fatal').hidden) await new Promise(r => setTimeout(r, 200));`);
  const entries = ref.filter((e) => e.clip === clip);
  const frames = entries.map((e) => e.frame);
  let line = clip.padEnd(45);
  for (const [name, params] of Object.entries(VARIANTS)) {
    // Chaque variante : { judge: {...}, track: {...} }, appliquée par-dessus les réglages d'origine du site.
    if (params) await run(`window.skred.rejudge(${JSON.stringify({ confirm: 0.3, ...params.judge })}, ${JSON.stringify({ lowGrow: 1.5, ...params.track })});`);
    const got = await run(`const S = window.skred.S; const short = Math.min(S.W, S.H);
      const tracks = S.tracks.filter(t => !t.removed).map(t => { const d = [...t.dets.values()]; return { n: d.length, w: Math.max(...d.map(x => x.w)) / short, s: Math.max(...d.map(x => x.s)), lo: d.filter(x => x.lo).length, sure: d.filter(x => x.sure).length, weak: d.filter(x => x.weak).length }; });
      return { tracks, W: S.W, H: S.H, masks: ${JSON.stringify(frames)}.map(i => (S.frames[i] || []).filter(m => !m.track.removed).map(({ x, y, w, h }) => ({ x, y, w, h }))) };`);
    const A = acc[name];
    let cm = 0, ct = 0;
    entries.forEach((e, k) => {
      const sx = got.W / e.W, sy = got.H / e.H;   // au cas où le site aurait réduit la vidéo
      const masks = got.masks[k].map((m) => ({ x: m.x / sx, y: m.y / sy, w: m.w / sx, h: m.h / sy }));
      const side = Math.min(e.W, e.H);
      for (const f of e.faces) {
        const band = BANDS.findIndex(([a, b]) => f[2] / side >= a && f[2] / side < b);
        if (band < 0) continue;
        A.total[band]++; ct++;
        if (coverage(f, masks) < 0.7) { A.missed[band]++; cm++; }
      }
      const [a, o] = areas(e, masks);
      A.area += a; A.off += o; A.n++;
      A.detail.push({ image: e.image, masks: masks.map((m) => [m.x, m.y, m.w, m.h].map(Math.round)) });
    });
    A.perClip[clip] = { rates: cm, visages: ct, pistes: got.tracks };
    line += `  ${name} ${cm}/${ct}`;
  }
  console.log(line);
}
ws.close();
chrome.kill();

for (const [name, A] of Object.entries(acc)) {
  const res = { label: name, images: A.n, rates: A.missed.reduce((a, b) => a + b), visages: A.total.reduce((a, b) => a + b),
    parTaille: Object.fromEntries(BANDS.map((b, k) => [`${b[0] * 100}-${Math.min(b[1], 1) * 100} %`, `${A.missed[k]}/${A.total[k]}`])),
    surfaceMasquee: +(100 * A.area / A.n).toFixed(1), surfaceSansVisage: +(100 * A.off / A.n).toFixed(1), perClip: A.perClip };
  writeFileSync(join(DATA, 'reel', `resultat-${name}.json`), JSON.stringify(res, null, 1));
  writeFileSync(join(DATA, 'reel', `masques-${name}.json`), JSON.stringify(A.detail));
  console.log(JSON.stringify({ ...res, perClip: undefined }));
}
