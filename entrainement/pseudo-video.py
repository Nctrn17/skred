# Images d'entraînement tirées de vraies vidéos de manif (sous licence libre, liste dans entrainement-sources.csv),
# repérées par un détecteur lent et précis (SCRFD-10G) au lieu d'annotateurs. Une image toutes les PAS secondes.
# Visage très sûr (>= SURE) : annoté. Visage douteux (entre DOUTE et SURE) : effacé de l'image (gris moyen), pour que
# le modèle n'apprenne ni à le voir ni à l'ignorer. Tourne sur le serveur d'entraînement (carte graphique).
# Usage : python pseudo-video.py <sources.csv> <det_10g.onnx> <dossier des photos> <labelv2 de sortie>
import csv
import os
import re
import subprocess
import sys

import cv2
import numpy as np
import onnxruntime as ort

SRC, MODEL, IMGS, DST = sys.argv[1:5]
PAS, SURE, DOUTE, MIN_PX, MAX_IMG = 2.0, 0.6, 0.25, 8, 300
DOUTE = float(os.environ.get('DOUTE', DOUTE))   # plus bas : plus de visages incertains effacés plutôt que comptés comme fond
ort.preload_dlls()
det = ort.InferenceSession(MODEL, providers=['CUDAExecutionProvider', 'CPUExecutionProvider'])
name = det.get_inputs()[0].name
os.makedirs(os.path.join(IMGS, 'video'), exist_ok=True)


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
        for i in np.nonzero(sc >= DOUTE)[0]:
            box = [(cx[i] - bb[i, 0]) / s, (cy[i] - bb[i, 1]) / s, (cx[i] + bb[i, 2]) / s, (cy[i] + bb[i, 3]) / s]
            pts = [((cx[i] + kp[i, 2 * j]) / s, (cy[i] + kp[i, 2 * j + 1]) / s) for j in range(5)]
            found.append((float(sc[i]), box, pts))
    return found


def iou(a, b):
    ix = max(0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    return ix * iy / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - ix * iy + 1e-9)


def faces(img):
    found = sorted(scrfd(img, min(3840, max(img.shape[:2]) * 2)) + scrfd(img, 640), key=lambda c: -c[0])
    kept = []
    for c in found:
        if all(iou(k[1], c[1]) < 0.4 for k in kept):
            kept.append(c)
    return kept


rows = list(csv.DictReader(open(SRC, encoding='utf-8')))
total = 0
with open(DST, 'w') as out:
    for n, r in enumerate(rows):
        key = re.sub(r'[^A-Za-z0-9_-]', '_', r['id_ou_titre'])[:40]   # nom stable : plusieurs listes peuvent se suivre
        vid = f'/root/videos/{key}.mp4'
        if not os.path.exists(vid):
            if r['source'] == 'youtube':
                cmd = ['yt-dlp', '-q', '-f', 'bv*[height<=1080][ext=mp4]/bv*[height<=1080]/b', '--remux-video', 'mp4', '-o', vid, r['url']]
            else:
                cmd = ['curl', '-sL', '-A', 'skred-entrainement/1.0', '-o', vid + '.src', r['url']]
            if subprocess.run(cmd).returncode != 0:
                print('échec', r['url'], flush=True)
                continue
            if r['source'] != 'youtube':
                subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', vid + '.src', '-an', '-c:v', 'libx264', '-crf', '20', vid])
                os.remove(vid + '.src')
        cap = cv2.VideoCapture(vid)
        fps = cap.get(cv2.CAP_PROP_FPS) or 30
        # Au plus MAX_IMG images par vidéo, pour qu'une longue vidéo ne pèse pas plus que les autres.
        step, i, kept, prev = max(1, round(fps * PAS), int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) // MAX_IMG), 0, 0, None
        while True:
            ok = cap.grab()
            if not ok:
                break
            if i % step == 0:
                ok, img = cap.retrieve()
                if ok:
                    small = cv2.resize(img, (64, 36)).astype(np.float32)
                    if prev is None or np.abs(small - prev).mean() > 4:   # saute les images presque identiques
                        prev = small
                        sure, doubt = [], []
                        for sc, b, pts in faces(img):
                            if min(b[2] - b[0], b[3] - b[1]) < MIN_PX:
                                continue
                            (sure if sc >= SURE else doubt).append((b, pts))
                        if sure:
                            mean = img.reshape(-1, 3).mean(0)
                            for b, _ in doubt:
                                x1, y1, x2, y2 = [int(round(v)) for v in b]
                                img[max(0, y1):max(0, y2), max(0, x1):max(0, x2)] = mean
                            rel = f'video/{key}-{i:06d}.jpg'
                            cv2.imwrite(os.path.join(IMGS, rel), img, [cv2.IMWRITE_JPEG_QUALITY, 90])
                            out.write(f'# {rel} {img.shape[1]} {img.shape[0]}\n')
                            for b, pts in sure:
                                out.write(' '.join(f'{v:.1f}' for v in b) + ' ' + ' '.join(f'{x:.1f} {y:.1f} 0' for x, y in pts) + '\n')
                            kept += 1
                            total += len(sure)
            i += 1
        print(f'{n + 1}/{len(rows)} {r["url"][:60]} : {kept} images, {total} visages au total', flush=True)
