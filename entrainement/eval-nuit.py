# Pistes pour mieux voir les visages de nuit sans ralentir l'analyse, mesurées sur WIDER FACE (jour) et DARK FACE (nuit) :
#  1. éclaircir les images sombres avant YuNet (presque gratuit) ;
#  2. CenterFace sur une image réduite (plus rapide, au prix des tout petits visages).
# Usage : python entrainement/eval-nuit.py <dossier des banques> <chemin de centerface.onnx>
import importlib.util
import json
import os
import sys
import time

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
DATA, CF = sys.argv[1], sys.argv[2]
spec = importlib.util.spec_from_file_location('ec', os.path.join(HERE, 'eval-centerface.py'))
ec = importlib.util.module_from_spec(spec)
sys.argv = [sys.argv[0], DATA, CF]
spec.loader.exec_module(ec)
ev = ec.ev

DARK = 90   # luminosité moyenne (0-255) en dessous de laquelle l'image est éclaircie


def brighten(img, how):
    if img.mean() >= DARK:
        return img
    if how == 'gamma':
        lut = (np.linspace(0, 1, 256) ** 0.5 * 255).astype(np.uint8)
        return cv2.LUT(img, lut)
    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)
    lab[:, :, 0] = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8)).apply(lab[:, :, 0])
    return cv2.cvtColor(lab, cv2.COLOR_LAB2BGR)


def run(name, rows, key, fn):
    cache = os.path.join(DATA, f'detections-{key}-{name}.json')
    if os.path.exists(cache):
        return json.load(open(cache))
    items = ev.wider() if name == 'wider' else ev.darkface()
    paths = {os.path.basename(p): p for _, p, _ in items}
    out, t0, n = {}, time.time(), 0
    for k, r in enumerate(rows):
        out[r['p']] = fn(cv2.imread(paths[r['p']]))
        if k % 1000 == 0:
            print(f'  {key} {name} : {k}/{len(rows)}', flush=True)
    out['_ms'] = (time.time() - t0) / len(rows) * 1000
    json.dump(out, open(cache, 'w'))
    return out


def cf_small(side):
    def f(img):
        keep = ev.MAX_SIDE
        ev.MAX_SIDE = side
        try:
            return ec.centerface(img)
        finally:
            ev.MAX_SIDE = keep
    return f


def yunet_bright(how):
    return lambda img: (lambda b: {'dets': ev.detect(b), 'lo': ev.low(b)})(brighten(img, how))


if __name__ == '__main__':
    for name in ('darkface', 'wider'):
        rows = ev.collect(name, ev.wider() if name == 'wider' else ev.darkface())
        tot = lambda m: sum(m.values())
        print(f'\n===== {name}')
        m, t, f = ev.evaluate(rows, ev.masks_app)
        print(f'  YuNet, règle du site                ratés {tot(m)}/{tot(t)}  faux grands {f}', flush=True)
        for how in ('gamma', 'clahe'):
            d = run(name, rows, f'yunet-{how}', yunet_bright(how))
            ms = d.pop('_ms')
            m, t, f = ev.evaluate(rows, lambda r: ev.masks_app({**r, 'dets': d[r['p']]['dets'], 'lo': d[r['p']]['lo']}))
            print(f'  YuNet, image sombre éclaircie ({how:5s}) ratés {tot(m)}/{tot(t)}  faux grands {f}  ({ms:.0f} ms/image)', flush=True)
        for side in (960, 640):
            d = run(name, rows, f'centerface-{side}', cf_small(side))
            ms = d.pop('_ms')
            for th in (0.2, 0.3):
                m, t, f = ev.evaluate(rows, lambda r: [ev.grow(x) for x in d[r['p']] if x[4] >= th])
                print(f'  CenterFace {side} px, seuil {th}          ratés {tot(m)}/{tot(t)}  faux grands {f}  ({ms:.0f} ms/image)', flush=True)
