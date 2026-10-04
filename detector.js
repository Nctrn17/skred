// Détection des visages avec YuNet (modèle libre d'OpenCV), exécuté dans le navigateur par ONNX Runtime.
// Tous les fichiers sont servis par le site lui-même : aucune requête vers l'extérieur.
import * as ort from './vendor/ort/ort.wasm.min.mjs';

const STRIDES = [8, 16, 32];
const NMS_IOU = 0.3;

function overlap(a, b) {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  return inter / (a.w * a.h + b.w * b.h - inter);
}

// Certitude exigée d'un cadre selon sa taille (r : réglages venus d'app.js, short : petit côté de l'image).
export function neededScore(d, short, r) {
  return r.min + (r.big - r.min) * Math.min(1, Math.max(0, (d.w / short - r.from) / (r.to - r.from)));
}

// Seconde passe sur l'image réduite au tiers. Un gros plan y redevient un visage de taille ordinaire, que le modèle
// reconnaît bien ; un faux visage vu dans le bruit de la nuit, lui, y disparaît le plus souvent.
// Les cadres trouvés là sont marqués { lo: true } : app.js s'en sert pour confirmer ou écarter les grands cadres.
// Elle coûte cher : on ne la fait que si `always` est vrai, ou si l'image entière contient un grand cadre
// qu'elle seule peut confirmer (assez sûr pour compter, pas assez pour se passer de confirmation).
export const LOW_FACTOR = 3;
export async function detectBoth(detect, source, sw, sh, maxSide, minScore, always, r) {
  const boxes = await detect(source, sw, sh, maxSide, minScore);
  const short = Math.min(sw, sh);
  if (!always && !boxes.some((d) => d.s >= r.min && d.s < neededScore(d, short, r))) return boxes;
  const low = await detect(source, sw, sh, Math.round(Math.min(maxSide, Math.max(sw, sh)) / LOW_FACTOR), minScore);
  return boxes.concat(low.map((b) => ({ ...b, lo: true })));
}

export async function createDetector(base) {
  ort.env.wasm.wasmPaths = base + 'vendor/ort/';
  ort.env.wasm.numThreads = 1;
  const session = await ort.InferenceSession.create(base + 'models/yunet.onnx', { executionProviders: ['wasm'] });

  // Une toile et un tampon par taille d'image : les deux passes alternent deux tailles, et tout recréer à chaque image
  // (plusieurs dizaines de Mo) coûtait presque autant que la détection elle-même.
  const sizes = new Map();
  const space = (pw, ph) => {
    const key = pw + 'x' + ph;
    let sp = sizes.get(key);
    if (!sp) {
      const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(pw, ph) : Object.assign(document.createElement('canvas'), { width: pw, height: ph });
      sp = { ctx: canvas.getContext('2d', { willReadFrequently: true }), buffer: new Float32Array(3 * pw * ph) };
      sizes.set(key, sp);
    }
    return sp;
  };

  // source : image de sw x sh pixels. Renvoie les visages [{x, y, w, h, s}] en pixels de la source.
  return async function detect(source, sw, sh, maxSide, minScore) {
    const scale = Math.min(1, maxSide / Math.max(sw, sh));
    const dw = Math.max(1, Math.round(sw * scale)), dh = Math.max(1, Math.round(sh * scale));
    // Le modèle veut des dimensions multiples de 32 : on complète avec du noir.
    const pw = Math.ceil(dw / 32) * 32, ph = Math.ceil(dh / 32) * 32;
    const { ctx, buffer } = space(pw, ph);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, pw, ph);
    ctx.drawImage(source, 0, 0, dw, dh);
    const rgba = ctx.getImageData(0, 0, pw, ph).data;
    const n = pw * ph;
    for (let i = 0, p = 0; i < n; i++, p += 4) {   // ordre bleu, vert, rouge, comme à l'entraînement du modèle
      buffer[i] = rgba[p + 2];
      buffer[n + i] = rgba[p + 1];
      buffer[2 * n + i] = rgba[p];
    }
    const out = await session.run({ input: new ort.Tensor('float32', buffer, [1, 3, ph, pw]) });

    const found = [];
    for (const st of STRIDES) {
      const cols = pw / st;
      const cls = out['cls_' + st].data, obj = out['obj_' + st].data, box = out['bbox_' + st].data;
      for (let i = 0; i < cls.length; i++) {
        const s = Math.sqrt(Math.min(1, Math.max(0, cls[i])) * Math.min(1, Math.max(0, obj[i])));
        if (s < minScore) continue;
        const w = Math.exp(box[i * 4 + 2]) * st, h = Math.exp(box[i * 4 + 3]) * st;
        const cx = ((i % cols) + box[i * 4]) * st, cy = (Math.floor(i / cols) + box[i * 4 + 1]) * st;
        found.push({ x: (cx - w / 2) / scale, y: (cy - h / 2) / scale, w: w / scale, h: h / scale, s });
      }
    }
    // Un même visage sort plusieurs fois : on garde le cadre le plus sûr.
    found.sort((a, b) => b.s - a.s);
    const kept = [];
    for (const b of found) if (!kept.some((k) => overlap(k, b) > NMS_IOU)) kept.push(b);
    return kept;
  };
}
