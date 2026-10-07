#!/usr/bin/env bash
# Troisième entraînement : comme entrainement/entrainer-nuit.sh, plus des images de vraies vidéos de manif sous licence libre,
# repérées automatiquement par SCRFD (entrainement/pseudo-video.py). Serveur préparé comme pour entrainement/entrainer-v2.sh, avec en plus
# /root/pack/entrainement-sources.csv et pseudo-video.py, et yt-dlp installé.
set -e
ulimit -n 65536
cd /root/yt
[ -d /root/data/imgs/dark ] || mv /root/pack/dark /root/data/imgs/dark
mkdir -p /root/videos
if [ ! -s /root/data/labelv2-video.txt ]; then
  echo "== Images de vidéos réelles"
  python /root/pack/pseudo-video.py /root/pack/entrainement-sources.csv /root/pack/det_10g.onnx /root/data/imgs /root/data/labelv2-video.tmp
  mv /root/data/labelv2-video.tmp /root/data/labelv2-video.txt
fi
echo "== Images de vidéos : $(grep -c '^#' /root/data/labelv2-video.txt)"
cat data/widerface/labelv2/train/labelv2.txt /root/pack/labelv2-dark.txt /root/pack/labelv2-dark.txt /root/data/labelv2-video.txt > /root/data/labelv2-train-video.txt
python -m yunet_train.cli.train --variant yunet_n --init-weights weights/yunet_n.pth \
  --ann-file /root/data/labelv2-train-video.txt --img-prefix /root/data/imgs \
  --epochs 40 --lr 0.002 --lr-steps 30 36 --warmup-iters 500 --batch-size 32 --workers 16 \
  --eval-interval 0 --checkpoint-interval 5 --no-tensorboard --work-dir work_dirs/video
python -m yunet_train.cli.export_onnx work_dirs/video/latest.pth --variant yunet_n --dynamic-export --output-file work_dirs/video/yunet_n-video.onnx
echo "== Fini"
