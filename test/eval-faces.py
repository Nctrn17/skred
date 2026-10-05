# Mesure la détection sur des banques de photos où chaque visage a été repéré à la main (WIDER FACE, DARK FACE).
# Reprend exactement detector.js (même modèle, même préparation de l'image, même score) et la règle de app.js
# qui décide si un cadre est assez sûr pour être masqué. Compte, pour chaque réglage :
#  - les visages qui ne seraient pas couverts (au moins 70 % de leur surface sous un masque) ;
#  - les grands masques posés là où il n'y a aucun visage.
# Usage : python test/eval-faces.py <dossier des banques>   (besoin : pip install onnxruntime opencv-python numpy)
# Le dossier contient WIDER_val/ et wider_face_split/ (WIDER FACE, partie validation), et darkface/image/ et
# darkface/label/ (DARK FACE, https://flyywh.github.io/CVPRW2019LowLight/). Les détections sont gardées en cache.
import json
import os
import sys
import time

import cv2
import numpy as np
import onnxruntime as ort

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = sys.argv[1] if len(sys.argv) > 1 else 'D:/datasets/skred-eval'
STRIDES = (8, 16, 32)
NMS_IOU = 0.3
KEEP_SCORE = 0.15
MAX_SIDE = 1920
GROW = 1.3
SMALL_SCORE = 0.2   # petits visages (moins de 12 % du petit côté) : seuil plus bas, comme app.js
LOW_FACTOR = 3   # seconde passe : l'image analysée, réduite 3 fois

session = ort.InferenceSession(os.path.join(ROOT, 'models', 'yunet.onnx'), providers=['CPUExecutionProvider'])


def low(img):
    return detect(img, round(min(MAX_SIDE, max(img.shape[:2])) / LOW_FACTOR))


def detect(img, max_side=MAX_SIDE):
    h, w = img.shape[:2]
    scale = min(1.0, max_side / max(w, h))
    dw, dh = max(1, round(w * scale)), max(1, round(h * scale))
    pw, ph = -(-dw // 32) * 32, -(-dh // 32) * 32
    pad = np.zeros((ph, pw, 3), np.float32)
    pad[:dh, :dw] = cv2.resize(img, (dw, dh), interpolation=cv2.INTER_AREA) if scale < 1 else img   # BGR, comme detector.js
    out = dict(zip([o.name for o in session.get_outputs()], session.run(None, {'input': pad.transpose(2, 0, 1)[None]})))
    found = []
    for st in STRIDES:
        cols = pw // st
        cls = out[f'cls_{st}'].reshape(-1)
        obj = out[f'obj_{st}'].reshape(-1)
        box = out[f'bbox_{st}'].reshape(-1, 4)
        s = np.sqrt(np.clip(cls, 0, 1) * np.clip(obj, 0, 1))
        for i in np.nonzero(s >= KEEP_SCORE)[0]:
            bw, bh = np.exp(box[i, 2]) * st, np.exp(box[i, 3]) * st
            cx, cy = ((i % cols) + box[i, 0]) * st, ((i // cols) + box[i, 1]) * st
            found.append([(cx - bw / 2) / scale, (cy - bh / 2) / scale, bw / scale, bh / scale, float(s[i])])
    found.sort(key=lambda d: -d[4])
    kept = []
    for b in found:
        if all(iou(k, b) <= NMS_IOU for k in kept):
            kept.append(b)
    return [[round(float(v), 1) for v in d[:4]] + [round(float(d[4]), 3)] for d in kept]


def iou(a, b):
    ix = max(0, min(a[0] + a[2], b[0] + b[2]) - max(a[0], b[0]))
    iy = max(0, min(a[1] + a[3], b[1] + b[3]) - max(a[1], b[1]))
    inter = ix * iy
    return inter / (a[2] * a[3] + b[2] * b[3] - inter + 1e-9)


def grow(d):
    w, h = d[2] * GROW + 4, d[3] * GROW + 4
    return [d[0] + d[2] / 2 - w / 2, d[1] + d[3] / 2 - h / 2, w, h]


# ---------- Lecture des banques ----------

def wider():
    gt = os.path.join(DATA, 'wider_face_split', 'wider_face_val_bbx_gt.txt')
    lines = open(gt).read().split('\n')
    i = 0
    while i < len(lines) and lines[i].strip():
        name = lines[i].strip()
        n = int(lines[i + 1])
        faces = []
        for k in range(max(n, 1)):
            v = lines[i + 2 + k].split()
            if n and int(v[7]) == 0 and int(v[2]) > 0 and int(v[3]) > 0:   # v[7] : visage marqué invalide
                faces.append([int(v[0]), int(v[1]), int(v[2]), int(v[3])])
        i += 2 + max(n, 1)
        yield 'wider/' + name.split('/')[0], os.path.join(DATA, 'WIDER_val', 'images', name), faces


def darkface():
    base = None
    for dirpath, _, files in os.walk(DATA):
        if any(f.endswith('.txt') for f in files) and 'label' in dirpath.lower() and 'dark' in dirpath.lower():
            base = dirpath
            break
    if not base:
        return
    imgdir = next((os.path.join(os.path.dirname(base), d) for d in os.listdir(os.path.dirname(base)) if d.lower().startswith('image')), None)
    for f in sorted(os.listdir(base)):
        if not f.endswith('.txt'):
            continue
        rows = [r.split() for r in open(os.path.join(base, f)).read().split('\n')[1:] if r.strip()]
        faces = [[float(r[0]), float(r[1]), float(r[2]) - float(r[0]), float(r[3]) - float(r[1])] for r in rows]
        yield 'darkface', os.path.join(imgdir, f[:-4] + '.png'), faces


# ---------- Détection (gardée en cache) ----------

def collect(name, items):
    cache = os.path.join(DATA, f'detections-{name}.json')
    if os.path.exists(cache):
        rows = json.load(open(cache))
        if rows and 'lo' not in rows[0]:
            # Seconde passe sur l'image réduite (LOW_FACTOR) : les gros plans y redeviennent des visages de taille normale.
            paths = {os.path.basename(path): path for _, path, _ in items}
            for k, r in enumerate(rows):
                r['lo'] = low(cv2.imread(paths[r['p']]))
                if k % 500 == 0:
                    print(f'  {name} (image réduite) : {k} images', flush=True)
            json.dump(rows, open(cache, 'w'))
        return rows
    rows, t0 = [], time.time()
    for k, (group, path, faces) in enumerate(items):
        img = cv2.imread(path)
        if img is None:
            continue
        rows.append({'g': group, 'p': os.path.basename(path), 'W': img.shape[1], 'H': img.shape[0], 'faces': faces, 'dets': detect(img), 'lo': low(img)})
        if k % 250 == 0:
            print(f'  {name} : {k} images, {time.time() - t0:.0f} s', flush=True)
    if rows:
        json.dump(rows, open(cache, 'w'))
    return rows


# ---------- Règles ----------
# Chaque règle renvoie les masques posés sur une image (cadres agrandis comme dans app.js).

def ramp(d, side, a=0.12, b=0.25, top=0.85, base=0.3):
    return base + (top - base) * min(1, max(0, (d[2] / side - a) / (b - a)))


def masks_old(r):
    return [grow(d) for d in r['dets'] if d[4] >= 0.3]


def masks_app(r, low_score=0.7):
    """La règle de app.js (judge) : un grand cadre doit être très sûr ou retrouvé sur l'image réduite au tiers."""
    side = min(r['W'], r['H'])
    out = [grow(d) for d in r['dets'] if d[4] >= (SMALL_SCORE if d[2] / side < 0.12 else ramp(d, side)) or (d[4] >= 0.3 and any(iou(d, l) > 0.3 for l in r['lo']))]
    return out + [grow(l) for l in r['lo'] if l[4] >= low_score and l[2] / side >= 0.12]


def evaluate(rows, fn, sizes=((0.03, 0.12), (0.12, 0.25), (0.25, 0.4), (0.4, 9))):
    missed = {b: 0 for b in sizes}
    total = {b: 0 for b in sizes}
    false_big = 0
    for r in rows:
        side = min(r['W'], r['H'])
        masks = fn(r)
        for f in r['faces']:
            band = next((b for b in sizes if b[0] <= f[2] / side < b[1]), None)
            if band:
                total[band] += 1
                missed[band] += coverage(f, masks) < 0.7
        for g in masks:
            if g[2] / side >= 0.15 and not any(iou(g, f) > 0.1 or (g[0] <= f[0] + f[2] / 2 <= g[0] + g[2] and g[1] <= f[1] + f[3] / 2 <= g[1] + g[3]) for f in r['faces']):
                false_big += 1
    return missed, total, false_big


def coverage(f, masks):
    x0, y0, w, h = f
    if w < 1 or h < 1:
        return 1.0
    n = 24
    xs = x0 + (np.arange(n) + 0.5) * w / n
    ys = y0 + (np.arange(n) + 0.5) * h / n
    gx, gy = np.meshgrid(xs, ys)
    hit = np.zeros_like(gx, bool)
    for m in masks:
        hit |= (gx >= m[0]) & (gx <= m[0] + m[2]) & (gy >= m[1]) & (gy <= m[1] + m[3])
    return hit.mean()


if __name__ == '__main__':
    sets = {'wider': collect('wider', wider()), 'darkface': collect('darkface', darkface())}
    RULES = {'ancienne (0,3 partout)': masks_old, 'site (avec image réduite)': masks_app}
    for name, rows in sets.items():
        if not rows:
            print(f'\n{name} : aucune image trouvée')
            continue
        print(f'\n===== {name} : {len(rows)} images, {sum(len(r["faces"]) for r in rows)} visages repérés')
        print("  visages non couverts, par taille (part du petit côté de l'image) · grands masques sans visage")
        for rname, fn in RULES.items():
            missed, total, false_big = evaluate(rows, fn)
            bands = '  '.join(f'{int(b[0] * 100)}-{int(min(b[1], 1) * 100)} % : {missed[b]}/{total[b]}' for b in total)
            print(f'    {rname:28s} {bands}  ·  {false_big}')
