// Test de bout en bout dans Chrome sans fenêtre : analyse, export, contrôle des masques dans le fichier produit.
// Usage : python test/make-test-video.py (une fois), node dev-server.mjs (dans un autre terminal), puis node test/run-test.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9333;
const SITE = 'http://localhost:5173/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
const requests = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Network.requestWillBeSent') requests.push(m.params.request.url);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) => new Promise((r) => { const id = nextId++; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const run = async (expression) => {
  const r = await send('Runtime.evaluate', { expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails.exception || r.result.exceptionDetails));
  return r.result.result.value;
};

await send('Network.enable');
await send('Page.enable');
await send('Page.navigate', { url: SITE });
await sleep(1000);
await run(`while (document.getElementById('file').disabled) await new Promise(r => setTimeout(r, 100));`);
const out = { parallel: await run(`return window.skred.S.parallel;`) };

// Arguments : fichier (dans test/), échelle des positions connues (1.5 pour test3.mp4 en 1080 x 1920),
// puis au choix "fast" (analyse rapide), "noexport" (analyse seule), "save" (enregistre la vidéo masquée dans test/out/).
// TRUTH donne la position connue des 4 visages des vidéos fabriquées par make-test-video.py, à l'instant t.
const file = process.argv[2] || 'test2.mp4';
const K = Number(process.argv[3]) || 1;
const known = file === 'test2.mp4' || file === 'test3.mp4';
const TRUTH = `const truth = (t) => [[60+280*Math.abs(Math.sin(t*2.5))+120, 120+200*Math.abs(Math.cos(t*1.7))+135], [124,869], [517+60*Math.sin(t),1022], [632,1195]].map(([x, y]) => [x * ${K}, y * ${K}]);`;
if (process.argv.includes('fast')) await run(`document.getElementById('fast').checked = true;`);

await run(`const b = await (await fetch('test/${file}')).blob(); const dt = new DataTransfer(); dt.items.add(new File([b], '${file}', { type: 'video/mp4' }));
  const inp = document.getElementById('file'); inp.files = dt.files; inp.dispatchEvent(new Event('change'));`);
const mark = requests.length;
await run(`while (document.getElementById('s-review').hidden) await new Promise(r => setTimeout(r, 100));`);

const STATS = `const stats = () => { const S = window.skred.S; const miss = [0,0,0,0];
  if (${known}) S.frames.forEach((boxes, i) => truth((i + 0.5) / S.fps).forEach(([X, Y], k) => { if (!boxes.some(b => X >= b.x && X <= b.x + b.w && Y >= b.y && Y <= b.y + b.h)) miss[k]++; }));
  return { suivis: S.tracks.length, casesParImage: +(S.frames.reduce((a, f) => a + f.length, 0) / S.frames.length).toFixed(1), imagesSansMasque: ${known} ? miss : 'non mesuré' }; };`;
out.scan = await run(`${TRUTH} ${STATS} const S = window.skred.S;
  return { taille: S.W + 'x' + S.H, images: S.frames.length, msParImage: Math.round(S.scanMs / S.frames.length),
    visagesSursParImage: +(S.raw.reduce((a, f) => a + f.filter(d => d.s >= 0.3).length, 0) / S.raw.length).toFixed(1), ...stats() };`);
out.reglages = await run(`${TRUTH} ${STATS} const res = {};
  for (const [match, lowMatch] of [[1, 0], [1, 0.6], [1.6, 0], [1.6, 0.6], [2.5, 0.6], [2.5, 1]]) { window.skred.retrack({ match, lowMatch }); res[match + ' / ' + lowMatch] = stats(); }
  window.skred.retrack({ match: 1.6, lowMatch: 0.6 }); return res;`);
const save = process.argv.includes('save');   // enregistre la vidéo masquée dans test/out/
if ((!known && !save) || process.argv.includes('noexport')) { console.log(JSON.stringify(out, null, 2)); ws.close(); chrome.kill(); process.exit(0); }
await run(`document.getElementById('export').click(); while (document.getElementById('s-done').hidden && document.getElementById('fatal').hidden) await new Promise(r => setTimeout(r, 200));`);

out.export = await run(`${TRUTH} const S = window.skred.S; const v = document.getElementById('result');
  await new Promise(r => setTimeout(r, 500));
  const c = document.createElement('canvas'); c.width = S.W; c.height = S.H; const x = c.getContext('2d', { willReadFrequently: true });
  const lit = (X, Y) => { const d = x.getImageData(Math.round(X), Math.round(Y), 1, 1).data; return d[0] + d[1] + d[2] > 40 ? 1 : 0; };
  // Le fichier produit peut être décalé de quelques images : on teste plusieurs décalages et on garde le meilleur.
  const offs = []; for (let o = 0; o <= 0.4001; o += 0.02) offs.push(o);
  const bad = offs.map(() => [0,0,0,0]); let n = 0; const dur = Number.isFinite(v.duration) ? v.duration : S.duration;
  if (${known}) for (let t = 0.45; t < dur - 0.3; t += 1 / 30) {
    await new Promise(r => { v.addEventListener('seeked', r, { once: true }); v.currentTime = t; }); await new Promise(r => setTimeout(r, 25));
    x.drawImage(v, 0, 0, S.W, S.H); n++;
    offs.forEach((o, i) => truth(t - o).forEach(([X, Y], k) => { bad[i][k] += lit(X, Y); }));
  }
  const best = bad.reduce((a, b) => (b.reduce((p, q) => p + q, 0) < a.reduce((p, q) => p + q, 0) ? b : a));
  const txt = await S.resultFile.text();
  return { info: document.getElementById('doneInfo').textContent, erreur: document.getElementById('fatal').textContent, duree: v.duration, imagesControlees: n, visagesVisibles: best,
    metadonnees: ['Lavf', '48.8566', 'TestPhone'].filter(k => txt.includes(k)) };`);

if (save) {
  const b64 = await run(`const buf = new Uint8Array(await window.skred.S.resultFile.arrayBuffer()); let s = ''; for (let i = 0; i < buf.length; i += 32768) s += String.fromCharCode(...buf.subarray(i, i + 32768)); return btoa(s);`);
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(new URL('./out/', import.meta.url), { recursive: true });
  const name = file.replace(/\.\w+$/, '') + '-masque.mp4';
  writeFileSync(new URL('./out/' + name, import.meta.url), Buffer.from(b64, 'base64'));
  out.fichier = 'test/out/' + name;
}
out.requetesApresChargement = requests.slice(mark).filter((u) => !u.startsWith('blob:') && !u.startsWith('data:'));
console.log(JSON.stringify(out, null, 2));
ws.close();
chrome.kill();
