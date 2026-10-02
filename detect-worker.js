// Recherche des visages dans un fil d'exécution à part, pour utiliser plusieurs cœurs du téléphone.
// Tout reste dans le navigateur : ce fichier ne fait aucune requête en dehors du site.
import { createDetector } from './detector.js';

let detect = null;

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      detect = await createDetector(new URL('.', self.location.href).href);
      // Un essai à blanc : si la détection ne marche pas ici, on le sait tout de suite.
      await detect(new OffscreenCanvas(64, 64), 64, 64, 64, 0.5);
      self.postMessage({ type: 'ready' });
    } else if (m.type === 'detect') {
      const boxes = await detect(m.bitmap, m.w, m.h, m.maxSide, m.minScore);
      m.bitmap.close();
      self.postMessage({ type: 'done', id: m.id, boxes });
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: m.id, message: String((err && err.message) || err) });
  }
};
