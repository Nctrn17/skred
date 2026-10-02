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

export async function createDetector(base) {
  ort.env.wasm.wasmPaths = base + 'vendor/ort/';
  ort.env.wasm.numThreads = 1;
  const session = await ort.InferenceSession.create(base + 'models/yunet.onnx', { executionProviders: ['wasm'] });

  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(32, 32) : document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let buffer = new Float32Array(0);

  // source : image de sw x sh pixels. Renvoie les visages [{x, y, w, h, s}] en pixels de la source.
  return async function detect(source, sw, sh, maxSide, minScore) {
    const scale = Math.min(1, maxSide / Math.max(sw, sh));
    const dw = Math.max(1, Math.round(sw * scale)), dh = Math.max(1, Math.round(sh * scale));
    // Le modèle veut des dimensions multiples de 32 : on complète avec du noir.
    const pw = Math.ceil(dw / 32) * 32, ph = Math.ceil(dh / 32) * 32;
    if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, pw, ph);
    ctx.drawImage(source, 0, 0, dw, dh);
    const rgba = ctx.getImageData(0, 0, pw, ph).data;
    const n = pw * ph;
    if (buffer.length !== 3 * n) buffer = new Float32Array(3 * n);
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
