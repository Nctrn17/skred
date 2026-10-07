# Correction à la main des visages pré-repérés par entrainement/prepare-reel.py. Ouvre une page locale :
# clic sur un cadre : le retirer ; glisser : ajouter un visage ; Entrée : valider et passer à la suivante.
# Usage : python entrainement/annoter-reel.py <dossier des banques>   puis ouvrir http://localhost:8765
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DATA = sys.argv[1] if len(sys.argv) > 1 else 'D:/datasets/skred-eval'
OUT = os.path.join(DATA, 'reel')
REF = os.path.join(OUT, 'reel.json')

PAGE = r"""<!doctype html><meta charset="utf-8"><title>Repérer les visages</title>
<style>
body{margin:0;font:15px system-ui;background:#111;color:#eee}
header{position:sticky;top:0;background:#222;padding:8px 12px;display:flex;gap:12px;align-items:center;z-index:2}
button{font:inherit;padding:6px 12px}
#wrap{position:relative;display:inline-block;cursor:crosshair}
#wrap img{display:block;max-width:100vw;max-height:calc(100vh - 70px)}
#wrap.full img{max-width:none;max-height:none}
.b{position:absolute;border:2px solid #0f0;box-sizing:border-box}
.b.low{border-color:#ff0}
.b.tiny{border:1px dashed #888}
.b:hover{border-color:#f00;background:#f003}
#drag{position:absolute;border:2px dashed #0ff;display:none;pointer-events:none}
small{color:#aaa}
</style>
<header>
<span id="pos"></span><button id="prev">← Précédente</button><button id="ok">Valider (Entrée) →</button>
<button id="zoom">Taille réelle (F)</button>
<small>Clic sur un cadre : retirer. Glisser : ajouter. Vert : sûr, jaune : à vérifier, gris pointillé : trop petit, pas compté (ne t'en occupe pas).<br>Un visage = on voit les yeux, le nez ou la bouche, même flou, de profil ou en partie caché. Pas l'arrière d'une tête.</small>
</header>
<div id="wrap"><img id="img"><div id="drag"></div></div>
<script>
let L = [], i = 0, faces = [];
const img = document.getElementById('img'), wrap = document.getElementById('wrap'), drag = document.getElementById('drag');
const k = () => img.clientWidth / img.naturalWidth;
function draw() {
  wrap.querySelectorAll('.b').forEach(e => e.remove());
  faces.forEach((f, n) => {
    const e = document.createElement('div');
    const tiny = f[2] < 0.03 * Math.min(img.naturalWidth, img.naturalHeight);   // trop petit : pas compté dans la mesure
    e.className = 'b' + (tiny ? ' tiny' : f[4] < 0.6 ? ' low' : '');
    Object.assign(e.style, { left: f[0] * k() + 'px', top: f[1] * k() + 'px', width: f[2] * k() + 'px', height: f[3] * k() + 'px' });
    e.onmousedown = ev => ev.stopPropagation();
    e.onclick = ev => { ev.stopPropagation(); faces.splice(n, 1); draw(); };
    wrap.appendChild(e);
  });
}
function load() {
  const e = L[i];
  faces = e.faces.map(f => f.slice());
  document.getElementById('pos').textContent = `${i + 1} / ${L.length}` + (e.checked ? ' (déjà validée)' : '') + ` · reste ${L.filter(x => !x.checked).length}`;
  img.onload = draw;
  img.src = '/images/' + e.image;
}
async function save() {
  L[i].faces = faces; L[i].checked = true;
  await fetch('/save', { method: 'POST', body: JSON.stringify({ image: L[i].image, faces }) });
}
// Après validation : la prochaine image pas encore validée (sinon la suivante).
document.getElementById('ok').onclick = async () => {
  await save();
  const next = L.findIndex((x, n) => n > i && !x.checked);
  i = next >= 0 ? next : Math.max(0, L.findIndex(x => !x.checked));
  if (i < 0) i = L.length - 1;
  load();
};
// Entrée sur un bouton qui a le focus le déclencherait en plus du raccourci : une image aurait été sautée.
document.querySelectorAll('button').forEach(b => b.addEventListener('mouseup', () => b.blur()));
document.getElementById('prev').onclick = () => { if (i > 0) i--; load(); };
document.getElementById('zoom').onclick = () => { wrap.classList.toggle('full'); draw(); };
addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); document.getElementById('ok').click(); }
  if (e.key === 'f' || e.key === 'F') document.getElementById('zoom').click();
});
addEventListener('resize', draw);
let start = null;
wrap.onmousedown = e => { e.preventDefault(); const r = wrap.getBoundingClientRect(); start = [e.clientX - r.left, e.clientY - r.top]; };
addEventListener('mousemove', e => {
  if (!start) return;
  const r = wrap.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  Object.assign(drag.style, { display: 'block', left: Math.min(x, start[0]) + 'px', top: Math.min(y, start[1]) + 'px', width: Math.abs(x - start[0]) + 'px', height: Math.abs(y - start[1]) + 'px' });
});
addEventListener('mouseup', e => {
  if (!start) return;
  const r = wrap.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  if (Math.abs(x - start[0]) > 4 && Math.abs(y - start[1]) > 4)
    faces.push([Math.min(x, start[0]) / k(), Math.min(y, start[1]) / k(), Math.abs(x - start[0]) / k(), Math.abs(y - start[1]) / k(), 1]);
  start = null; drag.style.display = 'none'; draw();
});
fetch('/list').then(r => r.json()).then(d => { L = d; i = Math.max(0, L.findIndex(x => !x.checked)); load(); });
</script>"""


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, body, kind):
        self.send_response(200)
        self.send_header('Content-Type', kind)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == '/':
            self.send(PAGE.encode(), 'text/html; charset=utf-8')
        elif self.path == '/list':
            self.send(open(REF, 'rb').read(), 'application/json')
        elif self.path.startswith('/images/') and '..' not in self.path:
            self.send(open(os.path.join(OUT, 'images', os.path.basename(self.path)), 'rb').read(), 'image/jpeg')
        else:
            self.send_error(404)

    def do_POST(self):
        d = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        L = json.load(open(REF))
        for e in L:
            if e['image'] == d['image']:
                e['faces'] = [[round(v, 1) for v in f[:4]] + [f[4]] for f in d['faces']]
                e['checked'] = True
        json.dump(L, open(REF + '.tmp', 'w'), indent=0)
        os.replace(REF + '.tmp', REF)
        self.send(b'ok', 'text/plain')


print('Ouvre http://localhost:8765')
ThreadingHTTPServer(('127.0.0.1', 8765), H).serve_forever()
