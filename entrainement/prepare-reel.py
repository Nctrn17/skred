# Banc « vidéos réelles » : extraits de 8 s tirés de vraies vidéos, 5 images par extrait où les visages sont
# pré-repérés par un détecteur lent et précis (SCRFD-10G d'InsightFace), puis corrigés à la main (entrainement/annoter-reel.py).
# La mesure elle-même (entrainement/eval-reel.mjs) fait tourner le site sur chaque extrait et regarde, sur ces images,
# si chaque visage est couvert par un masque : suivi d'une image à l'autre compris, comme pour un vrai utilisateur.
# Usage : python entrainement/prepare-reel.py <dossier des banques> <dossier(s) de vidéos>...
# (det_10g.onnx : dans buffalo_l.zip, https://github.com/deepinsight/insightface/releases/tag/v0.7 ; à poser dans <banques>/ref/)
import json
import os
import subprocess
import sys

import cv2
import numpy as np
import onnxruntime as ort

DATA = sys.argv[1]
SOURCES = sys.argv[2:]
OUT = os.path.join(DATA, 'reel')
CLIP_S, TIMES = 8, (1.0, 2.5, 4.0, 5.5, 7.0)
os.makedirs(os.path.join(OUT, 'clips'), exist_ok=True)
os.makedirs(os.path.join(OUT, 'images'), exist_ok=True)
det = ort.InferenceSession(os.path.join(DATA, 'ref', 'det_10g.onnx'), providers=['CPUExecutionProvider'])


def iou(a, b):
    ix = max(0, min(a[0] + a[2], b[0] + b[2]) - max(a[0], b[0]))
    iy = max(0, min(a[1] + a[3], b[1] + b[3]) - max(a[1], b[1]))
    return ix * iy / (a[2] * a[3] + b[2] * b[3] - ix * iy + 1e-9)


def scrfd(img, side, keep=0.4):
    """SCRFD : sorties scores / distances aux bords pour les pas 8, 16, 32, deux ancres par case."""
    h, w = img.shape[:2]
    s = side / max(w, h)
    dw, dh = round(w * s), round(h * s)
    pw, ph = -(-dw // 32) * 32, -(-dh // 32) * 32
    pad = np.zeros((ph, pw, 3), np.uint8)
    pad[:dh, :dw] = cv2.resize(img, (dw, dh))
    blob = cv2.dnn.blobFromImage(pad, 1 / 128, (pw, ph), (127.5, 127.5, 127.5), swapRB=True)
    out = det.run(None, {det.get_inputs()[0].name: blob})
    found = []
    for k, st in enumerate((8, 16, 32)):
        sc, bb = out[k][:, 0], out[k + 3] * st
        gy, gx = np.mgrid[0:ph // st, 0:pw // st]
        cx = np.repeat((gx.reshape(-1) * st), 2)
        cy = np.repeat((gy.reshape(-1) * st), 2)
        for i in np.nonzero(sc >= keep)[0]:
            x1, y1, x2, y2 = cx[i] - bb[i, 0], cy[i] - bb[i, 1], cx[i] + bb[i, 2], cy[i] + bb[i, 3]
            found.append([x1 / s, y1 / s, (x2 - x1) / s, (y2 - y1) / s, float(sc[i])])
    return found


def faces(img):
    found = scrfd(img, max(img.shape[:2]) * 2) + scrfd(img, 640)   # image agrandie (petits visages) + réduite (gros plans)
    found.sort(key=lambda d: -d[4])
    kept = []
    for b in found:
        if all(iou(k, b) < 0.4 for k in kept):
            kept.append(b)
    return [[round(v, 1) for v in d[:4]] + [round(d[4], 3)] for d in kept]


ref = os.path.join(OUT, 'reel.json')
# Images déjà prêtes (pré-repérées ou corrigées à la main) : gardées telles quelles, sans refaire la détection.
old = {e['image']: e for e in json.load(open(ref))} if os.path.exists(ref) else {}
index = []
videos = sorted(os.path.join(d, f) for d in SOURCES for f in os.listdir(d) if f.lower().endswith(('.mp4', '.webm', '.mov')))
for v in videos:
    name = os.path.splitext(os.path.basename(v))[0][:40]
    clip = os.path.join(OUT, 'clips', name + '.mp4')
    dur = float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', v],
                               capture_output=True, text=True).stdout.strip() or 0)
    if dur < CLIP_S:
        continue
    if not os.path.exists(clip):
        start = max(0.0, dur / 2 - CLIP_S / 2)
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', f'{start:.2f}', '-i', v, '-t', str(CLIP_S), '-an',
                        '-vf', "scale='min(1920,iw)':-2", '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', '30', clip], check=True)
    cap = cv2.VideoCapture(clip)
    fps = cap.get(cv2.CAP_PROP_FPS)
    wanted = {round(t * fps): t for t in TIMES}
    i = 0
    while wanted:
        ok, img = cap.read()
        if not ok:
            break
        if i in wanted:
            del wanted[i]
            jpg = f'{name}-{i:03d}.jpg'
            if jpg in old:
                index.append(old[jpg])
                i += 1
                continue
            cv2.imwrite(os.path.join(OUT, 'images', jpg), img, [cv2.IMWRITE_JPEG_QUALITY, 92])
            index.append({'clip': name + '.mp4', 'frame': i, 'image': jpg, 'W': img.shape[1], 'H': img.shape[0],
                          'faces': faces(img), 'checked': False})
        i += 1
    print(name, sum(len(e['faces']) for e in index if e['clip'] == name + '.mp4'), 'visages pré-repérés', flush=True)

index += [e for k, e in old.items() if e.get('checked') and k not in {x['image'] for x in index}]   # jamais perdre une image corrigée
json.dump(index, open(ref, 'w'), indent=0)
print(len(index), 'images,', sum(len(e['faces']) for e in index), 'visages pré-repérés')
