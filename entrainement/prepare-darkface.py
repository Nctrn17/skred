# Prépare l'entraînement de YuNet sur DARK FACE : partage fixe des 6 000 photos (5 000 pour apprendre, 1 000 gardées
# pour mesurer, jamais vues à l'entraînement), conversion des photos d'entraînement en JPEG et des annotations au
# format labelv2 de libfacedetection.train (cadre x1 y1 x2 y2 puis 5 points du visage, ici inconnus : -1).
# Usage : python entrainement/prepare-darkface.py <dossier des banques>
import json
import os
import random
import sys

import cv2

DATA = sys.argv[1] if len(sys.argv) > 1 else 'D:/datasets/skred-eval'
here = os.path.dirname(os.path.abspath(__file__))
labels = os.path.join(DATA, 'darkface', 'label')
images = os.path.join(DATA, 'darkface', 'image')
names = sorted(f[:-4] for f in os.listdir(labels) if f.endswith('.txt'))
random.Random(2026).shuffle(names)
test, train = sorted(names[:1000], key=int), sorted(names[1000:], key=int)
json.dump({'test': test, 'train': train}, open(os.path.join(here, 'darkface-split.json'), 'w'))

out = os.path.join(DATA, 'train-pack')
lines = []
for k, n in enumerate(train):
    img = cv2.imread(os.path.join(images, n + '.png'))
    h, w = img.shape[:2]
    cv2.imwrite(os.path.join(out, 'dark', n + '.jpg'), img, [cv2.IMWRITE_JPEG_QUALITY, 95])
    rows = [r.split() for r in open(os.path.join(labels, n + '.txt')).read().split('\n')[1:] if r.strip()]
    lines.append(f'# dark/{n}.jpg {w} {h}')
    for r in rows:
        x1, y1, x2, y2 = (float(v) for v in r[:4])
        lines.append(f'{x1:.1f} {y1:.1f} {x2:.1f} {y2:.1f} ' + ' '.join(['-1'] * 15))
    if k % 1000 == 0:
        print(k, flush=True)
open(os.path.join(out, 'labelv2-dark.txt'), 'w').write('\n'.join(lines) + '\n')
print('train', len(train), 'test', len(test))
