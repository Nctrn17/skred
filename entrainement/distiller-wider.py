# Complète les annotations d'entraînement (format labelv2 de libfacedetection.train) avec les visages que les
# annotateurs ont oubliés, repérés par un détecteur lent et précis (SCRFD-10G d'InsightFace). Un visage n'est ajouté
# que s'il est très sûr (SCORE) et ne recouvre aucun visage déjà annoté. Tourne sur carte graphique (onnxruntime-gpu).
# Usage : python distiller-wider.py <labelv2 d'entrée> <dossier des photos> <det_10g.onnx> <labelv2 de sortie>
import sys

import cv2
import numpy as np
import onnxruntime as ort

SRC, IMGS, MODEL, DST = sys.argv[1:5]
SCORE = 0.7
ort.preload_dlls()   # bibliothèques CUDA fournies par PyTorch
det = ort.InferenceSession(MODEL, providers=['CUDAExecutionProvider', 'CPUExecutionProvider'])
name = det.get_inputs()[0].name


def iou(a, b):
    ix = max(0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    return ix * iy / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - ix * iy + 1e-9)


def scrfd(img, side):
    h, w = img.shape[:2]
    s = side / max(w, h)
    dw, dh = round(w * s), round(h * s)
    pw, ph = -(-dw // 32) * 32, -(-dh // 32) * 32
    pad = np.zeros((ph, pw, 3), np.uint8)
    pad[:dh, :dw] = cv2.resize(img, (dw, dh))
    out = det.run(None, {name: cv2.dnn.blobFromImage(pad, 1 / 128, (pw, ph), (127.5, 127.5, 127.5), swapRB=True)})
    found = []
    for k, st in enumerate((8, 16, 32)):
        sc, bb, kp = out[k][:, 0], out[k + 3] * st, out[k + 6] * st
        gy, gx = np.mgrid[0:ph // st, 0:pw // st]
        cx, cy = np.repeat(gx.reshape(-1) * st, 2), np.repeat(gy.reshape(-1) * st, 2)
        for i in np.nonzero(sc >= SCORE)[0]:
            box = [(cx[i] - bb[i, 0]) / s, (cy[i] - bb[i, 1]) / s, (cx[i] + bb[i, 2]) / s, (cy[i] + bb[i, 3]) / s]
            pts = [((cx[i] + kp[i, 2 * j]) / s, (cy[i] + kp[i, 2 * j + 1]) / s) for j in range(5)]
            found.append((float(sc[i]), box, pts))
    return found


blocks, cur = [], None
for line in open(SRC):
    if line.startswith('#'):
        cur = [line, []]
        blocks.append(cur)
    elif line.strip():
        cur[1].append(line)

added = 0
with open(DST, 'w') as f:
    for n, (head, rows) in enumerate(blocks):
        path = head[2:].rsplit(' ', 2)[0]
        img = cv2.imread(f'{IMGS}/{path}')
        gt = [[float(v) for v in r.split()[:4]] for r in rows]
        new = []
        if img is not None:
            cands = sorted(scrfd(img, min(4096, max(img.shape[:2]) * 2)) + scrfd(img, 640), key=lambda c: -c[0])
            for sc, box, pts in cands:
                if box[2] - box[0] < 6 or box[3] - box[1] < 6:
                    continue
                if any(iou(box, g) > 0.2 or (g[0] <= (box[0] + box[2]) / 2 <= g[2] and g[1] <= (box[1] + box[3]) / 2 <= g[3]) for g in gt + new):
                    continue
                new.append(box)
                rows.append(' '.join(f'{v:.1f}' for v in box) + ' ' + ' '.join(f'{x:.1f} {y:.1f} 0' for x, y in pts) + '\n')
        added += len(new)
        f.write(head)
        f.writelines(rows)
        if n % 1000 == 0:
            print(f'{n}/{len(blocks)} photos, {added} visages ajoutés', flush=True)
print(f'fini : {len(blocks)} photos, {added} visages ajoutés')
