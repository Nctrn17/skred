#!/usr/bin/env bash
# Expérience « deux moitiés » (entrainement/prepare-ab.py) : même recette que entrainer-reprise.sh (on repart du modèle en
# ligne, BN figée, pas 0,00005, 10 époques), sans les pseudo-étiquettes de vidéos. Quatre entraînements à la suite :
#  - temoin : WIDER + DARK FACE ×2 seulement, pour séparer l'effet des images corrigées de celui du simple réentraînement ;
#  - A, B : en plus, les images corrigées de la moitié A (ou B), répétées 10 fois (sinon ~90 images parmi ~23 000 ne pèsent rien) ;
#  - demiA : la moitié des extraits de A, même répétition, pour voir si le gain grandit avec le nombre d'images.
# Serveur : /root/pack = en-ligne.pth, reprise.patch, dark/ + labelv2-dark.txt, reel/ + labelv2-reel-{A,B,demiA}.txt.
set -e
ulimit -n 65536
REPEAT=10
mkdir -p /root/data/imgs
if [ ! -d /root/yt ]; then
  git clone -q --depth 1 https://github.com/ShiqiYu/libfacedetection.train.git /root/yt
  (cd /root/yt && git apply /root/pack/reprise.patch)
fi
cd /root/yt
pip install -q -r requirements.txt > /dev/null 2>&1 || true
pip uninstall -y -q opencv-python onnxruntime > /dev/null 2>&1 || true
pip install -q --force-reinstall --no-deps opencv-python-headless==4.13.0.92 onnxruntime-gpu==1.22.0 > /dev/null 2>&1
echo "== installation finie $(date)"
[ -d /root/data/imgs/dark ] || mv /root/pack/dark /root/data/imgs/dark
[ -d /root/data/imgs/reel ] || mv /root/pack/reel /root/data/imgs/reel
if [ ! -d /root/data/imgs/0--Parade ]; then
  (cd /root/data && curl -sL -o w.zip https://huggingface.co/datasets/CUHK-CSE/wider_face/resolve/main/data/WIDER_train.zip && python -c 'import zipfile;zipfile.ZipFile("w.zip").extractall(".")' && mv WIDER_train/images/* imgs/ && rm w.zip)
fi
echo "== WIDER prêt $(date)"
cat data/widerface/labelv2/train/labelv2.txt /root/pack/labelv2-dark.txt /root/pack/labelv2-dark.txt > /root/data/labelv2-temoin.txt
for p in A B demiA; do
  cp /root/data/labelv2-temoin.txt /root/data/labelv2-$p.txt
  for i in $(seq $REPEAT); do cat /root/pack/labelv2-reel-$p.txt >> /root/data/labelv2-$p.txt; done
done
for p in temoin A B demiA; do
  W=work_dirs/ab-$p
  [ -s $W/fini ] && continue
  echo "== $p : $(grep -c '^#' /root/data/labelv2-$p.txt) images $(date)"
  python -m yunet_train.cli.train --variant yunet_n --init-weights /root/pack/en-ligne.pth --freeze-bn \
    --ann-file /root/data/labelv2-$p.txt --img-prefix /root/data/imgs \
    --epochs 10 --lr 0.00005 --lr-steps 8 --warmup-iters 300 --batch-size 32 --workers 16 \
    --eval-interval 0 --checkpoint-interval 2 --no-tensorboard --work-dir $W
  for c in $W/epoch_*.pth; do
    python -m yunet_train.cli.export_onnx $c --variant yunet_n --dynamic-export --output-file ${c%.pth}.onnx
  done
  touch $W/fini
done
echo "== Fini $(date)"
