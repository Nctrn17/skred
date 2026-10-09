# Expérience « deux moitiés » : les images de nuit corrigées à la main (reel.json) aident-elles le modèle ?
# Les 36 extraits de nuit corrigés sont partagés en deux moitiés A et B (par extrait, jamais par image : les 5 images
# d'un extrait se ressemblent trop), de poids égal en visages comptés par le banc. On affine le modèle en ligne avec A,
# on mesure sur B (et inversement) ; « demi-A » (la moitié des extraits de A) dit si le gain grandit avec les images.
# Écrit entrainement/reel-ab.json (le partage) et, dans <banques>/train-pack/, les images (reel/) et les annotations
# labelv2-reel-{A,B,demiA}.txt au format de entrainement/prepare-darkface.py (points du visage inconnus : -1).
# Usage : python entrainement/prepare-ab.py <dossier des banques>
import json
import os
import shutil
import sys

DATA = sys.argv[1] if len(sys.argv) > 1 else 'D:/datasets/skred-eval'
here = os.path.dirname(os.path.abspath(__file__))
ref = [e for e in json.load(open(os.path.join(DATA, 'reel', 'reel.json'))) if e['checked']]
# Visages comptés par le banc vidéo pour chaque extrait (ceux d'au moins 3 % du petit côté).
counted = {c: v['visages'] for c, v in json.load(open(os.path.join(DATA, 'reel', 'resultat-nuit-main-0810.json')))['perClip'].items()}


def halve(clips):
    """Chaque extrait, du plus chargé au moins chargé, va dans la moitié la plus légère."""
    halves = ([], [])
    for c in sorted(clips, key=lambda c: (-counted[c], c)):
        min(halves, key=lambda h: sum(counted[x] for x in h)).append(c)
    return sorted(halves[0]), sorted(halves[1])


A, B = halve({e['clip'] for e in ref})
split = {'A': A, 'B': B, 'demiA': halve(A)[0]}
json.dump(split, open(os.path.join(here, 'reel-ab.json'), 'w'), indent=1)

out = os.path.join(DATA, 'train-pack')
os.makedirs(os.path.join(out, 'reel'), exist_ok=True)
for name, part in split.items():
    lines = []
    for e in ref:
        if e['clip'] not in part:
            continue
        shutil.copy(os.path.join(DATA, 'reel', 'images', e['image']), os.path.join(out, 'reel', e['image']))
        lines.append(f"# reel/{e['image']} {e['W']} {e['H']}")
        for f in e['faces']:
            x, y, w, h = f[:4]
            lines.append(f'{x:.1f} {y:.1f} {x + w:.1f} {y + h:.1f} ' + ' '.join(['-1'] * 15))
    open(os.path.join(out, f'labelv2-reel-{name}.txt'), 'w').write('\n'.join(lines) + '\n')
    print(name, len(part), 'extraits', sum(counted[c] for c in part), 'visages comptés',
          sum(len(e['faces']) for e in ref if e['clip'] in part), 'visages en tout')
