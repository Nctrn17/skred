#!/usr/bin/env bash
# Deuxième entraînement : comme entrainement/entrainer-nuit.sh, mais les annotations de WIDER FACE sont d'abord complétées
# des visages oubliés par les annotateurs (entrainement/distiller-wider.py, détecteur SCRFD-10G), puis deux modèles sont
# entraînés : YuNet_n (même taille que celui du site) et YuNet_s (un peu plus gros).
# Serveur : /root/yt = libfacedetection.train + entrainement/init-weights.patch ; /root/pack = sortie de entrainement/prepare-darkface.py,
# det_10g.onnx et distiller-wider.py ; /root/data/imgs = photos d'entraînement de WIDER FACE.
set -e
ulimit -n 65536   # sinon les fils de chargement des photos manquent de descripteurs (« received 0 items of ancdata »)
cd /root/yt
[ -d /root/data/imgs/dark ] || mv /root/pack/dark /root/data/imgs/dark
if [ ! -s /root/data/labelv2-wider-plus.txt ]; then
  echo "== Visages oubliés de WIDER FACE"
  python /root/pack/distiller-wider.py data/widerface/labelv2/train/labelv2.txt /root/data/imgs /root/pack/det_10g.onnx /root/data/labelv2-wider-plus.tmp
  mv /root/data/labelv2-wider-plus.tmp /root/data/labelv2-wider-plus.txt
fi
cat /root/data/labelv2-wider-plus.txt /root/pack/labelv2-dark.txt /root/pack/labelv2-dark.txt > /root/data/labelv2-train-plus.txt
for v in yunet_n yunet_s; do
  [ -s work_dirs/$v-plus/$v-plus.onnx ] && continue
  echo "== Entraînement $v"
  python -m yunet_train.cli.train --variant $v --init-weights weights/$v.pth \
    --ann-file /root/data/labelv2-train-plus.txt --img-prefix /root/data/imgs \
    --epochs 40 --lr 0.002 --lr-steps 30 36 --warmup-iters 500 --batch-size 32 --workers 16 \
    --eval-interval 0 --checkpoint-interval 5 --no-tensorboard --work-dir work_dirs/$v-plus
  python -m yunet_train.cli.export_onnx work_dirs/$v-plus/latest.pth --variant $v --dynamic-export --output-file work_dirs/$v-plus/$v-plus.onnx
done
echo "== Fini"
