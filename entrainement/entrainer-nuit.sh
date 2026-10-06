#!/usr/bin/env bash
# Entraînement du modèle de skred (models/yunet.onnx) : YuNet_n de libfacedetection.train, repris de ses poids publiés
# et réentraîné sur WIDER FACE (jour) + DARK FACE (nuit, 5 000 photos ; 1 000 gardées à part pour la mesure).
# Lancé sur un serveur avec carte graphique (une RTX louée, environ 2 h) :
#   git clone https://github.com/ShiqiYu/libfacedetection.train.git /root/yt, avec une petite retouche de
#   yunet_train/cli/train.py : option --init-weights, qui charge les poids publiés (weights/yunet_n.pth) avant d'apprendre ;
#   /root/pack : sortie de entrainement/prepare-darkface.py (photos DARK FACE en JPEG, annotations labelv2-dark.txt).
set -e
cd /root/yt
mkdir -p /root/data/imgs
if [ ! -d /root/data/imgs/0--Parade ]; then
  echo "== Téléchargement de WIDER FACE (photos d'entraînement, 1,4 Go)"
  curl -sL -o /root/data/wider_train.zip https://huggingface.co/datasets/CUHK-CSE/wider_face/resolve/main/data/WIDER_train.zip
  unzip -q /root/data/wider_train.zip -d /root/data && mv /root/data/WIDER_train/images/* /root/data/imgs/ && rm /root/data/wider_train.zip
fi
[ -d /root/data/imgs/dark ] || mv /root/pack/dark /root/data/imgs/dark
# Annotations : WIDER FACE telles quelles, DARK FACE deux fois, pour équilibrer jour et nuit.
cat data/widerface/labelv2/train/labelv2.txt /root/pack/labelv2-dark.txt /root/pack/labelv2-dark.txt > /root/data/labelv2-train.txt
echo "== Photos : $(grep -c '^#' /root/data/labelv2-train.txt)"
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader
python -m yunet_train.cli.train --variant yunet_n --init-weights weights/yunet_n.pth \
  --ann-file /root/data/labelv2-train.txt --img-prefix /root/data/imgs \
  --epochs 40 --lr 0.002 --lr-steps 30 36 --warmup-iters 500 --batch-size 32 --workers 10 \
  --eval-interval 0 --checkpoint-interval 5 --no-tensorboard --work-dir work_dirs/nuit
python -m yunet_train.cli.export_onnx work_dirs/nuit/latest.pth --variant yunet_n --dynamic-export --output-file work_dirs/nuit/yunet_n_nuit.onnx
echo "== Fini : work_dirs/nuit/yunet_n_nuit.onnx"
