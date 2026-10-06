// Captures d'écran de chaque étape, dans Chrome sans fenêtre, au format téléphone puis ordinateur.
// Usage : node dev-server.mjs (dans un autre terminal), puis node test/shots.mjs [fichier dans test/]
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9334;
const SITE = 'http://localhost:5173/';
const file = process.argv[2] || 'real-a.mp4';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = new URL('./shots/', import.meta.url);
mkdirSync(out, { recursive: true });

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'skred-'))}`,
  '--autoplay-policy=no-user-gesture-required', '--window-size=1280,900', '--no-first-run', '--hide-scrollbars', 'about:blank',
], { stdio: 'ignore' });

let page;
for (let i = 0; i < 50 && !page; i++) {
  await sleep(200);
  try { page = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((t) => t.type === 'page'); } catch { /* pas prêt */ }
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
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(new URL(name + '.png', out), Buffer.from(r.result.data, 'base64'));
  console.log('capture', name);
};
const waitFor = (id) => run(`while (document.getElementById('${id}').hidden) await new Promise(r => setTimeout(r, 100));`);
const load = () => run(`const b = await (await fetch('test/${file}')).blob(); const dt = new DataTransfer(); dt.items.add(new File([b], '${file}', { type: 'video/mp4' }));
  const inp = document.getElementById('file'); inp.files = dt.files; inp.dispatchEvent(new Event('change'));`);

await send('Page.enable');
for (const [tag, width, height, mobile] of [['m', 375, 812, true], ['d', 1280, 800, false]]) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile });
  await send('Page.navigate', { url: SITE });
  await sleep(1200);
  await run(`while (document.getElementById('file').disabled) await new Promise(r => setTimeout(r, 100));`);
  await shot(tag + '1-accueil');
  await load();
  await sleep(2500);
  await shot(tag + '2-analyse');
  await waitFor('s-review');
  await run(`const tm = document.getElementById('time'); tm.value = 5; tm.dispatchEvent(new Event('input')); await new Promise(r => setTimeout(r, 800));`);
  await shot(tag + '3-verification');
  // Sélection d'un masque automatique : premier visage de l'image affichée.
  await run(`const S = window.skred.S; const b = (S.frames[window.skred.frameIndex(S.t)] || [])[0]; if (b) { S.sel = { track: b.track }; }
    const view = document.getElementById('view'); const r = view.getBoundingClientRect();
    view.dispatchEvent(new PointerEvent('pointerdown', { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, pointerId: 1 }));
    view.dispatchEvent(new PointerEvent('pointerup', { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, pointerId: 1 }));
    await new Promise(r => setTimeout(r, 400));`);
  await shot(tag + '4-selection');
  await run(`document.getElementById('export').click(); await new Promise(r => setTimeout(r, 2500));`);
  await shot(tag + '5-creation');
  await waitFor('s-done');
  await sleep(800);
  await shot(tag + '6-resultat');
}
ws.close();
chrome.kill();
