// Vérifie les corrections image par image avec les vrais gestionnaires et le dessin utilisé à l'export.
// Sans navigateur ni vidéo de test : node test/test-edition.mjs.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const elements = new Map();
const ctx = {
  rects: [], clearRect() {}, strokeRect() {}, setLineDash() {},
  fillRect(...r) { this.rects.push(r); },
};
const element = (id) => {
  if (!elements.has(id)) elements.set(id, {
    hidden: false, width: 0, height: 0, offsetWidth: 176,
    style: {}, classList: { toggle() {} }, listeners: new Map(),
    addEventListener(ev, fn) { this.listeners.set(ev, fn); },
    getBoundingClientRect() { return { left: 0, top: 0, width: 1000, height: 1000 }; },
    getContext() { return ctx; },
    focus() {},
    setPointerCapture(id) { this.captured = id; },
    hasPointerCapture(id) { return this.captured === id; },
    releasePointerCapture() { this.captured = null; },
  });
  return elements.get(id);
};
const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const portion = (from, to) => {
  const start = source.indexOf(from), end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `Bloc introuvable : ${from}`);
  return source.slice(start, end);
};
const sandbox = vm.createContext({
  $, document: { querySelectorAll() { return []; } },
  window: { devicePixelRatio: 1 }, matchMedia() { return { matches: true }; },
  requestAnimationFrame() {}, drawSource() {}, show() {}, DEBUG: false,
  seekTo: async () => {},
});
function $(id) { return element(id); }
vm.runInContext(`
  const S = { kind: 'video', W: 1000, H: 1000, fps: 30, duration: 1, t: 0,
    frames: Array.from({ length: 30 }, () => []), tracks: [], manual: [], nextId: 1, style: 'noir', sel: null };
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const isPhoto = () => S.kind === 'photo';
  const view = $('view'), vctx = view.getContext('2d');
  const video = { pause() {} }, TRACK = { hold: 4 };
  ${portion('const frameTime =', 'async function loadFile')}
`, sandbox);

// Les deux helpers d'horloge sont lus seuls pour ne pas charger l'analyse ni le détecteur.
// Le bloc de vérification s'arrête avant les réglages de style et d'export.
vm.runInContext(portion('/* ---------- Dessin des masques ---------- */', '// Le bouton carré fait défiler les styles de masque.'), sandbox);
const run = (code) => vm.runInContext(code, sandbox);
const S = run('S');
const pointer = (ev, x, y, id = 1, target = 'view') => element(target).listeners.get(ev)({ clientX: x, clientY: y, pointerId: id, preventDefault() {}, stopPropagation() {} });
const resize = (h, dx, dy) => {
  const r = run('selectedRect()');
  const d = run('drawnRect()');
  const x = d.left + (r.x + r.w * (h.includes('w') ? 0 : h.includes('e') ? 1 : 0.5)) * d.k;
  const y = d.top + (r.y + r.h * (h.includes('n') ? 0 : h.includes('s') ? 1 : 0.5)) * d.k;
  pointer('pointerdown', x, y, 1, 'resize-' + h);
  pointer('pointermove', x + dx * d.k, y + dy * d.k, 1, 'resize-' + h);
  pointer('pointerup', x + dx * d.k, y + dy * d.k, 1, 'resize-' + h);
};
const growBoth = (delta) => { resize('nw', -delta, -delta); resize('se', delta, delta); };
const paint = (t) => { ctx.rects = []; run(`paint(vctx, ${t}, false)`); return ctx.rects; };
const next = async () => { element('next').onclick(); await Promise.resolve(); await Promise.resolve(); };
const prev = async () => { element('prev').onclick(); await Promise.resolve(); await Promise.resolve(); };

// Ajouter, déplacer et agrandir un masque sur la première image ne touche pas la suivante.
pointer('pointerdown', 250, 250);
pointer('pointerup', 250, 250);
assert.equal(S.manual.length, 1);
element('mAll').onclick();
pointer('pointerdown', 250, 250);
pointer('pointermove', 450, 350);
pointer('pointerup', 450, 350);
growBoth(15);
assert.deepEqual(paint(0), [[375, 275, 151, 151]]);
assert.deepEqual(paint(1 / 30), [[190, 190, 121, 121]]);
assert.equal(S.manual[0].cx, 0.25);
await next();
assert.equal(run('frameIndex(S.t)'), 1);
pointer('pointerdown', 250, 250);
pointer('pointermove', 600, 600);
pointer('pointerup', 600, 600);
assert.deepEqual(paint(1 / 30), [[540, 540, 121, 121]]);
await prev();
assert.equal(run('frameIndex(S.t)'), 0);
assert.deepEqual(paint(S.t), [[375, 275, 151, 151]]);
// L'export doit choisir la position à son propre instant, même si l'aperçu est sur une autre image.
assert.deepEqual(paint(2 / 30), [[190, 190, 121, 121]]);
assert.deepEqual(paint(1 / 30), [[540, 540, 121, 121]]);
// Tous les masques doivent utiliser l'instant de l'export, quel que soit leur ordre dans la liste.
run(`S.manual.push({ id: S.nextId++, cx: 0.8, cy: 0.8, size: 0.12, t0: 0, t1: 1,
  edits: new Map([[1, { cx: 0.75, cy: 0.7, size: 0.12 }]]) });`);
assert.deepEqual(paint(1 / 30), [[540, 540, 121, 121], [690, 640, 121, 121]]);
assert.deepEqual(paint(2 / 30), [[190, 190, 121, 121], [740, 740, 121, 121]]);
console.log('OK : positions et tailles manuelles indépendantes, conservées au retour, dessin d’export au bon instant');

// Le même suivi automatique a une case indépendante par image.
run(`S.manual = []; S.sel = null; S.t = 0;
  const tr = { id: 1, off: [], dets: new Map([[0, {}], [29, {}]]) };
  S.tracks = [tr];
  S.frames = Array.from({ length: 30 }, () => [{ x: 200, y: 200, w: 100, h: 100, track: tr }]);`);
pointer('pointerdown', 250, 250);
pointer('pointermove', 400, 450);
pointer('pointerup', 400, 450);
assert.deepEqual(paint(0), [[350, 400, 101, 101]]);
assert.deepEqual(paint(1 / 30), [[200, 200, 101, 101]]);
growBoth(12.5);
assert.deepEqual(paint(0), [[337, 387, 126, 126]]);
await next();
growBoth(12.5);
assert.deepEqual(paint(1 / 30), [[187, 187, 126, 126]]);
await prev();
assert.deepEqual(paint(0), [[337, 387, 126, 126]]);
// Retrait et restauration existants doivent encore fonctionner après une correction.
element('mDelete').onclick();
assert.deepEqual(paint(0), []);
assert.deepEqual(paint(1 / 30), []);
element('restoreAll').onclick();
assert.deepEqual(paint(0), [[337, 387, 126, 126]]);
console.log('OK : déplacement et taille automatiques par image, retrait et restauration');

// Plusieurs cases du même suivi sur une image : modifier celle que l'on a touchée.
run(`S.frames[0].push({ x: 700, y: 700, w: 100, h: 100, track: S.tracks[0] });`);
pointer('pointerdown', 750, 750);
pointer('pointermove', 800, 800);
pointer('pointerup', 800, 800);
growBoth(12.5);
assert.deepEqual(paint(0), [[337, 387, 126, 126], [737, 737, 126, 126]]);
console.log('OK : la correction cible la case touchée quand un suivi a plusieurs cases');

// Les flèches avancent exactement d'une image, même sur une frontière d'horloge.
run('S.t = 0.3');
await next();
assert.equal(run('frameIndex(S.t)'), 10);
await prev();
assert.equal(run('frameIndex(S.t)'), 9);
run('S.t = 0');
await prev();
assert.equal(run('frameIndex(S.t)'), 0);
run('S.t = 0.999');
await next();
assert.equal(run('frameIndex(S.t)'), 29);
assert.match(element('frameStatus').textContent, /Image 30 \/ 30/);
console.log('OK : navigation aux frontières et compteur d’images');

// Une photo conserve le déplacement et le redimensionnement habituels.
run(`S.kind = 'photo'; S.t = 0; S.frames = [[]]; S.tracks = []; S.manual = []; S.sel = null;`);
pointer('pointerdown', 250, 250);
pointer('pointermove', 350, 400);
pointer('pointerup', 350, 400);
growBoth(15);
assert.equal(S.manual[0].cx, 0.35);
assert.equal(S.manual[0].cy, 0.4);
assert.equal(S.manual[0].w, 0.15);
assert.equal(S.manual[0].h, 0.15);
assert.deepEqual(paint(0), [[275, 325, 151, 151]]);
element('mDelete').onclick();
assert.equal(S.manual.length, 0);
console.log('OK : édition et suppression d’un masque sur une photo');

// Rectangle libre : le coin opposé reste fixe, puis un bord ajuste seulement la largeur.
run(`S.kind = 'video'; S.W = S.H = 1000; S.duration = 1; S.fps = 30;
  S.frames = Array.from({ length: 30 }, () => []); S.t = 0; S.sel = null;`);
pointer('pointerdown', 250, 250);
pointer('pointerup', 250, 250);
resize('se', 100, -50);
assert.deepEqual(paint(0), [[190, 190, 221, 71]]);
assert.deepEqual(paint(1 / 30), [[190, 190, 121, 121]]);
resize('w', -90, 0);
assert.deepEqual(paint(0), [[100, 190, 311, 71]]);
resize('n', 0, 500); // Le bord ne traverse pas son opposé : au moins deux pixels restent masqués.
assert.deepEqual(paint(0), [[100, 258, 311, 3]]);
assert.ok(S.manual[0].edits.get(0).w > S.manual[0].edits.get(0).h);
console.log('OK : rectangle libre, coins opposés fixes, bords indépendants et taille minimale');

// Les huit poignées agissent dans le bon sens et ne créent aucun nouveau masque.
for (const [h, dx, dy, expected] of [
  ['nw', -10, -20, [190, 180, 111, 121]], ['n', 0, -20, [200, 180, 101, 121]],
  ['ne', 10, -20, [200, 180, 111, 121]], ['e', 10, 0, [200, 200, 111, 101]],
  ['se', 10, 20, [200, 200, 111, 121]], ['s', 0, 20, [200, 200, 101, 121]],
  ['sw', -10, 20, [190, 200, 111, 121]], ['w', -10, 0, [190, 200, 111, 101]],
]) {
  run(`S.manual = [{ cx: 0.25, cy: 0.25, w: 0.1, h: 0.1, t0: 0, t1: 1 }]; S.sel = { manual: S.manual[0] };`);
  resize(h, dx, dy);
  assert.deepEqual(paint(0), [expected], h);
  assert.equal(S.manual.length, 1);
}
console.log('OK : les huit poignées redimensionnent le masque sélectionné');

// Durée libre : saisie, début/fin sur l'image, changements depuis une image où le masque est invisible.
const changeTime = (id, value) => {
  const input = element(id);
  input.value = String(value);
  input.listeners.get('change')({ target: input });
};
run(`S.manual = [{ cx: 0.25, cy: 0.25, w: 0.1, h: 0.1, t0: 0, t1: 1 }]; S.sel = { manual: S.manual[0] };`);
changeTime('mStart', 0.2);
changeTime('mEnd', 0.6);
assert.deepEqual(paint(0.1999), []);
assert.deepEqual(paint(0.2), [[200, 200, 101, 101]]);
assert.deepEqual(paint(0.5999), [[200, 200, 101, 101]]);
assert.deepEqual(paint(0.6), []);
run('renderReview()');
assert.equal(element('maskHandles').hidden, true);
assert.equal(element('maskTiming').hidden, false);
run('S.t = 0.35');
element('mStartHere').onclick();
assert.equal(S.manual[0].t0, 10 / 30);
run('S.t = 0.45');
element('mEndHere').onclick();
assert.equal(S.manual[0].t1, 14 / 30);
assert.deepEqual(paint(14 / 30), []);
element('mAll').onclick();
assert.equal(S.manual[0].t0, 0);
assert.equal(S.manual[0].t1, 1);
// Une borne déplacée au-delà de l'autre conserve toujours un intervalle valide.
changeTime('mStart', 20);
assert.ok(S.manual[0].t0 >= 0 && S.manual[0].t0 < S.manual[0].t1 && S.manual[0].t1 <= 1);
changeTime('mEnd', -20);
assert.ok(S.manual[0].t0 >= 0 && S.manual[0].t0 < S.manual[0].t1 && S.manual[0].t1 <= 1);
// Même avec le champ encore focalisé, la saisie affichée reflète la borne corrigée.
sandbox.document.activeElement = element('mStart');
changeTime('mStart', -100);
assert.equal(Number(element('mStart').value), 0);
sandbox.document.activeElement = null;
const before = [S.manual[0].t0, S.manual[0].t1];
changeTime('mEnd', 'pas un nombre');
changeTime('mStart', '');
assert.deepEqual([S.manual[0].t0, S.manual[0].t1], before);
console.log('OK : début et fin précis, bornes exclusives, réglage hors de l’intervalle et saisies invalides');

// Étendre un suivi détecté copie ses extrémités, sans lier les géométries des nouvelles images.
run(`S.manual = []; S.t = 0.35;
  const ranged = { id: 2, off: [], t0: 0.3, t1: 0.5, dets: new Map([[9, {}], [14, {}]]) };
  S.tracks = [ranged];
  S.frames = Array.from({ length: 30 }, (_, j) => j >= 9 && j <= 14 ? [{ x: 200, y: 200, w: 100, h: 100, track: ranged }] : []);
  S.sel = { track: ranged, box: S.frames[10][0] };`);
changeTime('mStart', 0.1);
changeTime('mEnd', 0.8);
assert.deepEqual(paint(0.0999), []);
assert.deepEqual(paint(0.1), [[200, 200, 101, 101]]);
assert.deepEqual(paint(0.7999), [[200, 200, 101, 101]]);
assert.deepEqual(paint(0.8), []);
run('S.t = 0.12');
resize('e', 100, 0);
assert.deepEqual(paint(0.12), [[200, 200, 201, 101]]);
assert.deepEqual(paint(0.15), [[200, 200, 101, 101]]);
assert.deepEqual(paint(0.35), [[200, 200, 101, 101]]);
changeTime('mStart', 0.4);
changeTime('mEnd', 0.6);
assert.deepEqual(paint(0.39), []);
assert.deepEqual(paint(0.6), []);
element('mAll').onclick();
assert.deepEqual(paint(0.12), [[200, 200, 201, 101]]);
assert.ok(S.frames.every((f) => f.length === 1));
console.log('OK : raccourcir et prolonger un masque détecté, sans copies en double ni corrections partagées');

// Changer d'image pendant un geste termine la capture, sans déplacer la nouvelle image.
run('S.t = 0');
pointer('pointerdown', 250, 250);
await next();
pointer('pointermove', 600, 600);
assert.deepEqual(paint(S.t), [[200, 200, 201, 101]]);
assert.equal(element('view').captured, null);
console.log('OK : le changement d’image termine le déplacement en cours');

// Le rapport largeur/hauteur de l'image et ses bandes latérales ne doivent pas déformer les masques.
run(`S.kind = 'photo'; S.W = 1000; S.H = 2000; S.duration = 0; S.t = 0;
  S.frames = [[]]; S.tracks = []; S.manual = []; S.sel = null;`);
pointer('pointerdown', 500, 500);
pointer('pointerup', 500, 500);
assert.deepEqual(paint(0), [[440, 940, 121, 121]]);
assert.equal(element('resize-n').hidden, true);
assert.equal(element('maskTiming').hidden, true);
resize('se', 200, 100);
assert.deepEqual(paint(0), [[440, 940, 321, 221]]);
assert.equal(S.manual[0].w, 0.32);
assert.equal(S.manual[0].h, 0.11);
assert.equal(Number.parseFloat(element('resize-nw').style.left), 470);
assert.equal(Number.parseFloat(element('resize-nw').style.top), 470);
console.log('OK : coins au bon endroit et proportions libres sur une image portrait avec bandes latérales');

// La timeline se clique à travers le curseur transparent, avec les coordonnées CSS d'un écran haute densité.
run(`S.kind = 'video'; S.W = S.H = 1000; S.duration = 1; S.fps = 30; S.t = 0; S.sel = null;
  const timelineTrack = { id: 3, off: [], t0: 0.2, t1: 0.6, dets: new Map([[6, {}], [17, {}]]) };
  S.tracks = [timelineTrack];
  S.frames = Array.from({ length: 30 }, (_, j) => j >= 6 && j < 18 ? [{ x: 200, y: 200, w: 100, h: 100, track: timelineTrack }] : []);
  S.manual = [{ cx: 0.7, cy: 0.7, w: 0.1, h: 0.1, t0: 0.3, t1: 0.8 }];`);
element('tracks').getBoundingClientRect = () => ({ left: 100, top: 50, width: 400, height: 36 });
sandbox.window.devicePixelRatio = 2;
run('sizeTimeline(); renderReview()');
const settleSeek = async () => { await Promise.resolve(); await Promise.resolve(); };
const timelineClick = async (x, y) => {
  pointer('pointerdown', x, y, 1, 'time');
  pointer('pointerup', x, y, 1, 'time');
  await settleSeek();
};
// Première ligne blanche : sélection du suivi et déplacement à l'instant cliqué.
await timelineClick(220, 60);
assert.equal(S.sel.track, S.tracks[0]);
assert.equal(S.t, 0.3);
assert.equal(element('maskHandles').hidden, false);
assert.equal(element('maskTiming').hidden, false);
// Ligne manuelle en bas : sélection du masque ajouté, même s'il n'était pas encore visible.
await timelineClick(300, 83);
assert.equal(S.sel.manual, S.manual[0]);
assert.equal(S.t, 0.5);
assert.equal(element('view').captured, null);
assert.equal(element('time').captured, null);
// Zone sans trait : le curseur reste utilisable et la sélection reste disponible pour régler sa durée.
await timelineClick(460, 70);
assert.equal(S.t, 0.9);
assert.equal(S.sel.manual, S.manual[0]);
assert.equal(element('maskHandles').hidden, true);
assert.equal(element('maskTiming').hidden, false);
console.log('OK : clic sur les traits automatiques et manuels, haute densité et navigation dans les zones vides');

// Un passage retiré n'est pas sélectionnable comme s'il contenait encore un trait.
run(`S.sel = null; S.tracks[0].off = [{ from: 12, off: true }, { from: 15, off: false }]; renderReview();`);
await timelineClick(280, 60);
assert.equal(S.sel, null);
await timelineClick(320, 60);
assert.equal(S.sel.track, S.tracks[0]);
// Si plusieurs traits se superposent, le masque visible au-dessus est sélectionné.
run(`S.manual.push({ cx: 0.8, cy: 0.8, w: 0.1, h: 0.1, t0: 0.4, t1: 0.7 }); renderReview();`);
await timelineClick(300, 83);
assert.equal(S.sel.manual, S.manual[1]);
console.log('OK : les traits retirés sont ignorés et les superpositions sélectionnent le masque visible');

// Glisser dans la timeline continue de parcourir la vidéo, sans changer le masque choisi au début du geste.
pointer('pointerdown', 220, 60, 1, 'time');
await settleSeek();
assert.equal(S.sel.track, S.tracks[0]);
pointer('pointermove', 420, 83, 2, 'time');
await settleSeek();
assert.equal(S.t, 0.3); // Un deuxième doigt ne déplace pas le curseur capturé.
pointer('pointermove', 500, 83, 1, 'time');
await settleSeek();
assert.equal(S.t, 0.999);
assert.equal(S.sel.track, S.tracks[0]);
pointer('pointercancel', 500, 83, 1, 'time');
assert.equal(element('time').captured, null);
pointer('pointermove', 100, 60, 1, 'time');
await settleSeek();
assert.equal(S.t, 0.999);
// La navigation au clavier conserve le gestionnaire input du curseur natif.
element('time').value = '0.25';
element('time').listeners.get('input')({ target: element('time') });
await settleSeek();
assert.equal(S.t, 0.25);
console.log('OK : glissement du curseur, limites de la vidéo, multitouch et navigation au clavier');
