// Rend le réel en MP4 1080 x 1920 : Chrome sans fenêtre dessine chaque image, ffmpeg les assemble.
// Usage : node reel/render.mjs                 -> reel/skred-reel.mp4
//         node reel/render.mjs 1.5 4 9 <dossier> -> quelques images fixes en PNG, pour vérifier
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const root = fileURLToPath(new URL('..', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const args = process.argv.slice(2);
const stills = args.filter((a) => /^\d+(\.\d+)?$/.test(a)).map(Number);
const stillDir = args.find((a) => !/^\d+(\.\d+)?$/.test(a));

const server = spawn(process.execPath, ['dev-server.mjs'], { cwd: root, env: { ...process.env, PORT: '5188' }, stdio: 'ignore' });
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9335', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'skred-reel-'))}`,
  '--no-first-run', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
const quit = () => { try { chrome.kill(); } catch {} try { server.kill(); } catch {} };

try {
  let page;
  for (let i = 0; i < 50 && !page; i++) {
    await sleep(200);
    try { page = (await (await fetch('http://127.0.0.1:9335/json')).json()).find((t) => t.type === 'page'); } catch { /* pas encore prêt */ }
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => { ws.onopen = r; });
  let nextId = 1;
  const pending = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise((r) => { const id = nextId++; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const run = async (x) => {
    const r = await send('Runtime.evaluate', { expression: `(async () => { ${x} })()`, awaitPromise: true, returnByValue: true });
    if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 600));
    return r.result.result.value;
  };

  await send('Page.navigate', { url: 'http://localhost:5188/reel/reel.html' });
  for (let i = 0; i < 100; i++) {
    await sleep(100);
    try { if (await run('return window.ready === true;')) break; } catch { /* page en chargement */ }
  }
  const { FPS, DURATION } = await run('return window.reel;');
  const frame = async (t) => Buffer.from(await run(`window.render(${t}); return document.getElementById('c').toDataURL('image/png').slice(22);`), 'base64');

  if (stills.length) {
    mkdirSync(stillDir, { recursive: true });
    for (const t of stills) writeFileSync(join(stillDir, `t${t}.png`), await frame(t));
    console.log(`${stills.length} images dans ${stillDir}`);
  } else {
    const out = join(root, 'reel', 'skred-reel.mp4');
    const ff = spawn('ffmpeg', ['-y', '-v', 'error', '-f', 'image2pipe', '-c:v', 'png', '-framerate', String(FPS), '-i', '-',
      '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-shortest',
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p', '-r', String(FPS),
      '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', out], { stdio: ['pipe', 'inherit', 'inherit'] });
    const done = new Promise((r) => ff.on('close', r));
    const total = Math.round(FPS * DURATION);
    for (let i = 0; i < total; i++) {
      if (!ff.stdin.write(await frame(i / FPS))) await new Promise((r) => ff.stdin.once('drain', r));
      if (i % 75 === 0) console.log(`${Math.round(i / total * 100)} %`);
    }
    ff.stdin.end();
    console.log('ffmpeg terminé, code', await done, '->', out);
  }
  ws.close();
} finally {
  quit();
}
