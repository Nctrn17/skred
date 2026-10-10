// skred : masque les visages d'une vidéo ou d'une photo, entièrement dans le navigateur.
// Aucune requête réseau après le chargement de la page (voir aussi la politique de sécurité dans _headers).
import { createDetector, detectBoth, neededScore } from './detector.js';

// Ouvert en http (certains navigateurs, comme Opera sur iPhone, ne passent pas tout seuls en https) : le navigateur
// coupe alors la copie hors ligne, l'export rapide et d'autres fonctions. On repart aussitôt sur l'adresse en https.
// www.skred.fr : même chose vers skred.fr, pour n'avoir qu'un seul site (une seule copie hors ligne, une seule app).
if ((location.protocol === 'http:' && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) || location.hostname === 'www.skred.fr') {
  location.replace('https://' + location.host.replace(/^www\./, '') + location.pathname + location.search + location.hash);
}

const $ = (id) => document.getElementById(id);

const MIN_SCORE = 0.3;        // seuil de détection bas : on préfère trop masquer que pas assez
// Les petits visages (moins de 12 % du petit côté) sont presque tous les ratés. Un petit carré posé à tort gêne peu :
// pour eux, le seuil descend à 0,2 (visages ratés de jour -26 %, de nuit -34 %, mesuré par entrainement/eval-faces.py).
const SMALL_SCORE = 0.2;
// La nuit, le détecteur croit voir de grands visages peu sûrs dans le ciel, sur le trottoir ou dans une silhouette floue.
// Un grand cadre (plus de 12 % du petit côté de l'image) doit donc être soit très sûr (jusqu'à 0,85 à partir de 25 %),
// soit retrouvé sur l'image réduite au tiers (voir detectBoth). Et un gros plan bien reconnu sur l'image réduite
// (0,7 au moins) est masqué même s'il a été raté sur l'image entière. Réglages mesurés sur 9 226 photos où chaque
// visage a été repéré à la main (WIDER FACE et, de nuit, DARK FACE) : voir entrainement/eval-faces.py.
const BIG_FROM = 0.12, BIG_TO = 0.25, BIG_SCORE = 0.85, LOW_SCORE = 0.7;
// Score minimal d'un cadre retrouvé sur l'image réduite (seconde passe) pour être retenu.
const JUDGE = { confirm: MIN_SCORE };
const RULE = { min: MIN_SCORE, small: SMALL_SCORE, big: BIG_SCORE, from: BIG_FROM, to: BIG_TO };
// La passe sur l'image réduite double presque le temps d'analyse. Pour rattraper les gros plans ratés, elle n'est faite
// qu'une image sur 3 : un masque déborde déjà de 4 images avant et après chaque visage, il reste donc posé sans trou.
// Elle est faite en plus sur toute image où un grand cadre attend sa confirmation (voir detectBoth).
const LOW_EVERY = 3;
const GROW = 1.3;             // chaque case est agrandie de 30 % autour du visage
const ANALYSIS_FPS = 30;      // images regardées par seconde de vidéo
const HOLD_FRAMES = 4;        // chaque masque commence 4 images avant et finit 4 images après le visage
const KEEP_SCORE = 0.15;      // un visage déjà suivi reste suivi même quand il devient très incertain
// Réglages du suivi d'un visage d'une image à l'autre.
const TRACK = {
  gap: 20,          // un visage perdu moins de 20 images reste masqué pendant le trou
  match: 1.6,       // distance maximale entre deux images, en largeurs de visage
  lowMatch: 0.6,    // même chose pour une détection très incertaine
  // Taille maximale d'une détection incertaine qui prolonge un masque, en fois la dernière taille sûre. Mesuré sur
  // 36 vidéos réelles (entrainement/eval-reel.mjs) : surface masquée sans visage 20 % -> 16 % ; les 2 visages de plus laissés
  // visibles sur 1 012 n'étaient couverts que par hasard, par un pavé posé à côté.
  lowGrow: 1.5,
  hold: HOLD_FRAMES,  // images de masque ajoutées avant et après un visage
  unionMax: 4,      // une case couvrant 3 positions successives est gardée si elle ne dépasse pas 4 fois la plus grande
  minReach: 0.02,   // distance minimale tolérée (part du petit côté de l'image), pour les très petits visages
};
const DET_SIDE_DEEP = 1920;   // taille de l'image analysée (plus grand côté)
const DET_SIDE = 1280;        // avec l'option « aller plus vite »
const MAX_SIDE = 1920;        // plus grand côté de la vidéo produite
const MAX_SIDE_PHOTO = 4096;

const VERSION = '2026-10-08.1';   // affichée en bas de page, pour savoir quelle version tourne sur un téléphone
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
  // Horloge : partout dans l'app, t va de 0 à duration. Le fichier, lui, peut avoir une horloge qui ne démarre pas
  // à 0 (vidéo recoupée, montée, transférée) : start est l'heure du fichier qui correspond à t = 0, et first
  // l'instant t de sa première image. Sans ces deux valeurs, les masques tomberaient à côté des visages.
  start: 0, first: 0,
  tracks: [],       // un suivi par visage : { id, dets: Map(image -> cadre), off: retraits faits à la main (isOff) }
  frames: [],       // pour chaque image, les cases à dessiner : [{ x, y, w, h, track }] en pixels
  manual: [],       // masques ajoutés à la main : [{ id, cx, cy, size, t0, t1 }]
  sel: null,        // masque sélectionné : { manual } ou { track }
  nextId: 1,
  t: 0,
  style: 'noir',
  emoji: '😶',
  audioMode: 'original',
  job: null,        // tâche en cours (analyse ou création), annulable
  playing: false,
  file: null,       // fichier d'origine, relu directement par l'export rapide
  fast: false,      // export rapide possible (WebCodecs) : sinon, enregistrement à vitesse normale
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
const needed = (d) => neededScore(d, Math.min(S.W, S.H), RULE);
const isSure = (d) => d.sure;
function iou(a, b) {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return ix * iy / (a.w * a.h + b.w * b.h - ix * iy);
}
// Décide quels cadres d'une image sont assez sûrs pour ouvrir un masque, avec l'aide de la seconde passe.
function judge(boxes) {
  const full = boxes.filter((b) => !b.lo), low = boxes.filter((b) => b.lo);
  for (const d of full) {
    d.sure = d.s >= needed(d) || (d.s >= JUDGE.confirm && low.some((l) => iou(d, l) > 0.3));
    d.weak = d.sure && d.s < MIN_SCORE;   // petit visage admis grâce au seuil plus bas : à confirmer (buildTracks)
  }
  const extra = low.filter((l) => l.s >= LOW_SCORE && l.w / Math.min(S.W, S.H) >= BIG_FROM && !full.some((d) => d.sure && iou(d, l) > 0.3));
  for (const l of extra) l.sure = true;
  return full.concat(extra);
}

/* ---------- Écrans ---------- */

function show(step) {
  for (const s of ['home', 'scan', 'review', 'export', 'done']) $('s-' + s).hidden = s !== step;
  const host = { scan: $('scanFrame'), review: $('stage'), export: $('exportFrame') }[step];
  if (host && view.parentNode !== host) host.prepend(view);
  window.scrollTo(0, 0);
}

function fail(el, msg) {
  el.textContent = msg;
  el.hidden = false;
}

/* ---------- App Android ---------- */

// Dans l'app Android (dossier android/), la page tourne dans une WebView sans accès à internet.
// L'app y place l'objet skredAndroid : la page lui confie ce que le navigateur faisait seul
// (enregistrer dans la galerie, partager, garder l'écran allumé, recevoir un fichier partagé).
const ANDROID = window.skredAndroid || null;
let androidCaps = { ab: false };
const androidWaiting = [];
if (ANDROID) {
  ANDROID.onmessage = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    const i = androidWaiting.findIndex((w) => w.types.includes(m.t));
    if (i >= 0) androidWaiting.splice(i, 1)[0].resolve(m);
  };
}
function androidAsk(msg, types) {
  return new Promise((resolve) => {
    androidWaiting.push({ types, resolve });
    ANDROID.postMessage(JSON.stringify(msg));
  });
}
async function androidHello() {
  androidCaps = await androidAsk({ t: 'hello' }, ['hello']);
}
// Remet un fichier à l'app, par morceaux de 1 Mo. Réponse : 'saved', 'shared' ou 'error'.
// Un transfert à la fois : l'app n'a qu'un fichier de réception, et l'enregistrement démarre tout seul
// à la fin de l'export, pendant qu'on peut déjà toucher « Partager ».
let androidQueue = Promise.resolve();
function androidSend(file, action) {
  const run = androidQueue.then(() => androidSendNow(file, action));
  androidQueue = run.catch(() => {});
  return run;
}
async function androidSendNow(file, action) {
  ANDROID.postMessage(JSON.stringify({ t: 'begin', name: file.name, type: file.type, action }));
  const CHUNK = 1 << 20;
  for (let o = 0; o < file.size; o += CHUNK) {
    const buf = await file.slice(o, o + CHUNK).arrayBuffer();
    if (androidCaps.ab) ANDROID.postMessage(buf);
    else {
      const bytes = new Uint8Array(buf);
      let s = '';
      for (let i = 0; i < bytes.length; i += 32768) s += String.fromCharCode(...bytes.subarray(i, i + 32768));
      ANDROID.postMessage(JSON.stringify({ t: 'chunk64', d: btoa(s) }));
    }
  }
  return (await androidAsk({ t: 'end' }, ['saved', 'shared', 'error'])).t;
}

async function keepAwake(on) {
  if (ANDROID) { ANDROID.postMessage(JSON.stringify({ t: 'awake', on })); return; }
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
    let nextId = 1, broken = null;
    const giveUp = setTimeout(() => { w.terminate(); resolve(null); }, 20000);
    // Fil tombé en panne une fois lancé : les analyses en attente échouent tout de suite (l'analyse s'arrête
    // avec un message) au lieu de rester suspendues, et celles qui suivent aussi.
    // Le fil est retiré de la liste ; si c'était le dernier, la recherche reprend dans la page pour le fichier suivant.
    const breakDown = (why) => {
      if (!broken) {
        broken = new Error(why);
        const i = S.runners.indexOf(runner);
        if (i >= 0 && S.runners.length > 1) S.runners.splice(i, 1);
        else if (i >= 0) localRunner().then((r) => { const j = S.runners.indexOf(runner); if (j >= 0) S.runners[j] = r; }, () => {});
      }
      w.terminate();
      for (const p of pending.values()) { clearTimeout(p.timer); p.ko(broken); }
      pending.clear();
    };
    // Une page restée en arrière-plan est gelée par le téléphone, fil compris : à son retour, le délai serait
    // déjà dépassé. On ne compte donc que le temps passé à l'écran.
    let shownAt = performance.now();
    document.addEventListener('visibilitychange', () => { if (!document.hidden) shownAt = performance.now(); });
    const watch = (id) => setTimeout(() => {
      const p = pending.get(id);
      if (!p) return;
      if (document.hidden || performance.now() - shownAt < 60000) p.timer = watch(id);
      else breakDown('fil muet');
    }, 60000);
    const runner = {
      stop: () => w.terminate(),
      detect: (bitmap, maxSide, always) => new Promise((ok, ko) => {
        if (broken) { bitmap.close(); ko(broken); return; }
        const id = nextId++;
        // Un fil tué sans prévenir (mémoire du téléphone saturée) ne répond plus jamais.
        pending.set(id, { ok, ko, timer: watch(id) });
        w.postMessage({ type: 'detect', id, bitmap, w: bitmap.width, h: bitmap.height, maxSide, minScore: KEEP_SCORE, always, rule: RULE }, [bitmap]);
      }),
    };
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'ready') { clearTimeout(giveUp); resolve(runner); return; }
      const p = pending.get(m.id);
      if (m.type === 'error' && !p) { if (window.diag) window.diag('worker erreur : ' + m.message); clearTimeout(giveUp); resolve(null); breakDown('fil en panne'); return; }
      if (!p) return;
      pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.type === 'done') p.ok(m.boxes); else p.ko(new Error(m.message));
    };
    w.onerror = (e) => { if (window.diag) window.diag(`worker onerror : ${e.message} ${e.filename}:${e.lineno}`); clearTimeout(giveUp); resolve(null); breakDown('fil en panne'); };
    w.postMessage({ type: 'init' });
  });
}

async function localRunner() {
  const detect = await createDetector(new URL('.', location.href).href);
  return {
    detect: async (bitmap, maxSide, always) => {
      const boxes = await detectBoth(detect, bitmap, bitmap.width, bitmap.height, maxSide, KEEP_SCORE, always, RULE);
      bitmap.close();
      return boxes;
    },
  };
}

// Export rapide : la bibliothèque Mediabunny (servie par le site) lit le fichier d'origine image par image
// et réécrit un MP4 avec l'encodeur du téléphone (WebCodecs), sans attendre que la vidéo défile.
// Elle est chargée dès le départ, pour qu'aucune requête ne parte une fois le fichier choisi.
let MB = null;
async function loadFastExport() {
  if (new URLSearchParams(location.search).has('lent')) return;
  if (!('VideoEncoder' in window) || !('VideoDecoder' in window)) return;
  try {
    MB = await import('./vendor/mediabunny/mediabunny.min.mjs');
    // Pas MB.canEncode : il ouvre l'encodeur vidéo du téléphone pour essayer et ne le referme pas. Tant que le
    // téléphone ne l'a pas libéré, la première vidéo choisie peut être refusée. Ici, on demande sans rien ouvrir.
    S.fast = (await VideoEncoder.isConfigSupported({ codec: 'avc1.42001f', width: 1280, height: 720, bitrate: 4e6 })).supported === true;
  } catch (e) {
    console.error(e);
  }
}

// Copie du site sur le téléphone (sw.js), pour marcher sans réseau. On attend qu'elle soit finie avant
// d'autoriser le choix d'un fichier : ainsi, plus aucune requête ne part une fois le fichier choisi.
async function keepOffline() {
  if (!('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('sw.js');
    await Promise.race([navigator.serviceWorker.ready, sleep(15000)]);
  } catch (e) {
    console.error(e);
  }
}

// Fichier partagé depuis la galerie (Android, application installée) : sw.js l'a reçu et nous le remet.
// Dans l'app Android, c'est l'app qui l'a reçu : elle le sert à l'adresse /__partage/.
async function sharedFile() {
  if (ANDROID) {
    if (!androidCaps.shared) return null;
    try {
      const blob = await (await fetch('/__partage/fichier')).blob();
      return new File([blob], androidCaps.shared, { type: androidCaps.sharedType || blob.type });
    } catch {
      return null;
    } finally {
      ANDROID.postMessage(JSON.stringify({ t: 'partageLu' }));
    }
  }
  if (!new URLSearchParams(location.search).has('partage')) return null;
  history.replaceState(null, '', location.pathname);
  const sw = navigator.serviceWorker && navigator.serviceWorker.controller;
  if (!sw) return null;
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = (e) => resolve(e.data instanceof File ? e.data : null);
    sw.postMessage({ type: 'partage' }, [ch.port2]);
    setTimeout(() => resolve(null), 3000);
  });
}

async function init() {
  try {
    const cores = navigator.hardwareConcurrency || 2;
    // Sur iPhone, Safari donne peu de mémoire à une page : chaque moteur de détection en réserve une part,
    // au-delà de deux le démarrage échoue (« Out of memory »), surtout sur les modèles anciens.
    const ua = navigator.userAgent;
    const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    const wanted = clamp(cores - 1, 1, ios ? 2 : 3);
    const noWorkers = new URLSearchParams(location.search).has('simple');
    // Détecteur, export rapide et copie hors ligne se préparent en même temps ; le choix d'un fichier n'est permis
    // qu'une fois les trois prêts, pour qu'aucune requête ne parte ensuite.
    const [workers] = await Promise.all([
      noWorkers ? [] : Promise.all(Array.from({ length: wanted }, startWorker)).then((w) => w.filter(Boolean)),
      loadFastExport(),
      ANDROID ? androidHello() : keepOffline(),
    ]);
    S.runners = workers.length ? workers : [await localRunner()];
    // Safari garde la page quittée en mémoire, moteurs compris : un rechargement doublerait la mémoire prise.
    // On arrête les moteurs en quittant la page ; si Safari la ressort de sa mémoire, on la recharge.
    addEventListener('pagehide', () => { for (const r of S.runners) if (r.stop) r.stop(); });
    addEventListener('pageshow', (e) => { if (e.persisted) location.reload(); });
    S.parallel = workers.length;
    $('file').disabled = false;
    $('pickLabel').removeAttribute('aria-disabled');
    $('pickText').innerHTML = matchMedia('(pointer: fine)').matches ? 'Glisse une vidéo ou une photo,<br>ou clique pour choisir' : 'Choisir une vidéo<br>ou une photo';
    $('footNote').textContent = matchMedia('(pointer: fine)').matches ? 'Rien ne quitte ton ordinateur.' : 'Rien ne quitte ton téléphone.';
    let file = await sharedFile();
    // Essai sur un téléphone de test (adresse avec ?essai) : la vidéo de test du site, sans passer par le sélecteur.
    if (!file && new URLSearchParams(location.search).has('essai')) {
      try { file = new File([await (await fetch('t.mov', { cache: 'no-store' })).blob()], 'essai.mov', { type: 'video/quicktime' }); } catch { file = null; }
    }
    if (file) loadFile(file);
  } catch (e) {
    console.error(e);
    if (window.diag) window.diag('init échoue : ' + (e && e.message) + ' | ' + String(e && e.stack).slice(0, 300));
    $('pickText').textContent = 'Outil indisponible';
    fail($('homeError'), 'L\'outil n\'a pas pu se charger sur ce navigateur. Essaie avec Chrome ou Safari à jour.');
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
// Renvoie false si le navigateur n'a pas confirmé le déplacement dans le délai : l'image affichée
// est alors peut-être encore l'ancienne, et ne doit servir ni à l'analyse ni à l'export.
function seekTo(t, ms = 3000) {
  return new Promise((resolve) => {
    let seeked = false, framed = false, finished = false;
    const fin = (ok) => { if (!finished) { finished = true; video.removeEventListener('seeked', onSeeked); resolve(ok); } };
    const onSeeked = () => {
      seeked = true;
      if (framed) fin(true); else setTimeout(() => fin(true), 15);
    };
    video.addEventListener('seeked', onSeeked);
    if (hasRVFC) video.requestVideoFrameCallback(() => { framed = true; if (seeked) fin(true); });
    setTimeout(() => fin(false), ms);
    video.currentTime = t + S.start;
  });
}
// Pour l'analyse et l'export : un déplacement lent a droit à un second essai, puis on abandonne.
const seekSure = async (t) => (await seekTo(t, 10000)) || seekTo(t, 10000);

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
  if (window.diag) window.diag('loadFile ' + file.type + ' ' + file.size);
  resetAll();
  $('homeError').hidden = true;
  S.kind = file.type.startsWith('image/') || /\.(jpe?g|png|webp|heic|heif)$/i.test(file.name) ? 'photo' : 'video';
  S.file = file;
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
      await once(video, 'loadedmetadata', 'error', 20000);
      S.start = Number.isFinite(video.currentTime) ? video.currentTime : 0;
      // Sur iPhone, Safari lit l'en-tête puis s'arrête : il ne décode aucune image tant qu'on ne lui demande pas
      // un instant précis ou la lecture. On lui demande le tout début ; s'il ne répond pas, une lecture éclair.
      if (video.readyState < 2) {
        const frame = once(video, 'loadeddata', 'error', 20000);
        video.currentTime = S.start + 0.001;
        const late = setTimeout(() => {
          if (video.readyState < 2) video.play().then(() => { video.pause(); video.currentTime = S.start; }).catch(() => {});
        }, 3000);
        await frame.finally(() => clearTimeout(late));
      }
      if (!Number.isFinite(video.duration)) {
        // Certains fichiers n'annoncent pas leur durée : on force le navigateur à la chercher.
        video.currentTime = 1e7;
        await once(video, 'durationchange', null, 5000).catch(() => {});
      }
      if (!Number.isFinite(video.duration) || video.duration <= 0) throw new Error('illisible');
      w = video.videoWidth;
      h = video.videoHeight;
      S.duration = video.duration;
      if (window.diag) window.diag(`lu ${w}x${h} ${S.duration}s fast=${S.fast}`);
      // L'export rapide lit le fichier lui-même : si sa fin tombe plus tard que ce qu'annonce le navigateur,
      // on analyse jusque-là. Analyser un peu trop loin ne coûte rien, pas assez laisserait des images sans masque.
      if (S.fast) {
        try {
          const input = new MB.Input({ source: new MB.BlobSource(file), formats: MB.ALL_FORMATS });
          const track = await input.getPrimaryVideoTrack();
          if (track) {
            S.duration = Math.max(S.duration, (await track.computeDuration()) - S.start);
            S.first = Math.max(0, (await track.getFirstTimestamp()) - S.start);
          }
          input.dispose();
        } catch { /* le navigateur seul fera foi */ }
      }
    }
    if (!w || !h) throw new Error('illisible');
  } catch (e) {
    if (window.diag) window.diag('échec lecture : ' + (e && e.message));
    fail($('homeError'), 'Ton navigateur n\'arrive pas à lire ce fichier. Essaie avec un autre, ou enregistre-le dans un autre format.');
    return;
  }

  const k = Math.min(1, (isPhoto() ? MAX_SIDE_PHOTO : MAX_SIDE) / Math.max(w, h));
  S.W = Math.round(w * k / 2) * 2;
  S.H = Math.round(h * k / 2) * 2;
  for (const c of [view, work, preview]) { c.width = S.W; c.height = S.H; }

  if (window.diag) window.diag('analyse');
  show('scan');
  $('scanBar').style.height = '0';
  $('scanText').textContent = '0%';
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
  S.found = [];

  // Les images sont distribuées aux fils d'exécution libres, au fur et à mesure.
  const free = [...S.runners], waiting = [];
  const acquire = () => (free.length ? Promise.resolve(free.pop()) : new Promise((r) => waiting.push(r)));
  const tasks = [];
  let done = 0, error = null, onRelease = null, sent = 0;
  const release = (r) => { if (waiting.length) waiting.shift()(r); else free.push(r); if (onRelease) onRelease(); };

  const progress = () => {
    const pct = Math.floor(done / total * 100);
    $('scanBar').style.height = pct + '%';
    $('scanText').textContent = pct + '%';
  };
  // Aperçu : une image avec ses visages masqués, de temps en temps.
  let shown = null;
  const keepForPreview = (canvas) => { if (!shown) { pctx.drawImage(canvas, 0, 0); shown = canvas; } };
  const showPreview = (canvas, boxes) => {
    if (canvas !== shown) return;
    vctx.drawImage(preview, 0, 0);
    vctx.fillStyle = '#000';
    for (const b of boxes.filter(isSure).map(grow)) vctx.fillRect(b.x, b.y, b.w, b.h);
    shown = null;
  };
  // Analyse une image (déjà dessinée sur `canvas`) et range le résultat pour les images i à j.
  const submit = async (canvas, i, j) => {
    // Copie immédiate : en lecture continue, la toile repasse dans la réserve et peut recevoir une image plus récente
    // pendant qu'on attend un fil libre. Le résultat aurait alors été rangé à l'instant de l'ancienne image.
    const shot = createImageBitmap(canvas);
    const runner = await acquire();
    if (job.cancelled || error) { release(runner); (await shot).close(); return; }
    const bitmap = await shot;
    const t0 = performance.now();
    const always = isPhoto() || sent++ % LOW_EVERY === 0;   // compté par image envoyée, pas par numéro d'image
    tasks.push(runner.detect(bitmap, side, always).then((found) => {
      if (DEBUG) S.found.push({ found: found.map((b) => ({ ...b })), i, j });   // pour window.skred.rejudge
      const boxes = judge(found);
      for (const b of boxes) b.at = i;   // première image servie par cette analyse
      S.detectMs += performance.now() - t0;
      S.detectCount++;
      for (let k = i; k <= j; k++) if (!results[k]) { results[k] = boxes; done++; }
      showPreview(canvas, boxes);
      progress();
    }, (e) => { error = e; }).finally(() => release(runner)));
  };

  if (!isPhoto()) await scanByPlayback(job, total, submit, keepForPreview, () => error);
  if (window.diag) window.diag(`lecture en continu finie : ${((performance.now() - started) / 1000).toFixed(1)} s, ${results.filter(Boolean).length + tasks.length}/${total} images envoyées`);
  // Le reste (tout, si la lecture en continu n'est pas possible) : image par image, en se positionnant sur chacune.
  for (let i = 0; i < total && !job.cancelled && !error; i++) {
    if (results[i]) continue;
    if (!isPhoto()) {
      if (!await seekSure(frameTime(i))) { error = new Error('déplacement impossible à ' + frameTime(i).toFixed(2) + ' s'); break; }
      S.seekFallbacks++;
    }
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
    fail($('homeError'), 'L\'analyse a échoué sur ce navigateur. Essaie avec Chrome ou Safari à jour.');
    return;
  }
  S.scanMs = performance.now() - started;
  if (window.diag) window.diag(`analyse finie : ${total} images, ${(S.scanMs / 1000).toFixed(1)} s, ${S.seekFallbacks} reprises une par une, ${S.runners.length} fils, ${Math.round(S.detectMs / Math.max(1, S.detectCount))} ms par détection`);
  S.raw = results;
  buildTracks(results);
  openReview(0);
}

// Lecture en continu : chaque image présentée par le navigateur est copiée au vol et envoyée à l'analyse.
// Le navigateur numérote les images présentées : si une a été sautée, on le sait, et elle sera
// reprise ensuite image par image. La lecture est mise en pause quand l'analyse ne suit pas.
async function scanByPlayback(job, total, submit, keepForPreview, failed) {
  if (!hasRVFC || document.hidden) return;
  const n = S.runners.length;
  // Trois toiles suffisent : celle de l'image en attente (prev), celle qu'on dessine, et une de marge. L'envoi
  // à l'analyse en fait une copie tout de suite (submit), la toile est donc libre dès l'image suivante.
  const ring = Array.from({ length: 3 }, () => {
    const c = document.createElement('canvas');
    c.width = S.W;
    c.height = S.H;
    return c;
  });
  const frameDur = 1 / clamp(S.srcFps, 10, 120);
  const firstSlot = (t) => Math.ceil(t * S.fps - 0.5);
  let ringPos = 0, inFlight = 0, prev = null, lastPresented = -1, lastTime = -1, lastSeen = performance.now();
  let paused = false, ended = false, stop = false;
  // Vitesse de lecture : normale au départ, ralentie dès qu'une image est sautée, relevée tant que tout passe.
  let rate = 1, sinceSkip = 0;
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
    const t = meta.mediaTime - S.start;
    if (t > lastTime) {
      // Image sautée : le navigateur le dit (presentedFrames), ou pas (images abandonnées avant d'être présentées,
      // fréquent au démarrage de la lecture) : on le voit alors à l'écart entre deux instants.
      const skipped = lastPresented >= 0 && (meta.presentedFrames - lastPresented > 1 || (prev && t - prev.t > frameDur * 1.5));
      flush(skipped ? Math.min(t, (prev ? prev.t : t) + frameDur * 1.2) : t);
      // La vitesse de lecture suit le rythme de l'analyse : on ralentit quand la file s'allonge,
      // on accélère quand elle est vide. La pause n'est qu'un dernier recours.
      if (skipped) { setRate(rate * 0.75); sinceSkip = 0; }
      else if (++sinceSkip >= 10) { sinceSkip = 0; if (inFlight > n) setRate(rate * 0.85); else if (inFlight <= 1) setRate(rate * 1.1); }
      const canvas = ring[ringPos++ % ring.length];
      drawSource(canvas.getContext('2d'));
      keepForPreview(canvas);
      prev = { canvas, t };
      lastTime = t;
      lastPresented = meta.presentedFrames;
      if (inFlight >= 2 * n + 1 && !paused) { paused = true; video.pause(); }
    }
    video.requestVideoFrameCallback(onFrame);
  };
  const resume = () => {
    if (paused && !ended && !stop && !document.hidden && inFlight <= n) { paused = false; video.play().catch(() => {}); }
  };
  const onEnded = () => { ended = true; };
  const onVisibility = () => { if (document.hidden) { paused = true; video.pause(); } else resume(); };

  if (!await seekSure(0)) return;   // tout sera repris image par image, avec la même vérification
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

// Plus une marge fixe : sur un tout petit visage (une vingtaine de pixels), le cadre du détecteur tremble de quelques
// pixels et l'encodage de la vidéo produite floute le bord du carré noir. 2 pixels de chaque côté ne suffisaient pas
// (test5, vidéo de nuit : bord du petit visage visible) ; 4 à 720 pixels de petit côté, 6 à 1080.
function grow(b) {
  const edge = Math.max(4, Math.min(S.W, S.H) / 90);
  const w = b.w * GROW + edge, h = b.h * GROW + edge;
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
        const sure = isSure(d);
        // Une détection incertaine ne prolonge un masque qu'à une taille proche de celle où le visage a été vu nettement :
        // sinon, de proche en proche, un petit visage pouvait finir en pavé noir couvrant la moitié de l'image.
        if (!sure && d.w > TRACK.lowGrow * t.sureW) continue;
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
      if (isSure(d)) { t.sureIdx = i; t.sureW = d.w; }
    };
    for (const p of pairs) if (!usedT.has(p.t) && !usedD.has(p.d)) assign(p.d, p.t);
    for (const d of dets) {
      if (usedD.has(d) || !isSure(d)) continue;   // trop incertain pour ouvrir un nouveau masque
      // Un petit visage peu sûr n'ouvre un masque que s'il était déjà là à l'analyse d'avant : vu une seule fois,
      // c'est presque toujours du bruit, qui ferait clignoter des carrés (mesuré : près de la moitié des cas).
      // Une même analyse sert à plusieurs images d'affilée (i à j) : la précédente est celle de l'image d'avant i.
      // Photo : pas d'avant.
      if (d.weak && N > 1) {
        const k = (d.at ?? i) - 1;
        if (!(results[k] || []).some((p) => p.s >= SMALL_SCORE && iou(p, d) > 0.3)) continue;
      }
      const t = { id: tracks.length + 1, dets: new Map(), off: [] };
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
    const a = Math.max(0, first - TRACK.hold), b = Math.min(N - 1, last + TRACK.hold);
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
      if (box.w * box.h <= TRACK.unionMax * biggest) frames[j].push({ ...grow(box), track: t });
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

// Retraits d'un masque automatique : liste de { from, off, at }, le dernier dont « from » est atteint décide.
// Le premier retrait vaut pour tout le visage suivi ; ensuite, retirer ou remettre ne vaut qu'à partir de l'image
// où l'on est (le suivi peut passer d'une personne à une autre). Refaire le geste sur la même image l'annule.
const isOff = (tr, j) => { let off = false; for (const e of tr.off) if (e.from <= j) off = e.off; return off; };
const isRemoved = (tr) => tr.off.some((e) => e.off);
function toggleTrack(tr, j) {
  const last = tr.off[tr.off.length - 1];
  if (last && last.at === j) { tr.off.pop(); return; }
  const off = !isOff(tr, j);
  tr.off = tr.off.length ? [...tr.off.filter((e) => e.from < j), { from: j, off, at: j }] : [{ from: 0, off, at: j }];
}

const manualAt = (t) => S.manual.filter((m) => t >= m.t0 - 1e-3 && t <= m.t1 + 1e-3);
const inside = (r, x, y) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

function paint(ctx, t, edit) {
  const j = frameIndex(t);
  const auto = S.frames[j] || [];
  const rects = [...auto.filter((b) => !isOff(b.track, j)), ...manualAt(t).map(manualRect)];

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
    if (isOff(b.track, j)) frame(b, '#ff6b5e', selected);
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
  drawTimeline();
  refreshPanels();   // le bouton × / ↺ dépend de l'image affichée
}

function openReview(t) {
  show('review');
  const time = $('time');
  time.max = S.duration;
  time.step = 1 / S.fps;
  for (const el of document.querySelectorAll('.videoOnly')) el.hidden = isPhoto();
  $('hint').textContent = (matchMedia('(pointer: fine)').matches ? 'Clique sur' : 'Touche') + ' un visage pour le masquer ou le démasquer.';
  $('stats').hidden = !DEBUG || isPhoto();
  if (DEBUG && !isPhoto()) {
    const n = S.frames.length;
    $('stats').textContent = `${S.W}x${S.H}, ${n} images, ${Math.round(S.scanMs / 1000)} s (${Math.round(S.scanMs / n)} ms/image), `
      + `détection ${Math.round(S.detectMs / Math.max(1, S.detectCount))} ms/image sur ${S.parallel || 'page'} fils, `
      + `${S.seekFallbacks} reprises, source ${S.srcFps.toFixed(1)} i/s, ${navigator.hardwareConcurrency || '?'} cœurs, ${navigator.deviceMemory || '?'} Go`;
  }
  sizeTimeline();
  refreshPanels();
  goTo(t);
}

// Zone réellement occupée par l'image dans le canevas affiché (l'image est centrée, sans déformation).
function drawnRect() {
  const r = view.getBoundingClientRect();
  const k = Math.min(r.width / S.W, r.height / S.H);
  const w = S.W * k, h = S.H * k;
  return { left: r.left + (r.width - w) / 2, top: r.top + (r.height - h) / 2, w, h, k };
}

// La frise sous l'image : un trait par visage suivi, sur la durée où il est masqué, et le curseur.
function sizeTimeline() {
  const c = $('tracks');
  const r = c.getBoundingClientRect();
  if (!r.width) return;
  const dpr = window.devicePixelRatio || 1;
  c.width = Math.round(r.width * dpr);
  c.height = Math.round(r.height * dpr);
}

function drawTimeline() {
  if (isPhoto()) return;
  const c = $('tracks');
  const ctx = c.getContext('2d');
  const W = c.width, H = c.height;
  if (!W) return;
  ctx.clearRect(0, 0, W, H);
  const N = Math.max(1, S.frames.length);
  const rows = 3, rowH = Math.max(2, Math.floor(H / 6));
  ctx.fillStyle = '#efede6';
  S.tracks.forEach((t, i) => {
    const idx = [...t.dets.keys()];
    const a = Math.max(0, idx[0] - TRACK.hold), b = Math.min(N - 1, idx[idx.length - 1] + TRACK.hold);
    const y = Math.round(H * (0.2 + 0.25 * (i % rows)));
    // Un trait par passage masqué : les images où le masque a été retiré restent vides.
    for (let s = a; s <= b; s++) {
      if (isOff(t, s)) continue;
      let e = s;
      while (e < b && !isOff(t, e + 1)) e++;
      ctx.fillRect(Math.floor(s / N * W), y, Math.max(2, Math.ceil((e - s + 1) / N * W)), rowH);
      s = e;
    }
  });
  ctx.fillStyle = '#e4ff3a';
  for (const m of S.manual) ctx.fillRect(Math.floor(m.t0 / S.duration * W), Math.round(H * 0.85), Math.max(2, Math.ceil((m.t1 - m.t0) / S.duration * W)), rowH);
  const x = Math.round(S.t / Math.max(0.001, S.duration) * (W - 3));
  ctx.fillRect(x, 0, 3, H);
}

function stopPlay() {
  if (!S.playing) return;
  S.playing = false;
  video.pause();
  $('play').textContent = '▶';
}

async function togglePlay() {
  if (S.playing) { stopPlay(); S.t = video.currentTime - S.start; renderReview(); return; }
  S.playing = true;
  $('play').textContent = '❚❚';
  video.muted = true;
  if (S.t >= S.duration - 0.05) await seekTo(0);
  try { await video.play(); } catch { stopPlay(); return; }
  const tick = () => {
    if (!S.playing) return;
    S.t = Math.min(video.currentTime - S.start, S.duration);
    renderReview();
    if (video.ended) { stopPlay(); return; }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// La barre jaune sous le masque sélectionné : taille et durée pour un masque ajouté, retrait pour un automatique.
function refreshPanels() {
  const m = S.sel && S.sel.manual;
  const tr = S.sel && S.sel.track;
  $('maskBar').hidden = !m && !tr;
  $('mMinus').hidden = !m;
  $('mPlus').hidden = !m;
  $('mAll').hidden = !m || isPhoto();
  $('mAll').classList.toggle('on', !!m && m.t0 <= 0 && m.t1 >= S.duration);
  const j = frameIndex(S.t);
  const off = tr && isOff(tr, j);
  const last = tr && tr.off[tr.off.length - 1];
  const fromHere = tr && tr.off.length && last.at !== j && !isPhoto() ? ' à partir d\'ici' : '';
  $('mDelete').textContent = off ? '↺' : '×';
  $('mDelete').title = tr ? (off ? 'Remettre ce masque' : 'Retirer ce masque') + fromHere : 'Retirer';
  const removed = S.tracks.filter(isRemoved).length;
  $('restoreAll').hidden = !removed;
  $('restoreAll').textContent = removed > 1 ? `Remettre les ${removed} masques retirés` : 'Remettre le masque retiré';
  placeMaskBar();
}

function selectedRect() {
  if (S.sel && S.sel.manual) return manualAt(S.t).includes(S.sel.manual) ? manualRect(S.sel.manual) : null;
  if (S.sel && S.sel.track) return (S.frames[frameIndex(S.t)] || []).find((b) => b.track === S.sel.track) || null;
  return null;
}

function placeMaskBar() {
  const bar = $('maskBar');
  if (bar.hidden) return;
  const r = selectedRect();
  if (!r) { bar.hidden = true; return; }
  const d = drawnRect();
  const stage = $('stage').getBoundingClientRect();
  const bw = bar.offsetWidth || 176, bh = 44;
  let x = d.left + (r.x + r.w / 2) * d.k - bw / 2 - stage.left;
  let y = d.top + (r.y + r.h) * d.k + 8 - stage.top;
  if (y + bh > stage.height - 8) y = d.top + r.y * d.k - bh - 8 - stage.top;
  x = clamp(x, 8, stage.width - bw - 8);
  y = clamp(y, 8, stage.height - bh - 8);
  bar.style.left = x + 'px';
  bar.style.top = y + 'px';
}

function canvasPoint(e) {
  const d = drawnRect();
  return { x: (e.clientX - d.left) / d.w, y: (e.clientY - d.top) / d.h };
}

let drag = null;
const selectedManual = () => S.sel && S.sel.manual;
const deselect = () => { S.sel = null; refreshPanels(); renderReview(); };

view.addEventListener('pointerdown', (e) => {
  if ($('s-review').hidden) return;
  e.preventDefault();
  stopPlay();
  const p = canvasPoint(e);
  if (p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) { deselect(); return; }
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


$('mMinus').onclick = () => { const m = selectedManual(); if (!m) return; m.size = clamp(m.size / 1.25, 0.04, 0.9); renderReview(); };
$('mPlus').onclick = () => { const m = selectedManual(); if (!m) return; m.size = clamp(m.size * 1.25, 0.04, 0.9); renderReview(); };
$('mAll').onclick = () => {
  const m = selectedManual();
  if (!m) return;
  const whole = m.t0 <= 0 && m.t1 >= S.duration;
  if (whole) { m.t0 = Math.max(0, S.t - 1); m.t1 = Math.min(S.duration, S.t + 1); } else { m.t0 = 0; m.t1 = S.duration; }
  refreshPanels();
  renderReview();
};
$('mDelete').onclick = () => {
  if (S.sel && S.sel.track) { toggleTrack(S.sel.track, frameIndex(S.t)); refreshPanels(); renderReview(); return; }
  S.manual = S.manual.filter((x) => x !== selectedManual());
  deselect();
};
$('restoreAll').onclick = () => {
  for (const t of S.tracks) t.off = [];
  refreshPanels();
  renderReview();
};

$('time').addEventListener('input', (e) => { stopPlay(); goTo(+e.target.value); });
$('prev').onclick = () => { stopPlay(); goTo(S.t - 1 / S.fps); };
$('next').onclick = () => { stopPlay(); goTo(S.t + 1 / S.fps); };
$('play').onclick = togglePlay;

// Le bouton carré fait défiler les styles de masque.
const STYLES = [['noir', ''], ['emoji', '😶'], ['emoji', '💀'], ['emoji', '🐸']];
$('styleBtn').onclick = () => {
  const i = STYLES.findIndex(([st, em]) => st === S.style && (st === 'noir' || em === S.emoji));
  const [st, em] = STYLES[(i + 1) % STYLES.length];
  S.style = st;
  if (em) S.emoji = em;
  $('styleBtn').innerHTML = st === 'noir' ? '<span class="sq"></span>' : em;
  renderReview();
};
$('audioBtn').onclick = () => {
  S.audioMode = S.audioMode === 'original' ? 'scramble' : S.audioMode === 'scramble' ? 'mute' : 'original';
  const labels = {
    original: ['SON', 'Son gardé. La voix aussi permet de reconnaître quelqu\'un.'],
    scramble: ['BROUILLÉ', 'Son brouillé sur toute la piste. Touche pour couper. Cela ne garantit pas l\'anonymat.'],
    mute: ['MUET', 'Son coupé. Touche pour rétablir le son d\'origine.'],
  };
  const [label, note] = labels[S.audioMode];
  $('audioBtn').textContent = label;
  $('audioBtn').title = note;
  $('audioBtn').setAttribute('aria-label', note);
  $('audioBtn').classList.toggle('on', S.audioMode !== 'mute');
  $('audioNote').textContent = note;
};
document.addEventListener('keydown', (e) => {
  if ($('s-review').hidden || isPhoto() || e.target.tagName === 'INPUT') return;
  if (e.key === 'ArrowLeft') { e.preventDefault(); stopPlay(); goTo(S.t - 1 / S.fps); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); stopPlay(); goTo(S.t + 1 / S.fps); }
  else if (e.key === ' ') { e.preventDefault(); togglePlay(); }
});
window.addEventListener('resize', () => { if (!$('s-review').hidden) { sizeTimeline(); renderReview(); } });

/* ---------- Création du fichier masqué ---------- */

// Diagnostic : quelles variantes du fichier produit Safari accepte de lire dans la page.
function diagPreview(raw, scrubbed) {
  const tries = { brut: raw, nettoye: scrubbed, sansType: new Blob([scrubbed]), brutSansType: new Blob([raw]) };
  for (const [k, b] of Object.entries(tries)) {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    v.style.cssText = 'position:fixed;left:0;bottom:0;width:2px;height:2px;opacity:0';
    v.onloadedmetadata = () => window.diag(`essai ${k} : lu ${v.videoWidth}x${v.videoHeight}`);
    v.onerror = () => window.diag(`essai ${k} : erreur ${v.error && v.error.code}`);
    document.body.append(v);
    v.src = URL.createObjectURL(b);
  }
}

async function finish(blob, name, info) {
  if (S.resultUrl) URL.revokeObjectURL(S.resultUrl);
  if (S.previewUrl) URL.revokeObjectURL(S.previewUrl);
  // Fichier d'un seul tenant, et une adresse pour l'aperçu distincte de celle du téléchargement :
  // sur iPhone, Safari n'affichait pas l'aperçu une fois le téléchargement lancé.
  blob = new Blob([await blob.arrayBuffer()], { type: blob.type });
  S.resultUrl = URL.createObjectURL(blob);
  S.previewUrl = URL.createObjectURL(blob);
  S.resultFile = new File([blob], name, { type: blob.type });
  $('result').hidden = isPhoto();
  $('resultImg').hidden = !isPhoto();
  // Safari sur iPhone refuse parfois de lire dans la page la vidéo qu'il vient de produire (erreur 4), alors que
  // le fichier enregistré se lit très bien. Plutôt qu'un lecteur cassé, on dit où la regarder.
  $('result').onerror = () => {
    if (isPhoto() || !S.previewUrl) return;
    $('result').hidden = true;
    $('doneCheck').textContent = 'L\'aperçu ne s\'affiche pas ici. Ouvre la vidéo enregistrée et regarde-la en entier avant de poster.';
  };
  (isPhoto() ? $('resultImg') : $('result')).src = S.previewUrl;
  $('download').href = S.resultUrl;
  $('download').download = name;
  $('share').hidden = !ANDROID && !(navigator.canShare && navigator.canShare({ files: [S.resultFile] }));
  $('doneTitle').textContent = isPhoto() ? 'Prête.' : 'Prête.';
  $('doneCheck').textContent = isPhoto() ? 'Regarde-la de près avant de poster.' : 'Regarde-la en entier avant de poster.';
  $('doneInfo').textContent = `${info}, ${(blob.size / 1e6).toFixed(1).replace('.', ',')} Mo.`;
  show('done');
  // Le téléchargement part tout seul. Le bouton reste là si le navigateur l'a bloqué, ou pour recommencer.
  $('download').click();
}

async function exportPhoto() {
  S.sel = null;
  $('fatal').hidden = true;
  drawSource(vctx);
  paint(vctx, 0, false);
  const blob = await new Promise((r) => view.toBlob(r, 'image/jpeg', 0.92));
  if (!blob) { fail($('fatal'), 'Ce navigateur n\'a pas pu créer la photo.'); return; }
  finish(blob, 'photo-masquee.jpg', 'Fichier JPEG');
}

// Le navigateur écrit dans un fichier MP4 la date et l'heure de sa création. On les remet à zéro :
// le fichier produit ne dit plus quand il a été fait. On efface aussi le nom du logiciel qui l'a écrit.
async function scrubMp4Dates(blob) {
  const head = new Uint8Array(await blob.slice(0, 1 << 20).arrayBuffer());
  const view = new DataView(head.buffer);
  const type = (p) => String.fromCharCode(head[p + 4], head[p + 5], head[p + 6], head[p + 7]);
  const walk = (start, end) => {
    for (let p = start; p + 8 <= end;) {
      const size = view.getUint32(p);
      if (size < 8 || p + size > end) return;   // boîte coupée ou de forme inattendue : on n'y touche pas
      const t = type(p);
      if (t === 'moov' || t === 'trak' || t === 'mdia' || t === 'minf' || t === 'stbl') walk(p + 8, p + size);
      else if (t === 'mvhd' || t === 'tkhd' || t === 'mdhd') head.fill(0, p + 12, p + 12 + (head[p + 8] === 1 ? 16 : 8));
      else if (t === 'hdlr') head.fill(0, p + 32, p + size);   // nom donné à la piste par le logiciel
      else if (t === 'stsd' && size >= 16 + 82 && /^(avc|hvc|hev|vp0|av0)/.test(type(p + 16))) head.fill(0, p + 16 + 50, p + 16 + 82);   // nom de l'encodeur
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

async function connectScrambledAudio(destination) {
  const ctx = S.audioCtx;
  const source = S.audioNode;

  await ctx.audioWorklet.addModule('/audio/pitch-shifter.js');

  const vocoder = new AudioWorkletNode(ctx, 'pitch-shifter', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });

  vocoder.parameters.get('semitones').value = -4;

  const highpass = ctx.createBiquadFilter();
  highpass.type = 'highpass';
  highpass.frequency.value = 100;

  const lowpass = ctx.createBiquadFilter();
  lowpass.type = 'lowpass';
  lowpass.frequency.value = 7000;

  const output = ctx.createGain();
  output.gain.value = 1.0;

  source.connect(highpass);
  highpass.connect(vocoder);
  vocoder.connect(lowpass);
  lowpass.connect(output);
  output.connect(destination);

  return () => {
    for (const node of [
      source,
      highpass,
      vocoder,
      lowpass,
      output
    ]) {
      try {
        node.disconnect();
      } catch {}
    }
  };
}

// Export rapide. Renvoie false s'il n'a pas pu aller au bout : l'export suivant se fera par enregistrement.
async function exportFast() {
  const job = { cancelled: false };
  S.job = job;
  $('fatal').hidden = true;
  show('export');
  $('exportBar').style.width = '0';
  $('exportPct').textContent = '0%';
  $('exportText').textContent = '';
  await keepAwake(true);

  let made = null, audioKept = false, input = null;
  try {
    input = new MB.Input({ source: new MB.BlobSource(S.file), formats: MB.ALL_FORMATS });
    const output = new MB.Output({ format: new MB.Mp4OutputFormat({ fastStart: 'in-memory' }), target: new MB.BufferTarget() });
    const canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(S.W, S.H) : Object.assign(document.createElement('canvas'), { width: S.W, height: S.H });
    const ctx = canvas.getContext('2d');
    let first = null;
    const conversion = await MB.Conversion.init({
      input,
      output,
      video: {
        // L'image est toujours refaite, redressée et masquée : celle d'origine n'est jamais recopiée telle quelle.
        forceTranscode: true,
        allowTransformationMetadata: false,
        width: S.W,
        height: S.H,
        fit: 'fill',
        codec: 'avc',
        bitrate: clamp(S.W * S.H * 4, 2_500_000, 10_000_000),
        process: (sample) => {
          // La bibliothèque compte le temps depuis sa première image ; on le remet sur l'horloge de l'analyse.
          if (first == null) first = sample.timestamp;
          sample.draw(ctx, 0, 0, S.W, S.H);
          paint(ctx, sample.timestamp - first + S.first, false);
          return canvas;
        },
        processedWidth: S.W,
        processedHeight: S.H,
      },
      audio: { discard: S.audioMode === 'mute' },
      tags: {},   // rien du fichier d'origine (lieu, date, modèle du téléphone) n'est repris
      showWarnings: false,
    });
    const kept = conversion.utilizedTracks;
    if (!conversion.isValid || kept.filter((t) => t.type === 'video').length !== 1) throw new Error('vidéo non prise en charge');
    audioKept = kept.some((t) => t.type === 'audio');
    conversion.onProgress = (p) => {
      const pct = Math.floor(clamp(p * 100, 0, 100));
      $('exportBar').style.width = pct + '%';
      $('exportPct').textContent = pct + '%';
    };
    job.cancel = () => conversion.cancel();
    await conversion.execute();
    made = new Blob([output.target.buffer], { type: 'video/mp4' });
  } catch (e) {
    if (!job.cancelled) console.error(e);
  }
  if (input) try { input.dispose(); } catch { /* déjà libéré */ }
  S.job = null;
  await keepAwake(false);

  if (job.cancelled) { openReview(0); return true; }
  if (!made || !made.size) return false;
  const sound = audioKept ? 'avec le son' : S.audioMode !== 'mute' ? 'sans le son (il n\'a pas pu être repris)' : 'sans le son';
  if (window.diag) diagPreview(made, await scrubMp4Dates(made));
  finish(await scrubMp4Dates(made), 'video-masquee.mp4', `Fichier MP4, ${sound}, export rapide`);
  return true;
}

async function exportVideo() {
  stopPlay();
  S.sel = null;
  if (S.fast && S.audioMode !== 'scramble') {
    if (await exportFast()) return;
    // L'enregistrement doit démarrer juste après un appui sur le bouton (pour le son sur iPhone) : on redemande.
    S.fast = false;
    openReview(0);
    fail($('fatal'), 'L\'export rapide n\'a pas marché ici. Touche Exporter à nouveau : la vidéo sera créée à vitesse normale.');
    return;
  }
  const mime = pickMime();
  if (!mime || !view.captureStream) {
    fail($('fatal'), 'Ce navigateur ne sait pas créer de vidéo. Essaie avec Chrome ou Safari à jour.');
    return;
  }
  $('fatal').hidden = true;

  // À faire tout de suite, pendant que le navigateur sait encore que l'utilisateur vient de toucher le bouton
  // (sinon l'iPhone refuse de lire la vidéo avec le son).
  const audioMode = S.audioMode;
  const keepAudio = audioMode !== 'mute';
  let audioDest = null, audioFailed = false, audioResume = null, audioCleanup = null;
  if (keepAudio) {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      S.audioCtx = S.audioCtx || new AC();
      audioResume = S.audioCtx.resume();
      S.audioNode = S.audioNode || S.audioCtx.createMediaElementSource(video);
      audioDest = S.audioCtx.createMediaStreamDestination();
      if (audioMode === 'scramble') audioCleanup = await connectScrambledAudio(audioDest);
      else S.audioNode.connect(audioDest);
    } catch (e) {
      console.error(e);
      audioFailed = true;
    }
  }
  video.muted = !keepAudio || (audioFailed && audioMode === 'scramble');
  video.volume = 1;
  const unlock = video.play();
  if (unlock) await unlock.then(() => video.pause(), () => {});

  if (audioResume) {
    try {
      await audioResume;
    } catch (e) {
      console.error(e);
      audioFailed = true;
    }
  }
  if (audioFailed && audioMode === 'scramble') {
    if (audioCleanup) audioCleanup();
    video.muted = false;
    fail($('fatal'), 'Le brouillage audio n\'a pas pu être activé. Essaie avec Chrome ou Safari à jour ; aucun fichier n\'a été créé.');
    return;
  }

  const job = { cancelled: false };
  S.job = job;
  show('export');
  $('exportBar').style.width = '0';
  $('exportPct').textContent = '0%';
  $('exportText').textContent = audioFailed ? 'Le son n\'a pas pu être repris : la vidéo sera muette.' : audioMode === 'scramble' ? 'Brouillage actif sur toute la piste audio. Export à vitesse réelle.' : '';
  await keepAwake(true);

  const draw = (t) => {
    vctx.drawImage(video, 0, 0, S.W, S.H);
    paint(vctx, t, false);
  };

  const sought = await seekSure(0);
  if (job.cancelled || !sought) {
    // Sans confirmation, l'image affichée n'est peut-être pas la première : ses masques ne lui iraient pas.
    if (audioDest) S.audioNode.disconnect(audioDest);
    video.muted = true;
    S.job = null;
    await keepAwake(false);
    openReview(0);
    if (!job.cancelled) fail($('fatal'), 'La création de la vidéo a échoué sur ce navigateur. Essaie avec Chrome ou Safari à jour.');
    return;
  }
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
    const pct = Math.floor(clamp(t / S.duration * 100, 0, 100));
    $('exportBar').style.width = pct + '%';
    $('exportPct').textContent = pct + '%';
  };
  const loop = hasRVFC
    ? (_, meta) => { frame(meta.mediaTime - S.start); if (running) video.requestVideoFrameCallback(loop); }
    : () => { frame(video.currentTime - S.start); if (running) requestAnimationFrame(loop); };
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
  if (audioCleanup) audioCleanup();
  else if (audioDest) S.audioNode.disconnect(audioDest);
  video.muted = false;
  S.job = null;
  await keepAwake(false);

  if (job.cancelled) { openReview(0); return; }
  if (failed || !chunks.length) {
    openReview(0);
    fail($('fatal'), 'La création de la vidéo a échoué sur ce navigateur. Essaie avec Chrome ou Safari à jour.');
    return;
  }

  const type = (rec.mimeType || mime).split(';')[0];
  const mp4 = type.includes('mp4');
  const made = new Blob(chunks, { type });
  finish(mp4 ? await scrubMp4Dates(made) : made, 'video-masquee.' + (mp4 ? 'mp4' : 'webm'), `Fichier ${mp4 ? 'MP4' : 'WebM'}${audioMode === 'scramble' ? ', son brouillé' : audioDest ? ', avec le son' : ', sans le son'}`);
}

$('export').onclick = () => (isPhoto() ? exportPhoto() : exportVideo());
$('share').onclick = async () => {
  if (ANDROID) { await androidSend(S.resultFile, 'share'); return; }
  try { await navigator.share({ files: [S.resultFile] }); } catch { /* partage annulé */ }
};
// Dans l'app Android, « Télécharger » devient « Enregistrer » : le fichier va dans la galerie.
if (ANDROID) {
  $('download').innerHTML = 'Enregistrer<span>↓</span>';
  $('share').textContent = 'Partager';
  $('download').addEventListener('click', async (e) => {
    e.preventDefault();
    const where = isPhoto() ? 'Images/skred' : 'Films/skred';
    const r = await androidSend(S.resultFile, 'save');
    $('doneInfo').textContent = $('doneInfo').textContent.replace(/ (Enregistrée|Pas enregistrée).*$/, '')
      + (r === 'saved' ? ` Enregistrée dans ${where}.` : ' Pas enregistrée : réessaie avec le bouton.');
  });
}
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
  if (S.previewUrl) URL.revokeObjectURL(S.previewUrl);
  S.srcUrl = S.resultUrl = S.previewUrl = S.resultFile = S.img = S.file = null;
  S.tracks = [];
  S.frames = [];
  S.raw = [];
  S.manual = [];
  S.sel = null;
  S.t = 0;
  S.start = S.first = 0;
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
$('restart2').onclick = goHome;

for (const ev of ['dragenter', 'dragover']) $('pickLabel').addEventListener(ev, (e) => { e.preventDefault(); $('pickLabel').classList.add('over'); });
for (const ev of ['dragleave', 'drop']) $('pickLabel').addEventListener(ev, (e) => { e.preventDefault(); $('pickLabel').classList.remove('over'); });
$('pickLabel').addEventListener('drop', (e) => {
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (f && !$('file').disabled) loadFile(f);
});
// Diagnostic à l'écran (adresse avec ?diag) : pour voir ce qui se passe sur un téléphone sans outils de développeur.
// Le journal survit à un rechargement de la page.
if (/[?&](diag|essai)\b/.test(location.search)) {
  const box = document.createElement('pre');
  box.style.cssText = 'position:fixed;left:0;right:0;top:0;max-height:30vh;pointer-events:none;overflow:auto;margin:0;padding:6px;font:10px/1.3 monospace;background:#000c;color:#0f0;z-index:99;white-space:pre-wrap';
  document.body.append(box);
  const t0 = performance.now();
  const log = (m) => {
    let all = '';
    try { all = (sessionStorage.getItem('diag') || '') + `${((performance.now() - t0) / 1000).toFixed(1)} ${m}\n`; sessionStorage.setItem('diag', all); } catch { all += m + '\n'; }
    box.textContent = all;
    box.scrollTop = 1e9;
  };
  window.diag = log;
  log(`--- chargement, sw=${!!(navigator.serviceWorker && navigator.serviceWorker.controller)} nav=${performance.getEntriesByType('navigation')[0]?.type}`);
  for (const ev of ['pagehide', 'pageshow', 'visibilitychange', 'focus', 'blur']) window.addEventListener(ev, () => log(ev + ' ' + document.visibilityState));
  $('file').addEventListener('click', () => log('clic sélecteur'));
  $('file').addEventListener('cancel', () => log('sélecteur annulé'));
  $('file').addEventListener('input', () => log('input ' + $('file').files.length));
  $('file').addEventListener('change', () => { const f = $('file').files[0]; log(`change ${f ? `${f.name} ${f.type} ${f.size}` : 'vide'}`); });
  for (const ev of ['loadstart', 'loadedmetadata', 'loadeddata', 'error', 'stalled', 'suspend', 'abort', 'emptied']) video.addEventListener(ev, () => log('video ' + ev + (ev === 'error' && video.error ? ' ' + video.error.code + ' ' + video.error.message : '')));
  window.addEventListener('error', (e) => log('ERREUR ' + e.message));
  for (const ev of ['loadeddata', 'error']) $('result').addEventListener(ev, () => log('aperçu ' + ev + (ev === 'error' && $('result').error ? ' ' + $('result').error.code + ' ' + $('result').error.message : '')));
  window.addEventListener('unhandledrejection', (e) => log('REJET ' + (e.reason && e.reason.message)));
  if (navigator.serviceWorker) navigator.serviceWorker.addEventListener('controllerchange', () => log('controllerchange'));
}

$('file').addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  if (f) loadFile(f);
});

// iPhone : la photothèque ne transmet pas toujours la vidéo choisie (restée dans iCloud, ou qu'elle n'arrive pas à
// préparer) et se ferme sans rien rendre. « Choisir le fichier » passe : si rien n'arrive, on le dit.
if (/iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1)) {
  let waiting = null;
  const nothingCame = () => {
    if (waiting) return;
    waiting = setTimeout(() => {
      waiting = null;
      if (!S.file && !$('s-home').hidden) fail($('homeError'), 'Aucune vidéo reçue : la photothèque de l\'iPhone n\'en transmet pas toujours. Enregistre la vidéo dans Fichiers (Partager, puis « Enregistrer dans Fichiers »), puis touche le carré et « Choisir le fichier ».');
    }, 4000);
  };
  $('file').addEventListener('cancel', nothingCame);
  $('file').addEventListener('click', () => addEventListener('focus', nothingCame, { once: true }));
  $('file').addEventListener('change', () => { clearTimeout(waiting); waiting = null; });
}

/* ---------- Installer l'app ---------- */

// Le site s'installe déjà comme une app (manifest.webmanifest, sw.js) : ce bouton le fait savoir.
// Android : la fenêtre d'installation du navigateur. iPhone : Apple ne permet pas de bouton, on montre les gestes.
// Rien n'apparaît si l'app est déjà ouverte depuis l'écran d'accueil, ni sur ordinateur.
{
  const installed = !!ANDROID || matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const touch = matchMedia('(pointer: coarse)').matches;
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  let prompt = null;
  const button = $('install'), sheet = $('iosSheet');
  const closeSheet = () => { sheet.hidden = true; button.focus(); };

  if (!installed && touch && ios) {
    button.hidden = false;
    if (/Instagram|FBAN|FBAV|TikTok|musical_ly|Snapchat|LinkedInApp|Twitter/.test(ua)) $('iosInApp').hidden = false;
    else if (/CriOS|FxiOS|EdgiOS/.test(ua)) $('iosShare').textContent = 'Touche le bouton Partager, dans la barre d\'adresse';
  }
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    if (installed || !touch) return;
    prompt = e;
    button.hidden = false;
  });
  window.addEventListener('appinstalled', () => { button.hidden = true; prompt = null; });
  button.onclick = async () => {
    if (ios) {
      sheet.hidden = false;
      $('iosClose').focus();
    } else if (prompt) {
      const p = prompt;
      prompt = null;
      button.hidden = true;   // refusée ou acceptée, la fenêtre ne peut servir qu'une fois
      await p.prompt();
    }
  };
  $('iosClose').onclick = closeSheet;
  sheet.addEventListener('click', (e) => { if (e.target === sheet) closeSheet(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !sheet.hidden) closeSheet(); });
}

// Accès aux données pour les tests : en local, ou avec ?debug (version de test de l'app Android).
if (DEBUG) window.skred = {
  S, frameIndex,
  retrack: (o) => { Object.assign(TRACK, o); buildTracks(S.raw); },
  // Refait le tri des détections gardées de l'analyse (S.found) avec d'autres réglages, puis le suivi.
  rejudge: (o, t = {}, r = {}) => {
    Object.assign(JUDGE, o);
    Object.assign(RULE, r);
    Object.assign(TRACK, t);
    const results = [];
    for (const { found, i, j } of S.found) {
      const boxes = judge(found.map((b) => ({ ...b })));
      for (const b of boxes) b.at = i;
      for (let k = i; k <= j; k++) if (!results[k]) results[k] = boxes;
    }
    for (let k = 0; k < results.length; k++) results[k] ||= [];
    S.raw = results;
    buildTracks(results);
  },
};

$('version').textContent = 'version ' + VERSION;

init();
