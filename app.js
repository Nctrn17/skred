// skred : masque les visages d'une vidéo ou d'une photo, entièrement dans le navigateur.
// Aucune requête réseau après le chargement de la page (voir aussi la politique de sécurité dans vercel.json).
import { createDetector } from './detector.js';

const $ = (id) => document.getElementById(id);

const MIN_SCORE = 0.3;        // seuil de détection bas : on préfère trop masquer que pas assez
const GROW = 1.3;             // chaque case est agrandie de 30 % autour du visage
const ANALYSIS_FPS = 30;      // images regardées par seconde de vidéo
const HOLD_FRAMES = 4;        // chaque masque commence 4 images avant et finit 4 images après le visage
const KEEP_SCORE = 0.15;      // un visage déjà suivi reste suivi même quand il devient très incertain
// Réglages du suivi d'un visage d'une image à l'autre.
const TRACK = {
  gap: 20,          // un visage perdu moins de 20 images reste masqué pendant le trou
  match: 1.6,       // distance maximale entre deux images, en largeurs de visage
  lowMatch: 0.6,    // même chose pour une détection très incertaine
  minReach: 0.02,   // distance minimale tolérée (part du petit côté de l'image), pour les très petits visages
};
const DET_SIDE_DEEP = 1920;   // taille de l'image analysée (plus grand côté)
const DET_SIDE = 1280;        // avec l'option « aller plus vite »
const MAX_SIDE = 1920;        // plus grand côté de la vidéo produite
const MAX_SIDE_PHOTO = 4096;

const VERSION = '2026-10-03.4';   // affichée en bas de page, pour savoir quelle version tourne sur un téléphone
const DEBUG = location.hostname === 'localhost' || new URLSearchParams(location.search).has('debug');

const hasRVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;

const video = $('src');
const view = $('view');
const vctx = view.getContext('2d');
const work = document.createElement('canvas');
const wctx = work.getContext('2d');
const preview = document.createElement('canvas');
const pctx = preview.getContext('2d');

const S = {
  runners: [], parallel: 0,
  kind: 'video',    // 'video' ou 'photo'
  img: null,
  W: 0, H: 0, duration: 0, fps: 30, srcFps: 30,
  tracks: [],       // un suivi par visage : { id, dets: Map(image -> cadre), removed }
  frames: [],       // pour chaque image, les cases à dessiner : [{ x, y, w, h, track }] en pixels
  manual: [],       // masques ajoutés à la main : [{ id, cx, cy, size, t0, t1 }]
  sel: null,        // masque sélectionné : { manual } ou { track }
  nextId: 1,
  t: 0,
  style: 'noir',
  emoji: '😶',
  job: null,        // tâche en cours (analyse ou création), annulable
  playing: false,
  srcUrl: null,
  resultUrl: null,
  resultFile: null,
  audioCtx: null,
  audioNode: null,
  wake: null,
  scanMs: 0,
  seekFallbacks: 0, // images reprises une par une après la lecture en continu
  detectMs: 0, detectCount: 0,
  raw: [],          // détections brutes, image par image
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const secs = (t) => t.toFixed(1).replace('.', ',') + ' s';
const isPhoto = () => S.kind === 'photo';

/* ---------- Écrans ---------- */

function show(step) {
  for (const s of ['home', 'scan', 'review', 'export', 'done']) $('s-' + s).hidden = s !== step;
  $('stage').hidden = !['scan', 'review', 'export'].includes(step);
  window.scrollTo(0, 0);
}

function fail(el, msg) {
  el.textContent = msg;
  el.hidden = false;
}

async function keepAwake(on) {
  try {
    if (on && navigator.wakeLock) S.wake = await navigator.wakeLock.request('screen');
    if (!on && S.wake) { await S.wake.release(); S.wake = null; }
  } catch { /* pas grave */ }
}

/* ---------- Chargement du détecteur (fichiers hébergés sur le site) ---------- */

// La recherche tourne dans plusieurs fils d'exécution (un par cœur disponible, 3 au plus).
// Si le navigateur ne le permet pas, elle tourne dans la page, plus lentement.
function startWorker() {
  return new Promise((resolve) => {
    let w;
    try { w = new Worker('detect-worker.js', { type: 'module' }); } catch { resolve(null); return; }
    const pending = new Map();
    let nextId = 1;
    const giveUp = setTimeout(() => { w.terminate(); resolve(null); }, 20000);
    const runner = {
      detect: (bitmap, maxSide) => new Promise((ok, ko) => {
        const id = nextId++;
        pending.set(id, { ok, ko });
        w.postMessage({ type: 'detect', id, bitmap, w: bitmap.width, h: bitmap.height, maxSide, minScore: KEEP_SCORE }, [bitmap]);
      }),
    };
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'ready') { clearTimeout(giveUp); resolve(runner); return; }
      const p = pending.get(m.id);
      if (m.type === 'error' && !p) { clearTimeout(giveUp); w.terminate(); resolve(null); return; }
      if (!p) return;
      pending.delete(m.id);
      if (m.type === 'done') p.ok(m.boxes); else p.ko(new Error(m.message));
    };
    w.onerror = () => { clearTimeout(giveUp); resolve(null); };
    w.postMessage({ type: 'init' });
  });
}

async function localRunner() {
  const detect = await createDetector(new URL('.', location.href).href);
  return {
    detect: async (bitmap, maxSide) => {
      const boxes = await detect(bitmap, bitmap.width, bitmap.height, maxSide, KEEP_SCORE);
      bitmap.close();
      return boxes;
    },
  };
}

async function init() {
  try {
    const cores = navigator.hardwareConcurrency || 2;
    const wanted = clamp(cores - 1, 1, 3);
    const noWorkers = new URLSearchParams(location.search).has('simple');
    const workers = noWorkers ? [] : (await Promise.all(Array.from({ length: wanted }, startWorker))).filter(Boolean);
    S.runners = workers.length ? workers : [await localRunner()];
    S.parallel = workers.length;
    $('file').disabled = false;
    $('pickLabel').removeAttribute('aria-disabled');
    $('pickText').textContent = 'Choisir une vidéo ou une photo';
  } catch (e) {
    console.error(e);
    $('pickText').textContent = 'Outil indisponible';
    fail($('homeError'), "L'outil n'a pas pu se charger sur ce navigateur. Essaie avec Chrome ou Safari à jour.");
  }
}

/* ---------- Lecture du fichier d'origine ---------- */

function once(target, ok, bad, ms) {
  return new Promise((resolve, reject) => {
    const done = (fn, v) => { target.removeEventListener(ok, onOk); if (bad) target.removeEventListener(bad, onBad); fn(v); };
    const onOk = () => done(resolve);
    const onBad = () => done(reject, new Error(bad));
    target.addEventListener(ok, onOk);
    if (bad) target.addEventListener(bad, onBad);
    if (ms) setTimeout(() => done(reject, new Error('timeout')), ms);
  });
}

// Place la vidéo à l'instant t et attend que l'image soit vraiment disponible.
function seekTo(t) {
  return new Promise((resolve) => {
    let seeked = false, framed = false, finished = false;
    const fin = () => { if (!finished) { finished = true; resolve(); } };
    video.addEventListener('seeked', () => {
      seeked = true;
      if (framed) fin(); else setTimeout(fin, 15);
    }, { once: true });
    if (hasRVFC) video.requestVideoFrameCallback(() => { framed = true; if (seeked) fin(); });
    setTimeout(fin, 3000);
    video.currentTime = t;
  });
}

async function measureFps() {
  if (!hasRVFC) return 30;
  const times = [];
  let stop = false;
  const cb = (_, meta) => {
    times.push(meta.mediaTime);
    if (!stop) video.requestVideoFrameCallback(cb);
  };
  video.requestVideoFrameCallback(cb);
  video.muted = true;
  try { await video.play(); } catch { return 30; }
  const t0 = performance.now();
  while (times.length < 14 && performance.now() - t0 < 1500) await sleep(30);
  stop = true;
  video.pause();
  const deltas = [];
  for (let i = 1; i < times.length; i++) if (times[i] > times[i - 1]) deltas.push(times[i] - times[i - 1]);
  if (deltas.length < 4) return 30;
  deltas.sort((a, b) => a - b);
  const fps = 1 / deltas[deltas.length >> 1];
  return Number.isFinite(fps) ? fps : 30;
}

const drawSource = (ctx) => ctx.drawImage(isPhoto() ? S.img : video, 0, 0, S.W, S.H);
const frameTime = (i) => Math.min((i + 0.5) / S.fps, Math.max(0, S.duration - 0.001));
const frameIndex = (t) => clamp(Math.floor(t * S.fps), 0, Math.max(0, S.frames.length - 1));

async function loadFile(file) {
  resetAll();
  $('homeError').hidden = true;
  S.kind = file.type.startsWith('image/') || /\.(jpe?g|png|webp|heic|heif)$/i.test(file.name) ? 'photo' : 'video';
  S.srcUrl = URL.createObjectURL(file);
  let w, h;
  try {
    if (isPhoto()) {
      S.img = await createImageBitmap(file);   // tient compte du sens de la photo (portrait ou paysage)
      w = S.img.width;
      h = S.img.height;
      S.duration = 0;
    } else {
      video.src = S.srcUrl;
      await once(video, 'loadeddata', 'error', 20000);
      if (!Number.isFinite(video.duration)) {
        // Certains fichiers n'annoncent pas leur durée : on force le navigateur à la chercher.
        video.currentTime = 1e7;
        await once(video, 'durationchange', null, 5000).catch(() => {});
      }
      if (!Number.isFinite(video.duration) || video.duration <= 0) throw new Error('illisible');
      w = video.videoWidth;
      h = video.videoHeight;
      S.duration = video.duration;
    }
    if (!w || !h) throw new Error('illisible');
  } catch {
    fail($('homeError'), "Ton navigateur n'arrive pas à lire ce fichier. Essaie avec un autre, ou enregistre-le dans un autre format.");
    return;
  }

  const k = Math.min(1, (isPhoto() ? MAX_SIDE_PHOTO : MAX_SIDE) / Math.max(w, h));
  S.W = Math.round(w * k / 2) * 2;
  S.H = Math.round(h * k / 2) * 2;
  for (const c of [view, work, preview]) { c.width = S.W; c.height = S.H; }

  show('scan');
  $('scanBar').style.width = '0';
  $('scanText').textContent = 'Préparation…';
  await scan();
}

/* ---------- Analyse : la vidéo est regardée 30 fois par seconde ---------- */

async function scan() {
  const job = { cancelled: false };
  S.job = job;
  await keepAwake(true);

  // On regarde 30 images par seconde. Une vidéo à 60 images par seconde est regardée une image sur deux :
  // les masques couvrent quand même toutes les images, puisqu'ils débordent de plusieurs images autour de chaque visage.
  S.srcFps = isPhoto() ? 1 : await measureFps();
  S.fps = isPhoto() ? 1 : ANALYSIS_FPS;
  const total = isPhoto() ? 1 : Math.max(1, Math.ceil(S.duration * S.fps));
  const side = !isPhoto() && $('fast').checked ? DET_SIDE : DET_SIDE_DEEP;
  const results = new Array(total);
  const started = performance.now();
  S.seekFallbacks = 0;
  S.detectMs = 0;
  S.detectCount = 0;

  // Les images sont distribuées aux fils d'exécution libres, au fur et à mesure.
  const free = [...S.runners], waiting = [];
  const acquire = () => (free.length ? Promise.resolve(free.pop()) : new Promise((r) => waiting.push(r)));
  const tasks = [];
  let done = 0, error = null, onRelease = null;
  const release = (r) => { if (waiting.length) waiting.shift()(r); else free.push(r); if (onRelease) onRelease(); };

  const progress = () => {
    const left = (performance.now() - started) / done * (total - done) / 1000;
    $('scanBar').style.width = (done / total * 100) + '%';
    $('scanText').textContent = isPhoto() ? 'Recherche…'
      : `Image ${done} sur ${total}` + (done > 15 ? ` · encore environ ${left < 60 ? Math.ceil(left) + ' s' : Math.ceil(left / 60) + ' min'}` : '');
  };
  // Aperçu : une image avec ses visages masqués, de temps en temps.
  let shown = null;
  const keepForPreview = (canvas) => { if (!shown) { pctx.drawImage(canvas, 0, 0); shown = canvas; } };
  const showPreview = (canvas, boxes) => {
    if (canvas !== shown) return;
    vctx.drawImage(preview, 0, 0);
    vctx.fillStyle = '#000';
    for (const b of boxes.filter((x) => x.s >= MIN_SCORE).map(grow)) vctx.fillRect(b.x, b.y, b.w, b.h);
    shown = null;
  };
  // Analyse une image (déjà dessinée sur `canvas`) et range le résultat pour les images i à j.
  const submit = async (canvas, i, j) => {
    const runner = await acquire();
    if (job.cancelled || error) { release(runner); return; }
    const bitmap = await createImageBitmap(canvas);
    const t0 = performance.now();
    tasks.push(runner.detect(bitmap, side).then((boxes) => {
      S.detectMs += performance.now() - t0;
      S.detectCount++;
      for (let k = i; k <= j; k++) if (!results[k]) { results[k] = boxes; done++; }
      showPreview(canvas, boxes);
      progress();
    }, (e) => { error = e; }).finally(() => release(runner)));
  };

  if (!isPhoto()) await scanByPlayback(job, total, submit, keepForPreview, () => error);
  // Le reste (tout, si la lecture en continu n'est pas possible) : image par image, en se positionnant sur chacune.
  for (let i = 0; i < total && !job.cancelled && !error; i++) {
    if (results[i]) continue;
    if (!isPhoto()) { await seekTo(frameTime(i)); S.seekFallbacks++; }
    if (job.cancelled || error) break;
    drawSource(wctx);
    keepForPreview(work);
    await submit(work, i, i);
  }
  await Promise.all(tasks);
  await keepAwake(false);
  if (job.cancelled) return;
  S.job = null;
  if (error || results.some((r) => !r)) {
    // Une image non analysée serait une image non masquée : on préfère tout arrêter.
    console.error(error || 'images manquantes');
    goHome();
    fail($('homeError'), "L'analyse a échoué sur ce navigateur. Essaie avec Chrome ou Safari à jour.");
    return;
  }
  S.scanMs = performance.now() - started;
  S.raw = results;
  buildTracks(results);
  openReview(0);
}

// Lecture en continu : chaque image présentée par le navigateur est copiée au vol et envoyée à l'analyse.
// Le navigateur numérote les images présentées : si une a été sautée, on le sait, et elle sera
// reprise ensuite image par image. La lecture est mise en pause quand l'analyse ne suit pas.
async function scanByPlayback(job, total, submit, keepForPreview, failed) {
  if (!hasRVFC || document.hidden) return;
  const ring = Array.from({ length: S.runners.length + 2 }, () => {
    const c = document.createElement('canvas');
    c.width = S.W;
    c.height = S.H;
    return c;
  });
  const frameDur = 1 / clamp(S.srcFps, 10, 120);
  const firstSlot = (t) => Math.ceil(t * S.fps - 0.5);
  let ringPos = 0, inFlight = 0, prev = null, lastPresented = -1, lastTime = -1, lastSeen = performance.now();
  let paused = false, ended = false, stop = false;
  // Vitesse de lecture : assez lente pour copier chaque image, relevée tant qu'aucune image n'est sautée.
  let rate = clamp(30 / S.srcFps, 0.25, 1), sinceSkip = 0;
  const setRate = (r) => { rate = clamp(r, 0.25, 1); try { video.playbackRate = rate; } catch { /* vitesse refusée */ } };

  // Range l'image précédente : elle vaut jusqu'à l'image suivante, ou jusqu'à sa durée normale si une image a été sautée.
  const flush = (end) => {
    if (!prev) return;
    const i = Math.max(0, firstSlot(prev.t)), j = Math.min(total - 1, firstSlot(end) - 1);
    const cap = prev;
    prev = null;
    if (j < i) return;
    inFlight++;
    submit(cap.canvas, i, j).finally(() => { inFlight--; });
  };
  const onFrame = (_, meta) => {
    if (stop) return;
    lastSeen = performance.now();
    const t = meta.mediaTime;
    if (t > lastTime) {
      const skipped = lastPresented >= 0 && meta.presentedFrames - lastPresented > 1;
      flush(skipped ? Math.min(t, (prev ? prev.t : t) + frameDur * 1.2) : t);
      if (skipped) { setRate(rate * 0.75); sinceSkip = 0; } else if (++sinceSkip >= 60) { setRate(rate * 1.15); sinceSkip = 0; }
      const canvas = ring[ringPos++ % ring.length];
      drawSource(canvas.getContext('2d'));
      keepForPreview(canvas);
      prev = { canvas, t };
      lastTime = t;
      lastPresented = meta.presentedFrames;
      if (inFlight >= S.runners.length + 1 && !paused) { paused = true; video.pause(); }
    }
    video.requestVideoFrameCallback(onFrame);
  };
  const resume = () => {
    if (paused && !ended && !stop && !document.hidden && inFlight <= S.runners.length - 1) { paused = false; video.play().catch(() => {}); }
  };
  const onEnded = () => { ended = true; };
  const onVisibility = () => { if (document.hidden) { paused = true; video.pause(); } else resume(); };

  await seekTo(0);
  video.muted = true;
  setRate(rate);
  video.addEventListener('ended', onEnded);
  document.addEventListener('visibilitychange', onVisibility);
  video.requestVideoFrameCallback(onFrame);
  const timer = setInterval(resume, 50);
  try {
    await video.play();
    // Fin normale, annulation, erreur, ou plus aucune image depuis 4 s (lecture bloquée).
    while (!ended && !job.cancelled && !failed() && (paused || document.hidden || performance.now() - lastSeen < 4000)) await sleep(50);
  } catch { /* lecture refusée : tout sera fait image par image */ }
  stop = true;
  clearInterval(timer);
  video.removeEventListener('ended', onEnded);
  document.removeEventListener('visibilitychange', onVisibility);
  video.pause();
  video.playbackRate = 1;
  if (ended && prev) flush(S.duration + 1);
  else prev = null;
}

/* ---------- Suivi : une seule case par visage, d'une image à l'autre ---------- */

function grow(b) {
  const w = b.w * GROW + 4, h = b.h * GROW + 4;
  return { x: b.x + b.w / 2 - w / 2, y: b.y + b.h / 2 - h / 2, w, h };
}

function union(a, b) {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

const lerp = (a, b, k) => ({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, w: a.w + (b.w - a.w) * k, h: a.h + (b.h - a.h) * k });

function buildTracks(results) {
  const N = results.length;
  const tracks = [];
  let active = [];

  // 1. On relie les visages d'une image à la suivante : les paires les plus proches d'abord.
  const floor = Math.min(S.W, S.H) * TRACK.minReach;
  for (let i = 0; i < N; i++) {
    active = active.filter((t) => i - t.lastIdx <= TRACK.gap);
    const dets = results[i];
    const pairs = [];
    for (const d of dets) {
      for (const t of active) {
        const l = t.last;
        if (Math.max(l.w / d.w, d.w / l.w) > 2.5) continue;
        // Plus le visage a été perdu longtemps, plus on le cherche loin (3 fois plus loin au maximum).
        const reach = Math.max((l.w + d.w) / 2, floor) * Math.min(3, 1 + 0.4 * (i - t.lastIdx - 1));
        const dist = Math.hypot(l.x + l.w / 2 - d.x - d.w / 2, l.y + l.h / 2 - d.y - d.h / 2) / reach;
        // Une détection très incertaine ne prolonge un masque que de près, et si le visage a été vu nettement il y a peu.
        const sure = d.s >= MIN_SCORE;
        if (dist < (sure ? TRACK.match : TRACK.lowMatch) && (sure || i - t.sureIdx <= TRACK.gap)) pairs.push({ d, t, dist });
      }
    }
    pairs.sort((x, y) => x.dist - y.dist);
    const usedT = new Set(), usedD = new Set();
    const assign = (d, t) => {
      usedT.add(t);
      usedD.add(d);
      t.dets.set(i, d);
      t.last = d;
      t.lastIdx = i;
      if (d.s >= MIN_SCORE) t.sureIdx = i;
    };
    for (const p of pairs) if (!usedT.has(p.t) && !usedD.has(p.d)) assign(p.d, p.t);
    for (const d of dets) {
      if (usedD.has(d) || d.s < MIN_SCORE) continue;   // trop incertain pour ouvrir un nouveau masque
      const t = { id: tracks.length + 1, dets: new Map(), removed: false };
      tracks.push(t);
      active.push(t);
      assign(d, t);
    }
  }

  // 2. Pour chaque visage : on bouche les trous, on déborde de quelques images avant et après,
  //    et la case de chaque image couvre aussi la position de l'image d'avant et d'après.
  const frames = Array.from({ length: N }, () => []);
  for (const t of tracks) {
    const idx = [...t.dets.keys()];
    const first = idx[0], last = idx[idx.length - 1];
    const a = Math.max(0, first - HOLD_FRAMES), b = Math.min(N - 1, last + HOLD_FRAMES);
    const path = [];
    let k = 0;
    for (let j = a; j <= b; j++) {
      if (j <= first) path.push(t.dets.get(first));
      else if (j >= last) path.push(t.dets.get(last));
      else {
        while (idx[k + 1] <= j) k++;
        path.push(idx[k] === j ? t.dets.get(j) : lerp(t.dets.get(idx[k]), t.dets.get(idx[k + 1]), (j - idx[k]) / (idx[k + 1] - idx[k])));
      }
    }
    for (let j = Math.max(0, a - 1); j <= Math.min(N - 1, b + 1); j++) {
      const near = [path[j - a - 1], path[j - a], path[j - a + 1]].filter(Boolean);
      const box = near.reduce(union);
      const biggest = Math.max(...near.map((r) => r.w * r.h));
      // Si le visage a sauté loin d'une image à l'autre (caméra qui tourne vite), une seule case
      // couvrirait tout l'écran : on garde alors les positions séparées.
      if (box.w * box.h <= 4 * biggest) frames[j].push({ ...grow(box), track: t });
      else for (const r of near) frames[j].push({ ...grow(r), track: t });
    }
  }
  S.tracks = tracks;
  S.frames = frames;
}

/* ---------- Dessin des masques ---------- */

function manualRect(m) {
  const s = m.size * Math.min(S.W, S.H);
  return { x: m.cx * S.W - s / 2, y: m.cy * S.H - s / 2, w: s, h: s };
}

const manualAt = (t) => S.manual.filter((m) => t >= m.t0 - 1e-3 && t <= m.t1 + 1e-3);
const inside = (r, x, y) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

function paint(ctx, t, edit) {
  const auto = S.frames[frameIndex(t)] || [];
  const rects = [...auto.filter((b) => !b.track.removed), ...manualAt(t).map(manualRect)];

  // D'abord les cases pleines : c'est elles qui protègent.
  ctx.fillStyle = '#000';
  for (const r of rects) ctx.fillRect(Math.floor(r.x), Math.floor(r.y), Math.ceil(r.w) + 1, Math.ceil(r.h) + 1);

  // L'émoji est seulement posé par-dessus la case, il ne la remplace jamais.
  if (S.style === 'emoji') {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const r of rects) {
      const s = Math.min(r.w, r.h);
      ctx.font = `${Math.round(s * 0.82)}px serif`;
      ctx.fillText(S.emoji, r.x + r.w / 2, r.y + r.h / 2 + s * 0.06);
    }
  }

  if (!edit) return;
  // Repères visibles seulement pendant la vérification, jamais dans le fichier produit.
  const lw = Math.max(3, Math.min(S.W, S.H) / 180);
  ctx.lineWidth = lw;
  const frame = (r, color, solid) => {
    ctx.strokeStyle = color;
    ctx.setLineDash(solid ? [] : [lw * 3, lw * 2]);
    ctx.strokeRect(r.x, r.y, r.w, r.h);
  };
  for (const b of auto) {
    const selected = S.sel && S.sel.track === b.track;
    if (b.track.removed) frame(b, '#ff6b5e', selected);
    else if (selected) frame(b, '#e9ff45', true);
  }
  for (const m of manualAt(t)) frame(manualRect(m), '#e9ff45', S.sel && S.sel.manual === m);
  ctx.setLineDash([]);
}

/* ---------- Vérification ---------- */

let seekBusy = false, seekNext = null;

async function goTo(t) {
  if (isPhoto()) { S.t = 0; renderReview(); return; }
  seekNext = clamp(t, 0, Math.max(0, S.duration - 0.001));
  if (seekBusy) return;
  seekBusy = true;
  while (seekNext !== null) {
    const x = seekNext;
    seekNext = null;
    await seekTo(x);
    S.t = x;
    renderReview();
  }
  seekBusy = false;
}

function renderReview() {
  drawSource(vctx);
  paint(vctx, S.t, true);
  $('time').value = S.t;
  $('timeText').textContent = `${secs(S.t)} sur ${secs(S.duration)}`;
}

function openReview(t) {
  show('review');
  const time = $('time');
  time.max = S.duration;
  time.step = 1 / S.fps;
  for (const id of ['mStart', 'mEnd']) $(id).max = S.duration;
  for (const el of document.querySelectorAll('.videoOnly')) el.hidden = isPhoto();
  $('export').textContent = isPhoto() ? 'Créer la photo masquée' : 'Créer la vidéo masquée';
  $('stats').hidden = !DEBUG || isPhoto();
  if (DEBUG && !isPhoto()) {
    const n = S.frames.length;
    $('stats').textContent = `${S.W}x${S.H}, ${n} images, ${Math.round(S.scanMs / 1000)} s (${Math.round(S.scanMs / n)} ms/image), `
      + `détection ${Math.round(S.detectMs / Math.max(1, S.detectCount))} ms/image sur ${S.parallel || 'page'} fils, `
      + `${S.seekFallbacks} reprises, source ${S.srcFps.toFixed(1)} i/s, ${navigator.hardwareConcurrency || '?'} cœurs, ${navigator.deviceMemory || '?'} Go`;
  }
  refreshPanels();
  goTo(t);
}

function stopPlay() {
  if (!S.playing) return;
  S.playing = false;
  video.pause();
  $('play').textContent = 'Lecture';
}

async function togglePlay() {
  if (S.playing) { stopPlay(); S.t = video.currentTime; renderReview(); return; }
  S.playing = true;
  $('play').textContent = 'Pause';
  video.muted = true;
  if (S.t >= S.duration - 0.05) await seekTo(0);
  try { await video.play(); } catch { stopPlay(); return; }
  const tick = () => {
    if (!S.playing) return;
    S.t = Math.min(video.currentTime, S.duration);
    renderReview();
    if (video.ended) { stopPlay(); return; }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function refreshPanels() {
  const m = S.sel && S.sel.manual;
  const tr = S.sel && S.sel.track;
  $('manualPanel').hidden = !m;
  if (m) {
    $('manualTitle').textContent = 'Masque ajouté n° ' + (S.manual.indexOf(m) + 1);
    $('mSize').value = m.size;
    $('mStart').value = m.t0;
    $('mEnd').value = m.t1;
    $('mStartText').textContent = secs(m.t0);
    $('mEndText').textContent = secs(m.t1);
  }
  $('autoPanel').hidden = !tr;
  if (tr) $('aToggle').textContent = tr.removed ? 'Remettre ce masque' : 'Retirer ce masque';

  const removed = S.tracks.filter((t) => t.removed).length;
  $('restoreAll').hidden = !removed;
  $('restoreAll').textContent = removed > 1 ? `Remettre les ${removed} masques retirés` : 'Remettre le masque retiré';

  const list = $('manualList');
  list.textContent = '';
  S.manual.forEach((x, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip' + (x === m ? ' on' : '');
    b.textContent = isPhoto() ? `Masque ${i + 1}` : `Masque ${i + 1} · ${secs(x.t0)} à ${secs(x.t1)}`;
    b.onclick = () => { stopPlay(); S.sel = { manual: x }; refreshPanels(); goTo(clamp(S.t, x.t0, x.t1)); };
    list.appendChild(b);
  });
}

function canvasPoint(e) {
  const r = view.getBoundingClientRect();
  return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
}

let drag = null;

view.addEventListener('pointerdown', (e) => {
  if ($('s-review').hidden) return;
  e.preventDefault();
  stopPlay();
  const p = canvasPoint(e);
  const px = p.x * S.W, py = p.y * S.H;

  // 1. Un masque ajouté à la main : on le sélectionne et on peut le faire glisser.
  let m = manualAt(S.t).reverse().find((x) => inside(manualRect(x), px, py));
  // 2. Un masque automatique : on le sélectionne, pour pouvoir le retirer ou le remettre.
  const auto = m ? null : (S.frames[frameIndex(S.t)] || []).filter((b) => inside(b, px, py)).sort((a, b) => a.w * a.h - b.w * b.h)[0];
  if (auto) {
    S.sel = { track: auto.track };
    refreshPanels();
    renderReview();
    return;
  }
  // 3. Rien à cet endroit : on pose un nouveau masque.
  if (!m) {
    m = { id: S.nextId++, cx: p.x, cy: p.y, size: 0.12, t0: Math.max(0, S.t - 1), t1: Math.min(S.duration, S.t + 1) };
    S.manual.push(m);
  }
  S.sel = { manual: m };
  drag = { m, dx: m.cx - p.x, dy: m.cy - p.y };
  view.setPointerCapture(e.pointerId);
  refreshPanels();
  renderReview();
});

view.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const p = canvasPoint(e);
  drag.m.cx = clamp(p.x + drag.dx, 0, 1);
  drag.m.cy = clamp(p.y + drag.dy, 0, 1);
  renderReview();
});

for (const ev of ['pointerup', 'pointercancel']) view.addEventListener(ev, () => { drag = null; });

const selectedManual = () => S.sel && S.sel.manual;
const deselect = () => { S.sel = null; refreshPanels(); renderReview(); };

$('mSize').addEventListener('input', (e) => {
  const m = selectedManual();
  if (!m) return;
  m.size = +e.target.value;
  renderReview();
});
$('mStart').addEventListener('input', (e) => {
  const m = selectedManual();
  if (!m) return;
  m.t0 = Math.min(+e.target.value, m.t1);
  refreshPanels();
  goTo(m.t0);
});
$('mEnd').addEventListener('input', (e) => {
  const m = selectedManual();
  if (!m) return;
  m.t1 = Math.max(+e.target.value, m.t0);
  refreshPanels();
  goTo(m.t1);
});
$('mAll').onclick = () => {
  const m = selectedManual();
  if (!m) return;
  m.t0 = 0;
  m.t1 = S.duration;
  refreshPanels();
  renderReview();
};
$('mDone').onclick = deselect;
$('mDelete').onclick = () => {
  S.manual = S.manual.filter((x) => x !== selectedManual());
  deselect();
};
$('aToggle').onclick = () => {
  if (S.sel && S.sel.track) S.sel.track.removed = !S.sel.track.removed;
  refreshPanels();
  renderReview();
};
$('aDone').onclick = deselect;
$('restoreAll').onclick = () => {
  for (const t of S.tracks) t.removed = false;
  refreshPanels();
  renderReview();
};

$('time').addEventListener('input', (e) => { stopPlay(); goTo(+e.target.value); });
$('prev').onclick = () => { stopPlay(); goTo(S.t - 1 / S.fps); };
$('next').onclick = () => { stopPlay(); goTo(S.t + 1 / S.fps); };
$('play').onclick = togglePlay;

$('styles').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  S.style = b.dataset.style;
  if (b.dataset.emoji) S.emoji = b.dataset.emoji;
  for (const x of $('styles').children) x.classList.toggle('on', x === b);
  renderReview();
});

/* ---------- Création du fichier masqué ---------- */

function finish(blob, name, info) {
  if (S.resultUrl) URL.revokeObjectURL(S.resultUrl);
  S.resultUrl = URL.createObjectURL(blob);
  S.resultFile = new File([blob], name, { type: blob.type });
  $('result').hidden = isPhoto();
  $('resultImg').hidden = !isPhoto();
  (isPhoto() ? $('resultImg') : $('result')).src = S.resultUrl;
  $('download').href = S.resultUrl;
  $('download').download = name;
  $('download').textContent = isPhoto() ? 'Télécharger la photo' : 'Télécharger la vidéo';
  $('share').hidden = !(navigator.canShare && navigator.canShare({ files: [S.resultFile] }));
  $('doneTitle').textContent = isPhoto() ? 'Ta photo est prête.' : 'Ta vidéo est prête.';
  $('doneCheck').textContent = isPhoto()
    ? 'Regarde-la de près avant de la poster. Si un visage apparaît, reviens corriger les masques.'
    : 'Regarde-la en entier avant de la poster. Si un visage apparaît, reviens corriger les masques.';
  $('doneInfo').textContent = `${info}, ${(blob.size / 1e6).toFixed(1).replace('.', ',')} Mo.`;
  show('done');
}

async function exportPhoto() {
  S.sel = null;
  $('fatal').hidden = true;
  drawSource(vctx);
  paint(vctx, 0, false);
  const blob = await new Promise((r) => view.toBlob(r, 'image/jpeg', 0.92));
  if (!blob) { fail($('fatal'), "Ce navigateur n'a pas pu créer la photo."); return; }
  finish(blob, 'photo-masquee.jpg', 'Fichier JPEG');
}

// Le navigateur écrit dans un fichier MP4 la date et l'heure de sa création. On les remet à zéro :
// le fichier produit ne dit plus quand il a été fait.
async function scrubMp4Dates(blob) {
  const head = new Uint8Array(await blob.slice(0, 1 << 20).arrayBuffer());
  const view = new DataView(head.buffer);
  const type = (p) => String.fromCharCode(head[p + 4], head[p + 5], head[p + 6], head[p + 7]);
  const walk = (start, end) => {
    for (let p = start; p + 8 <= end;) {
      const size = view.getUint32(p);
      if (size < 8 || p + size > end) return;   // boîte coupée ou de forme inattendue : on n'y touche pas
      const t = type(p);
      if (t === 'moov' || t === 'trak' || t === 'mdia') walk(p + 8, p + size);
      else if (t === 'mvhd' || t === 'tkhd' || t === 'mdhd') head.fill(0, p + 12, p + 12 + (head[p + 8] === 1 ? 16 : 8));
      p += size;
    }
  };
  walk(0, head.length);
  return new Blob([head, blob.slice(head.length)], { type: blob.type });
}

function pickMime() {
  if (!window.MediaRecorder) return null;
  const list = [
    'video/mp4;codecs="avc1.640028,mp4a.40.2"',
    'video/mp4;codecs="avc1.42E01F,mp4a.40.2"',
    'video/mp4',
    'video/webm;codecs="vp9,opus"',
    'video/webm;codecs="vp8,opus"',
    'video/webm',
  ];
  return list.find((m) => MediaRecorder.isTypeSupported(m)) || null;
}

async function exportVideo() {
  stopPlay();
  S.sel = null;
  const mime = pickMime();
  if (!mime || !view.captureStream) {
    fail($('fatal'), "Ce navigateur ne sait pas créer de vidéo. Essaie avec Chrome ou Safari à jour.");
    return;
  }
  $('fatal').hidden = true;

  // À faire tout de suite, pendant que le navigateur sait encore que l'utilisateur vient de toucher le bouton
  // (sinon l'iPhone refuse de lire la vidéo avec le son).
  const keepAudio = $('audio').checked;
  let audioDest = null, audioFailed = false;
  if (keepAudio) {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      S.audioCtx = S.audioCtx || new AC();
      S.audioCtx.resume();
      S.audioNode = S.audioNode || S.audioCtx.createMediaElementSource(video);
      audioDest = S.audioCtx.createMediaStreamDestination();
      S.audioNode.connect(audioDest);
    } catch (e) {
      console.error(e);
      audioFailed = true;
    }
  }
  video.muted = !keepAudio;
  video.volume = 1;
  const unlock = video.play();
  if (unlock) await unlock.then(() => video.pause(), () => {});

  const job = { cancelled: false };
  S.job = job;
  show('export');
  $('exportBar').style.width = '0';
  $('exportText').textContent = audioFailed ? "Le son n'a pas pu être repris : la vidéo sera muette." : '';
  await keepAwake(true);

  const draw = (t) => {
    vctx.drawImage(video, 0, 0, S.W, S.H);
    paint(vctx, t, false);
  };

  await seekTo(0);
  draw(0);

  // La vidéo produite est un enregistrement de cette image masquée : l'original n'y entre jamais.
  const stream = view.captureStream();
  if (audioDest) for (const tr of audioDest.stream.getAudioTracks()) stream.addTrack(tr);

  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: clamp(S.W * S.H * 4, 2_500_000, 10_000_000), audioBitsPerSecond: 128_000 });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise((r) => { rec.onstop = r; });
  rec.start();
  draw(0);

  let running = true;
  const frame = (t) => {
    if (!running) return;
    draw(t);
    $('exportBar').style.width = clamp(t / S.duration * 100, 0, 100) + '%';
  };
  const loop = hasRVFC
    ? (_, meta) => { frame(meta.mediaTime); if (running) video.requestVideoFrameCallback(loop); }
    : () => { frame(video.currentTime); if (running) requestAnimationFrame(loop); };
  if (hasRVFC) video.requestVideoFrameCallback(loop); else requestAnimationFrame(loop);

  // Si la page passe en arrière-plan, on met tout en pause pour ne pas abîmer la vidéo.
  const onHide = () => {
    if (document.hidden) { video.pause(); if (rec.state === 'recording') rec.pause(); }
    else { if (rec.state === 'paused') rec.resume(); video.play().catch(() => {}); }
  };
  document.addEventListener('visibilitychange', onHide);

  let failed = false;
  try {
    const ended = once(video, 'ended', 'error');
    while (document.hidden && !job.cancelled) await sleep(300);
    await video.play();
    job.cancel = () => video.dispatchEvent(new Event('ended'));
    await ended;
  } catch (e) {
    console.error(e);
    failed = true;
  }
  video.pause();
  if (!job.cancelled && !failed) { frame(S.duration); await sleep(200); }
  running = false;
  document.removeEventListener('visibilitychange', onHide);
  if (rec.state !== 'inactive') rec.stop();
  await stopped;
  for (const tr of stream.getTracks()) tr.stop();
  if (audioDest) S.audioNode.disconnect(audioDest);
  video.muted = true;
  S.job = null;
  await keepAwake(false);

  if (job.cancelled) { openReview(0); return; }
  if (failed || !chunks.length) {
    openReview(0);
    fail($('fatal'), "La création de la vidéo a échoué sur ce navigateur. Essaie avec Chrome ou Safari à jour.");
    return;
  }

  const type = (rec.mimeType || mime).split(';')[0];
  const mp4 = type.includes('mp4');
  const made = new Blob(chunks, { type });
  finish(mp4 ? await scrubMp4Dates(made) : made, 'video-masquee.' + (mp4 ? 'mp4' : 'webm'), `Fichier ${mp4 ? 'MP4' : 'WebM'}${audioDest ? ', avec le son' : ', sans le son'}`);
}

$('export').onclick = () => (isPhoto() ? exportPhoto() : exportVideo());
$('share').onclick = async () => {
  try { await navigator.share({ files: [S.resultFile] }); } catch { /* partage annulé */ }
};
$('back').onclick = () => { $('result').pause(); openReview(S.t); };

/* ---------- Annuler, recommencer ---------- */

function cancelJob() {
  if (!S.job) return;
  S.job.cancelled = true;
  if (S.job.cancel) S.job.cancel();
}

function resetAll() {
  cancelJob();
  S.job = null;
  stopPlay();
  keepAwake(false);
  $('result').pause();
  $('result').removeAttribute('src');
  $('resultImg').removeAttribute('src');
  if (S.srcUrl) URL.revokeObjectURL(S.srcUrl);
  if (S.resultUrl) URL.revokeObjectURL(S.resultUrl);
  S.srcUrl = S.resultUrl = S.resultFile = S.img = null;
  S.tracks = [];
  S.frames = [];
  S.raw = [];
  S.manual = [];
  S.sel = null;
  S.t = 0;
  $('fatal').hidden = true;
}

function goHome() {
  resetAll();
  video.removeAttribute('src');
  video.load();
  $('file').value = '';
  show('home');
}

$('scanCancel').onclick = goHome;
$('exportCancel').onclick = cancelJob;
$('restart1').onclick = goHome;
$('restart2').onclick = goHome;

$('file').addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  if (f) loadFile(f);
});

// Accès aux données pour les tests en local uniquement.
if (location.hostname === 'localhost') window.skred = { S, frameIndex, retrack: (o) => { Object.assign(TRACK, o); buildTracks(S.raw); } };

$('version').textContent = 'version ' + VERSION;

init();
