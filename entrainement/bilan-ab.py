# Bilan de l'expérience « deux moitiés » (entrainement/prepare-ab.py, entrainer-ab.sh, mesures par eval-reel.mjs) :
# pour chaque modèle et chaque seuil, visages ratés et surface masquée sans visage, comptés séparément sur les extraits
# de A et de B. Ce qui compte : un modèle affiné avec A, mesuré sur B (jamais vu), contre le modèle en ligne et contre
# le témoin (même réentraînement sans images corrigées), à surface sans visage comparable.
# Usage : python entrainement/bilan-ab.py <dossier des banques>
import json
import os
import sys

DATA = sys.argv[1] if len(sys.argv) > 1 else 'D:/datasets/skred-eval'
here = os.path.dirname(os.path.abspath(__file__))
split = json.load(open(os.path.join(here, 'reel-ab.json')))
ref = {e['image']: e for e in json.load(open(os.path.join(DATA, 'reel', 'reel.json'))) if e['checked']}
R = os.path.join(DATA, 'reel')


def off_area(e, masks):
    """Part de l'image masquée loin de tout visage repéré : même calcul que areas() dans eval-reel.mjs."""
    G, o = 120, 0
    for gy in range(G):
        for gx in range(G):
            x, y = (gx + 0.5) * e['W'] / G, (gy + 0.5) * e['H'] / G
            if not any(m[0] <= x <= m[0] + m[2] and m[1] <= y <= m[1] + m[3] for m in masks):
                continue
            if not any(f[0] - f[2] / 2 <= x <= f[0] + 1.5 * f[2] and f[1] - f[3] / 2 <= y <= f[1] + 1.5 * f[3] for f in e['faces']):
                o += 1
    return o / (G * G)


def half(name, part):
    res = json.load(open(os.path.join(R, f'resultat-{name}.json')))
    det = json.load(open(os.path.join(R, f'masques-{name}.json')))
    missed = sum(v['rates'] for c, v in res['perClip'].items() if c in part)
    faces = sum(v['visages'] for c, v in res['perClip'].items() if c in part)
    offs = [off_area(ref[d['image']], d['masks']) for d in det if ref[d['image']]['clip'] in part]
    return missed, faces, 100 * sum(offs) / len(offs)


if __name__ == '__main__':
    print('ratés / visages · surface sans visage (%)   [A : extraits de A ; B : extraits de B]')
    for model in ('enligne', 'temoin', 'A', 'B', 'demiA'):
        for t in ('seuil03', 'seuil035', 'seuil04', 'seuil05'):
            name = f'ab-{model}-{t}'
            if not os.path.exists(os.path.join(R, f'resultat-{name}.json')):
                continue
            a, b = half(name, split['A']), half(name, split['B'])
            print(f'  {model:8s} {t:9s}  A : {a[0]:3d}/{a[1]} · {a[2]:4.1f} %   B : {b[0]:3d}/{b[1]} · {b[2]:4.1f} %', flush=True)
