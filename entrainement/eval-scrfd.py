# Compare le détecteur de skred (YuNet, règle du site) à SCRFD-500M (https://github.com/deepinsight/insightface, poids
# réservés à la recherche non commerciale ; ONNX : scrfd_500m_kps.onnx sur github.com/yakhyo/uniface/releases/tag/weights),
# sur les mêmes banques de photos annotées que entrainement/eval-faces.py (WIDER FACE, DARK FACE).
# Usage : python entrainement/eval-scrfd.py <dossier des banques> <chemin du .onnx>
# Les détections sont gardées en cache (detections-scrfd-*.json), à côté de celles de YuNet.
import importlib.util
import json
import os
import sys
import time

import cv2
import numpy as np
import onnxruntime as ort

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = sys.argv[1] if len(sys.argv) > 1 else 'D:/datasets/skred-eval'
SCRFD_PATH = sys.argv[2] if len(sys.argv) > 2 else os.path.join(DATA, 'modeles', 'scrfd', 'scrfd_500m_kps.onnx')
sys.argv = [sys.argv[0], DATA]
spec = importlib.util.spec_from_file_location('ev', os.path.join(HERE, 'eval-faces.py'))
ev = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ev)

KEEP = 0.05   # seuil bas gardé en cache ; les seuils comparés sont appliqués ensuite
ort.set_default_logger_severity(3)   # le modèle annonce des sorties de taille fixe : avertissement à chaque image, sans effet
session_scrfd = ort.InferenceSession(SCRFD_PATH, providers=['CPUExecutionProvider'])


def scrfd(img):
    """Même réduction de l'image que skred (plus grand côté 1920 au plus), bords complétés jusqu'à un multiple de 32.
    Décodage repris de entrainement/distiller-wider.py (deux ancres par case, distances aux bords du cadre)."""
    h, w = img.shape[:2]
    s = min(1.0, ev.MAX_SIDE / max(w, h))
    dw, dh = max(1, round(w * s)), max(1, round(h * s))
    pw, ph = -(-dw // 32) * 32, -(-dh // 32) * 32
    pad = np.zeros((ph, pw, 3), np.uint8)
    pad[:dh, :dw] = cv2.resize(img, (dw, dh), interpolation=cv2.INTER_AREA) if s < 1 else img
    out = session_scrfd.run(None, {'input.1': cv2.dnn.blobFromImage(pad, 1 / 128, (pw, ph), (127.5, 127.5, 127.5), swapRB=True)})
    found = []
    for k, st in enumerate((8, 16, 32)):
        sc, bb = out[k][:, 0], out[k + 3] * st
        gy, gx = np.mgrid[0:ph // st, 0:pw // st]
        cx, cy = np.repeat(gx.reshape(-1) * st, 2), np.repeat(gy.reshape(-1) * st, 2)
        for i in np.nonzero(sc >= KEEP)[0]:
            x1, y1, x2, y2 = cx[i] - bb[i, 0], cy[i] - bb[i, 1], cx[i] + bb[i, 2], cy[i] + bb[i, 3]
            found.append([x1 / s, y1 / s, (x2 - x1) / s, (y2 - y1) / s, float(sc[i])])
    found.sort(key=lambda d: -d[4])
    kept = []
    for b in found:
        if all(ev.iou(k, b) <= ev.NMS_IOU for k in kept):
            kept.append(b)
    return [[round(float(v), 1) for v in d[:4]] + [round(float(d[4]), 3)] for d in kept]


def collect(name, rows):
    cache = os.path.join(DATA, f'detections-scrfd-{name}.json')
    if os.path.exists(cache):
        return json.load(open(cache))
    paths = {}
    items = ev.wider() if name == 'wider' else ev.darkface()
    for _, path, _ in items:
        paths[os.path.basename(path)] = path
    out, t0 = {}, time.time()
    for k, r in enumerate(rows):
        out[r['p']] = scrfd(cv2.imread(paths[r['p']]))
        if k % 250 == 0:
            print(f'  scrfd {name} : {k}/{len(rows)} images, {time.time() - t0:.0f} s', flush=True)
    json.dump(out, open(cache, 'w'))
    return out


def timing(name, n=60):
    """Temps moyen par image, sur les mêmes images, pour les deux modèles (une passe chacun, processeur seul)."""
    items = ev.wider() if name == 'wider' else ev.darkface()
    imgs = [cv2.imread(p) for _, p, _ in list(items)[:n]]
    t = time.time(); [ev.detect(i) for i in imgs]; ty = (time.time() - t) / len(imgs)
    t = time.time(); [scrfd(i) for i in imgs]; to = (time.time() - t) / len(imgs)
    return ty * 1000, to * 1000


if __name__ == '__main__':
    for name in ('wider', 'darkface'):
        rows = ev.collect(name, ev.wider() if name == 'wider' else ev.darkface())
        if not rows:
            continue
        yd = collect(name, rows)
        ty, to = timing(name)
        print(f'\n===== {name} : {len(rows)} images, {sum(len(r["faces"]) for r in rows)} visages repérés')
        print(f"  temps par image (processeur) : YuNet {ty:.0f} ms, SCRFD-500M {to:.0f} ms")
        print("  visages non couverts, par taille (part du petit côté de l'image) · grands masques sans visage")
        rules = {'YuNet (règle du site)': ev.masks_app}
        for t in (0.2, 0.3, 0.5):
            rules[f'SCRFD seuil {t}'] = (lambda t: lambda r: [ev.grow(d) for d in yd[r['p']] if d[4] >= t])(t)
        for t in (0.3, 0.5):
            rules[f'YuNet + SCRFD {t}'] = (lambda t: lambda r: ev.masks_app(r) + [ev.grow(d) for d in yd[r['p']] if d[4] >= t])(t)
        for rname, fn in rules.items():
            missed, total, false_big = ev.evaluate(rows, fn)
            bands = '  '.join(f'{int(b[0] * 100)}-{int(min(b[1], 1) * 100)} % : {missed[b]}/{total[b]}' for b in total)
            print(f'    {rname:26s} {bands}  ·  {false_big}', flush=True)
