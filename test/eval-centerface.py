# Compare le détecteur de skred (YuNet, règle du site) à CenterFace, le modèle de deface (https://github.com/ORB-HD/deface),
# sur les mêmes banques de photos annotées que test/eval-faces.py (WIDER FACE, DARK FACE).
# Usage : python test/eval-centerface.py <dossier des banques> <chemin de centerface.onnx>
# (centerface.onnx : https://github.com/ORB-HD/deface/tree/master/deface ; besoin : pip install onnx onnxruntime opencv-python numpy)
# Les détections de CenterFace sont gardées en cache (detections-centerface-*.json), à côté de celles de YuNet.
import importlib.util
import json
import os
import sys
import time

import cv2
import numpy as np
import onnx
import onnxruntime as ort
from onnx.tools.update_model_dims import update_inputs_outputs_dims

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = sys.argv[1] if len(sys.argv) > 1 else 'D:/datasets/skred-eval'
CF_PATH = sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, 'centerface.onnx')
sys.argv = [sys.argv[0], DATA]
spec = importlib.util.spec_from_file_location('ev', os.path.join(HERE, 'eval-faces.py'))
ev = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ev)

KEEP = 0.05   # seuil bas gardé en cache ; les seuils comparés sont appliqués ensuite

# Modèle à dimensions libres, comme le fait deface (centerface.py, dynamicize_shapes).
m = onnx.load(CF_PATH)
ins = {n.name: [d.dim_value for d in n.type.tensor_type.shape.dim] for n in m.graph.input}
outs = {n.name: [d.dim_value for d in n.type.tensor_type.shape.dim] for n in m.graph.output}
ins['input.1'] = ['B', 3, 'H', 'W']
outs.update({'537': ['B', 1, 'h', 'w'], '538': ['B', 2, 'h', 'w'], '539': ['B', 2, 'h', 'w'], '540': ['B', 10, 'h', 'w']})
cf = ort.InferenceSession(update_inputs_outputs_dims(m, ins, outs).SerializeToString(), providers=['CPUExecutionProvider'])


def centerface(img):
    """Décodage repris de deface/centerface.py. Même réduction de l'image que skred (plus grand côté 1920 au plus)."""
    h, w = img.shape[:2]
    s = min(1.0, ev.MAX_SIDE / max(w, h))
    dw, dh = max(1, round(w * s)), max(1, round(h * s))
    nw, nh = -(-dw // 32) * 32, -(-dh // 32) * 32
    rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    blob = cv2.dnn.blobFromImage(rgb, 1.0, (nw, nh), (0, 0, 0), swapRB=False, crop=False)
    heat, scale, offset, _ = cf.run(['537', '538', '539', '540'], {'input.1': blob})
    heat = np.squeeze(heat)
    sw, sh = nw / w, nh / h
    found = []
    for y, x in zip(*np.where(heat > KEEP)):
        s0, s1 = np.exp(scale[0, 0, y, x]) * 4, np.exp(scale[0, 1, y, x]) * 4
        x1 = max(0, (x + offset[0, 1, y, x] + 0.5) * 4 - s1 / 2)
        y1 = max(0, (y + offset[0, 0, y, x] + 0.5) * 4 - s0 / 2)
        x2, y2 = min(x1 + s1, nw), min(y1 + s0, nh)
        found.append([x1 / sw, y1 / sh, (x2 - x1) / sw, (y2 - y1) / sh, float(heat[y, x])])
    found.sort(key=lambda d: -d[4])
    kept = []
    for b in found:
        if all(ev.iou(k, b) < 0.3 for k in kept):
            kept.append(b)
    return [[round(float(v), 1) for v in d[:4]] + [round(float(d[4]), 3)] for d in kept]


def collect(name, rows):
    cache = os.path.join(DATA, f'detections-centerface-{name}.json')
    if os.path.exists(cache):
        return json.load(open(cache))
    paths = {}
    items = ev.wider() if name == 'wider' else ev.darkface()
    for _, path, _ in items:
        paths[os.path.basename(path)] = path
    out, t0 = {}, time.time()
    for k, r in enumerate(rows):
        out[r['p']] = centerface(cv2.imread(paths[r['p']]))
        if k % 250 == 0:
            print(f'  centerface {name} : {k}/{len(rows)} images, {time.time() - t0:.0f} s', flush=True)
    json.dump(out, open(cache, 'w'))
    return out


def timing(rows, name, n=60):
    """Temps moyen par image, sur les mêmes images, pour les deux modèles (une passe chacun, processeur seul)."""
    items = ev.wider() if name == 'wider' else ev.darkface()
    paths = [p for _, p, _ in items][:n]
    imgs = [cv2.imread(p) for p in paths]
    t = time.time(); [ev.detect(i) for i in imgs]; ty = (time.time() - t) / len(imgs)
    t = time.time(); [centerface(i) for i in imgs]; tc = (time.time() - t) / len(imgs)
    return ty * 1000, tc * 1000


if __name__ == '__main__':
    for name in ('wider', 'darkface'):
        rows = ev.collect(name, ev.wider() if name == 'wider' else ev.darkface())
        if not rows:
            continue
        cfd = collect(name, rows)
        ty, tc = timing(rows, name)
        print(f'\n===== {name} : {len(rows)} images, {sum(len(r["faces"]) for r in rows)} visages repérés')
        print(f"  temps par image (processeur) : YuNet {ty:.0f} ms, CenterFace {tc:.0f} ms")
        print("  visages non couverts, par taille (part du petit côté de l'image) · grands masques sans visage")
        rules = {'YuNet (règle du site)': ev.masks_app}
        for t in (0.2, 0.3, 0.5):
            rules[f'CenterFace seuil {t}'] = (lambda t: lambda r: [ev.grow(d) for d in cfd[r['p']] if d[4] >= t])(t)
        for t in (0.3, 0.5):
            rules[f'YuNet + CenterFace {t}'] = (lambda t: lambda r: ev.masks_app(r) + [ev.grow(d) for d in cfd[r['p']] if d[4] >= t])(t)
        for rname, fn in rules.items():
            missed, total, false_big = ev.evaluate(rows, fn)
            bands = '  '.join(f'{int(b[0] * 100)}-{int(min(b[1], 1) * 100)} % : {missed[b]}/{total[b]}' for b in total)
            print(f'    {rname:26s} {bands}  ·  {false_big}', flush=True)
