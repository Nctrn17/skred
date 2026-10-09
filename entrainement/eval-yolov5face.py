# Compare le détecteur de skred (YuNet, règle du site) à YOLOv5-face (https://github.com/deepcam-cn/yolov5-face),
# sur les mêmes banques de photos annotées que entrainement/eval-faces.py (WIDER FACE, DARK FACE).
# Usage : python entrainement/eval-yolov5face.py <dossier des banques> <dossier du code yolov5-face> <poids .pt> <nom>
# Le modèle tourne dans PyTorch, directement depuis le code du dépôt (même sortie qu'un ONNX, sans l'étape d'export) :
# le temps mesuré n'est donc qu'une indication. Les détections sont gardées en cache (detections-<nom>-*.json).
import importlib.util
import json
import os
import sys
import time

import cv2
import numpy as np
import torch

HERE = os.path.dirname(os.path.abspath(__file__))
DATA, CODE, WEIGHTS, NAME = sys.argv[1:5]
sys.argv = [sys.argv[0], DATA]
spec = importlib.util.spec_from_file_location('ev', os.path.join(HERE, 'eval-faces.py'))
ev = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ev)

sys.path.insert(0, CODE)
_load = torch.load
torch.load = lambda *a, **k: _load(*a, **{**k, 'weights_only': False})   # poids enregistrés avec une ancienne version
from models.experimental import attempt_load  # noqa: E402

KEEP = 0.05   # seuil bas gardé en cache ; les seuils comparés sont appliqués ensuite
torch.set_grad_enabled(False)
model = attempt_load(WEIGHTS, map_location='cpu').eval()


def yolov5face(img):
    """Même réduction de l'image que skred (plus grand côté 1920 au plus), bords complétés jusqu'à un multiple de 32."""
    h, w = img.shape[:2]
    s = min(1.0, ev.MAX_SIDE / max(w, h))
    dw, dh = max(1, round(w * s)), max(1, round(h * s))
    pw, ph = -(-dw // 32) * 32, -(-dh // 32) * 32
    pad = np.full((ph, pw, 3), 114, np.uint8)
    pad[:dh, :dw] = cv2.resize(img, (dw, dh), interpolation=cv2.INTER_AREA) if s < 1 else img
    blob = torch.from_numpy(cv2.cvtColor(pad, cv2.COLOR_BGR2RGB).astype(np.float32).transpose(2, 0, 1)[None] / 255)
    out = model(blob)[0][0].numpy()   # N × 16 : centre x, centre y, largeur, hauteur, objet, 10 repères, classe
    sc = out[:, 4] * out[:, 15]
    out, sc = out[sc >= KEEP], sc[sc >= KEEP]
    found = [[(x - a / 2) / s, (y - b / 2) / s, a / s, b / s, float(c)] for (x, y, a, b), c in zip(out[:, :4], sc)]
    found.sort(key=lambda d: -d[4])
    kept = []
    for b in found:
        if all(ev.iou(k, b) <= ev.NMS_IOU for k in kept):
            kept.append(b)
    return [[round(float(v), 1) for v in d[:4]] + [round(float(d[4]), 3)] for d in kept]


def collect(name, rows):
    cache = os.path.join(DATA, f'detections-{NAME}-{name}.json')
    if os.path.exists(cache):
        return json.load(open(cache))
    paths = {}
    items = ev.wider() if name == 'wider' else ev.darkface()
    for _, path, _ in items:
        paths[os.path.basename(path)] = path
    out, t0 = {}, time.time()
    for k, r in enumerate(rows):
        out[r['p']] = yolov5face(cv2.imread(paths[r['p']]))
        if k % 250 == 0:
            print(f'  {NAME} {name} : {k}/{len(rows)} images, {time.time() - t0:.0f} s', flush=True)
    json.dump(out, open(cache, 'w'))
    return out


def timing(name, n=60):
    """Temps moyen par image, sur les mêmes images (YuNet dans ONNX Runtime, YOLOv5-face dans PyTorch, processeur seul)."""
    items = ev.wider() if name == 'wider' else ev.darkface()
    imgs = [cv2.imread(p) for _, p, _ in list(items)[:n]]
    t = time.time(); [ev.detect(i) for i in imgs]; ty = (time.time() - t) / len(imgs)
    t = time.time(); [yolov5face(i) for i in imgs]; to = (time.time() - t) / len(imgs)
    return ty * 1000, to * 1000


if __name__ == '__main__':
    for name in ('wider', 'darkface'):
        rows = ev.collect(name, ev.wider() if name == 'wider' else ev.darkface())
        if not rows:
            continue
        yd = collect(name, rows)
        ty, to = timing(name)
        print(f'\n===== {name} : {len(rows)} images, {sum(len(r["faces"]) for r in rows)} visages repérés')
        print(f"  temps par image (processeur) : YuNet {ty:.0f} ms, {NAME} {to:.0f} ms")
        print("  visages non couverts, par taille (part du petit côté de l'image) · grands masques sans visage")
        rules = {'YuNet (règle du site)': ev.masks_app}
        for t in (0.2, 0.3, 0.5):
            rules[f'{NAME} seuil {t}'] = (lambda t: lambda r: [ev.grow(d) for d in yd[r['p']] if d[4] >= t])(t)
        for t in (0.3, 0.5):
            rules[f'YuNet + {NAME} {t}'] = (lambda t: lambda r: ev.masks_app(r) + [ev.grow(d) for d in yd[r['p']] if d[4] >= t])(t)
        for rname, fn in rules.items():
            missed, total, false_big = ev.evaluate(rows, fn)
            bands = '  '.join(f'{int(b[0] * 100)}-{int(min(b[1], 1) * 100)} % : {missed[b]}/{total[b]}' for b in total)
            print(f'    {rname:30s} {bands}  ·  {false_big}', flush=True)
