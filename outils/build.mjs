// Prépare le dossier dist/ publié sur Cloudflare : seulement les fichiers du site, rien d'autre
// (ni les tests, ni l'entraînement, ni les outils). La liste vient de sw.js, qui garde déjà ces fichiers hors ligne.
// Usage : node outils/build.mjs
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, 'dist');
const sw = readFileSync(join(root, 'sw.js'), 'utf8');
const listed = [...sw.match(/const FILES = \[([\s\S]*?)\];/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).filter((f) => f !== './');
const files = [
  'index.html', 'mentions.html', 'verifier.html', '404.html', 'sw.js', '_headers', 'favicon.ico', 'icon.svg', ...listed,
  'models/LICENSE-yunet.txt', 'vendor/fonts/LICENSE.txt', 'vendor/ort/LICENSE.txt', 'vendor/mediabunny/LICENSE.txt',
  // « Masquer une personne » : chargés à la première utilisation seulement (trop lourds pour la copie hors ligne)
  ...['encoder', 'decoder_point', 'decoder_init', 'decoder_track', 'memory_encoder', 'memory_attention'].map((n) => `models/edgetam/${n}.onnx`),
  'models/edgetam/constants.json', 'models/edgetam/LICENSE.txt',
  'vendor/ort-webgpu/ort.webgpu.min.mjs', 'vendor/ort-webgpu/ort-wasm-simd-threaded.asyncify.mjs',
  'vendor/ort-webgpu/ort-wasm-simd-threaded.asyncify.wasm', 'vendor/ort-webgpu/LICENSE.txt',
];

rmSync(dist, { recursive: true, force: true });
for (const f of new Set(files)) {
  const from = join(root, f);
  if (!existsSync(from)) throw new Error('fichier manquant : ' + f);
  mkdirSync(dirname(join(dist, f)), { recursive: true });
  cpSync(from, join(dist, f));
}
console.log(`${new Set(files).size} fichiers copiés dans dist/`);
