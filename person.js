// « Masquer une personne » : on encadre quelqu'un sur une image, sa silhouette est suivie dans toute la vidéo et masquée.
// Modèle : EdgeTAM (Meta, licence Apache 2.0), la version de SAM 2 faite pour les téléphones, découpée en cinq modèles ONNX
// (models/edgetam/README.md). Calcul sur la carte graphique (WebGPU) quand le navigateur le permet, sinon sur le processeur,
// environ 5 fois plus lent. Tout est chargé à la première utilisation seulement, depuis le site lui-même : rien ne part ailleurs.

const SIDE = 1024;          // EdgeTAM regarde l'image redimensionnée en 1024 × 1024
const LOW = 256;            // ses silhouettes sortent en 256 × 256, sur la même image
const NUM_MASKMEM = 7;      // mémoire : l'image de départ et les 6 dernières images
const MAX_PTRS = 16;        // « pointeurs » de la personne : l'image de départ et les 15 dernières images
const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];
const GROW = 3;             // la silhouette est élargie de 3 pixels (sur 256) : environ 1 % de l'image de marge

let engine = null;
// Sur la carte graphique, les résultats de l'encodeur et de l'attention à la mémoire y restent (« gpu-buffer ») : ils
// repartent tels quels vers le module suivant, au lieu de faire l'aller-retour par la mémoire du navigateur (16 Mo par image).
const ON_GPU = { encoder: 'gpu-buffer', memory_attention: 'gpu-buffer' };

/** Charge ONNX Runtime et les modèles demandés (tous par défaut). `progress(p)` reçoit l'avancement entre 0 et 1. */
export async function loadEngine(base, progress, names = ['encoder', 'decoder_point', 'decoder_init', 'decoder_track', 'memory_encoder', 'memory_attention']) {
  if (!engine) {
    let ort = null, gpu = false;
    if ('gpu' in navigator) {
      try {
        gpu = !!(await navigator.gpu.requestAdapter());
        if (gpu) {
          ort = await import(base + 'vendor/ort-webgpu/ort.webgpu.min.mjs');
          ort.env.wasm.wasmPaths = base + 'vendor/ort-webgpu/';
        }
      } catch { gpu = false; }
    }
    if (!gpu) {
      ort = await import(base + 'vendor/ort/ort.wasm.min.mjs');
      ort.env.wasm.wasmPaths = base + 'vendor/ort/';
    }
    ort.env.wasm.numThreads = 1;
    const c = await (await fetch(base + 'models/edgetam/constants.json')).json();
    engine = { ort, s: {}, gpu, base, tpos: c.maskmem_tpos_enc.map((r) => Float32Array.from(r)) };
  }
  const { ort, s, gpu } = engine;
  const missing = names.filter((n) => !s[n]);
  for (const [i, n] of missing.entries()) {
    const opts = { executionProviders: [gpu ? 'webgpu' : 'wasm'] };
    if (gpu && ON_GPU[n]) opts.preferredOutputLocation = ON_GPU[n];
    s[n] = await ort.InferenceSession.create(engine.base + `models/edgetam/${n}.onnx`, opts);
    if (progress) progress((i + 1) / missing.length);
  }
  return engine;
}

/** Libère des modèles dont on n'a plus besoin pour l'instant (ils seront rechargés à la demande). */
export async function unload(names) {
  for (const n of names) if (engine && engine.s[n]) { await engine.s[n].release(); delete engine.s[n]; }
}

const work = document.createElement('canvas');
work.width = work.height = SIDE;
const wctx = work.getContext('2d', { willReadFrequently: true });

/** Libère des résultats du modèle dont on n'a plus besoin (sur iPhone, la mémoire de l'onglet est comptée). */
export function release(...outs) {
  for (const o of outs) if (o) for (const t of Object.values(o)) if (t && typeof t.dispose === 'function') t.dispose();
}

const input = new Float32Array(3 * SIDE * SIDE);   // un seul tampon d'entrée, réutilisé (12 Mo)

/** Fait passer une image (vidéo, photo) dans l'encodeur. L'image est étirée en 1024 × 1024, comme à l'entraînement. */
// Étape en cours (« encodeur », « attention »…), signalée avant chaque calcul : utile si Safari ferme l'onglet en plein calcul.
let stage = () => {};
export const onStage = (f) => { stage = f; };

export async function encode(src) {
  const { ort, s } = engine;
  wctx.drawImage(src, 0, 0, SIDE, SIDE);
  const px = wctx.getImageData(0, 0, SIDE, SIDE).data;
  const n = SIDE * SIDE, x = input;
  for (let i = 0; i < n; i++) {
    x[i] = (px[i * 4] / 255 - MEAN[0]) / STD[0];
    x[n + i] = (px[i * 4 + 1] / 255 - MEAN[1]) / STD[1];
    x[2 * n + i] = (px[i * 4 + 2] / 255 - MEAN[2]) / STD[2];
  }
  stage('encodeur');
  return s.encoder.run({ image: new ort.Tensor('float32', x, [1, 3, SIDE, SIDE]) });
}

const concat = (list, size) => {
  const out = new Float32Array(list.length * size);
  list.forEach((a, i) => out.set(a, i * size));
  return out;
};

/** Une personne suivie, image après image, dans un seul sens. `from` : un toucher [x, y] ou un rectangle [x0, y0, x1, y1],
 *  entre 0 et 1. */
export class Track {
  // `pick` : quelle découpe garder sur l'image de départ, parmi celles d'options() (0 = la plus grande) ;
  // `chosen` : cette découpe déjà calculée (par l'aperçu), réutilisée telle quelle sur l'image de départ.
  constructor(from, pick = 0, chosen = null) {
    this.tap = from.length === 2;
    this.pick = pick;
    this.chosen = chosen;
    this.points = Float32Array.from(from, (v) => v * SIDE);
    this.cond = null;      // image de départ : { mem, pos, ptr }
    this.past = new Map(); // images suivantes, par numéro : { mem, ptr }
    this.i = 0;
  }

  /** Découpes possibles sur l'image de départ, de la plus grande à la plus petite : { mask (logits 256 × 256), ptr, bits }.
   *  Un toucher en donne 3 (la personne, un morceau, une partie, son visage par exemple), un rectangle une seule. */
  async options(enc) {
    const { ort, s } = engine;
    const T = (data, dims, type = 'float32') => new ort.Tensor(type, data, dims);
    const n = LOW * LOW, list = [];
    if (this.tap) {
      const o = await s.decoder_point.run({ feat: enc.feat, hr0: enc.hr0, hr1: enc.hr1,
        points: T(this.points, [1, 1, 2]), labels: T(Int32Array.of(1), [1, 1], 'int32') });
      for (let k = 0; k < 3; k++) list.push({ mask: o.masks.data.slice(k * n, (k + 1) * n), ptr: o.ptrs.data.slice(k * 256, (k + 1) * 256) });
      release(o);
    } else {
      // un rectangle : ses deux coins (étiquettes 2 et 3)
      const o = await s.decoder_init.run({ feat: enc.feat, hr0: enc.hr0, hr1: enc.hr1,
        points: T(this.points, [1, 2, 2]), labels: T(Int32Array.of(2, 3), [1, 2], 'int32') });
      list.push({ mask: o.mask.data.slice(), ptr: o.ptr.data.slice() });
      release(o);
    }
    for (const c of list) { c.bits = toBits(c.mask); c.area = c.bits.reduce((a, v) => a + v, 0); }
    // découpes vides ou presque identiques à une plus grande : retirées (rien à proposer de différent)
    list.sort((a, b) => b.area - a.area);
    return list.filter((c, i) => c.area > 20 && list.slice(0, i).every((d) => c.area < d.area * 0.9));
  }

  /** Silhouette sur l'image encodée suivante : Uint8Array 256 × 256 (1 = personne). `enc` est libéré ensuite. */
  async step(enc) {
    const { ort, s, tpos } = engine;
    const T = (data, dims, type = 'float32') => new ort.Tensor(type, data, dims);
    let out;
    if (!this.cond) {
      let o = this.chosen;
      if (!o) {
        const opts = await this.options(enc);
        if (!opts.length) { release(enc); return new Uint8Array(LOW * LOW); }
        o = opts[Math.min(this.pick, opts.length - 1)];
      }
      out = { mask: T(o.mask, [1, 1, LOW, LOW]), ptr: { data: o.ptr } };
    } else {
      // l'image courante « regarde » la mémoire : départ d'abord, puis les images précédentes, la plus ancienne d'abord
      const mems = [this.cond.mem], poss = [this.withTime(NUM_MASKMEM - 1, tpos)];
      for (let tp = 1; tp < NUM_MASKMEM; tp++) {
        const p = this.past.get(this.i - (NUM_MASKMEM - tp));
        if (p) { mems.push(p.mem); poss.push(this.withTime(NUM_MASKMEM - tp - 1, tpos)); }
      }
      const ptrs = [this.cond.ptr];
      for (let d = 1; d < MAX_PTRS; d++) { const p = this.past.get(this.i - d); if (p) ptrs.push(p.ptr); }
      stage('attention');
      const att = await s.memory_attention.run({ feat: enc.feat,
        mem: T(concat(mems, 512 * 64), [mems.length, 512, 64]), mem_pos: T(concat(poss, 512 * 64), [poss.length, 512, 64]),
        ptr: T(concat(ptrs, 256), [ptrs.length * 4, 64]) });
      stage('décodeur');
      out = await s.decoder_track.run({ feat: att.pix, hr0: enc.hr0, hr1: enc.hr1,
        points: T(new Float32Array(2), [1, 1, 2]), labels: T(Int32Array.of(-1), [1, 1], 'int32') });
      release(att);
    }
    stage('mémoire');
    const m = await s.memory_encoder.run({ feat: enc.feat, mask: out.mask, first: T(Float32Array.of(this.cond ? 0 : 1), [1]) });
    const entry = { mem: m.mem.data.slice(), ptr: out.ptr.data.slice() };
    if (!this.cond) this.cond = { ...entry, pos: m.mem_pos.data.slice() };
    else { this.past.set(this.i, entry); this.past.delete(this.i - MAX_PTRS); }
    this.i++;
    const bits = toBits(out.mask.data);
    release(m, out, enc);
    return bits;
  }

  // Position des mémoires : celle de l'image de départ (comme le suivi de Meta), plus la position dans le temps.
  withTime(k, tpos) {
    const out = new Float32Array(this.cond.pos), t = tpos[k];
    for (let r = 0; r < 512; r++) for (let c = 0; c < 64; c++) out[r * 64 + c] += t[c];
    return out;
  }
}

const toBits = (logits) => {
  const bits = new Uint8Array(LOW * LOW);
  for (let k = 0; k < bits.length; k++) bits[k] = logits[k] > 0 ? 1 : 0;
  return bits;
};

/** Aperçu d'une découpe, avant le suivi : en jaune transparent, 256 × 256. */
export function preview(bits) {
  const c = document.createElement('canvas');
  c.width = c.height = LOW;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(LOW, LOW);
  for (let k = 0; k < bits.length; k++) if (bits[k]) img.data.set([233, 255, 69, 150], k * 4);
  ctx.putImageData(img, 0, 0);
  return c;
}

/** Silhouette prête à dessiner : élargie de GROW pixels, en noir sur fond transparent, 256 × 256. */
export function silhouette(bits) {
  const grown = new Uint8Array(bits.length);
  for (let y = 0; y < LOW; y++) for (let x = 0; x < LOW; x++) {
    if (!bits[y * LOW + x]) continue;
    for (let dy = -GROW; dy <= GROW; dy++) for (let dx = -GROW; dx <= GROW; dx++) {
      const yy = y + dy, xx = x + dx;
      if (yy >= 0 && yy < LOW && xx >= 0 && xx < LOW) grown[yy * LOW + xx] = 1;
    }
  }
  const c = document.createElement('canvas');
  c.width = c.height = LOW;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(LOW, LOW);
  for (let k = 0; k < grown.length; k++) if (grown[k]) img.data[k * 4 + 3] = 255;
  ctx.putImageData(img, 0, 0);
  return { bits: grown, canvas: c, box: bounds(grown) };
}

function bounds(bits) {
  let x0 = LOW, y0 = LOW, x1 = -1, y1 = -1;
  for (let y = 0; y < LOW; y++) for (let x = 0; x < LOW; x++) if (bits[y * LOW + x]) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return x1 < 0 ? null : { x: x0 / LOW, y: y0 / LOW, w: (x1 - x0 + 1) / LOW, h: (y1 - y0 + 1) / LOW };
}

/** La silhouette couvre-t-elle ce point (x, y entre 0 et 1) ? */
export const covers = (sil, x, y) => !!sil.bits[Math.min(LOW - 1, Math.floor(y * LOW)) * LOW + Math.min(LOW - 1, Math.floor(x * LOW))];
