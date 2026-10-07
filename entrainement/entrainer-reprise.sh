#!/usr/bin/env bash
# Quatrième entraînement : on repart du modèle en ligne lui-même (poids reconstruits par entrainement/onnx-vers-pth.py,
# BN figée : entrainement/reprise.patch), avec un pas d'apprentissage 10 à 40 fois plus petit qu'avant, pour l'affiner
# sans le refaire. Les essais précédents repartaient des poids publiés de YuNet et finissaient moins bons que lui.
# Données : WIDER FACE + DARK FACE (deux fois) + images de vraies vidéos de manif repérées par SCRFD (pseudo-video.py) ;
# visages douteux effacés dès 0,15 (au lieu de 0,25), pour moins apprendre à ignorer les visages difficiles.
# Deux essais (pas 0,0002 et 0,00005), un modèle exporté toutes les 2 époques : le choix se fait au banc de mesure.
# Serveur : /root/pack = en-ligne.pth, dark/ + labelv2-dark.txt (entrainement/prepare-darkface.py), pseudo-video.py,
# reprise.patch, entrainement-walid.csv, entrainement-agent.csv.
set -e
ulimit -n 65536
export PATH=/root/.deno/bin:$PATH
mkdir -p /root/data/imgs /root/videos
if [ ! -d /root/yt ]; then
  git clone -q --depth 1 https://github.com/ShiqiYu/libfacedetection.train.git /root/yt
  (cd /root/yt && git apply /root/pack/reprise.patch)
fi
cd /root/yt
pip install -q -r requirements.txt > /dev/null 2>&1 || true
pip uninstall -y -q opencv-python onnxruntime > /dev/null 2>&1 || true
pip install -q --force-reinstall --no-deps opencv-python-headless==4.13.0.92 onnxruntime-gpu==1.22.0 > /dev/null 2>&1
pip install -q 'yt-dlp[default]' deno > /dev/null 2>&1
which ffmpeg > /dev/null || (apt-get -qq update > /dev/null && apt-get -qq install -y ffmpeg > /dev/null 2>&1)
[ -s /root/pack/det_10g.onnx ] || (cd /root/pack && curl -sL -o b.zip https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip && python -c 'import zipfile;zipfile.ZipFile("b.zip").extract("det_10g.onnx")' && rm b.zip)
echo "== installation finie $(date)"
[ -d /root/data/imgs/dark ] || mv /root/pack/dark /root/data/imgs/dark
if [ ! -d /root/data/imgs/0--Parade ]; then
  (cd /root/data && curl -sL -o w.zip https://huggingface.co/datasets/CUHK-CSE/wider_face/resolve/main/data/WIDER_train.zip && python -c 'import zipfile;zipfile.ZipFile("w.zip").extractall(".")' && mv WIDER_train/images/* imgs/ && rm w.zip && echo "== WIDER prêt $(date)") &
fi
if [ ! -s /root/data/labelv2-video.txt ]; then
  for l in walid agent; do
    DOUTE=0.15 python /root/pack/pseudo-video.py /root/pack/entrainement-$l.csv /root/pack/det_10g.onnx /root/data/imgs /root/data/video-$l.tmp > /root/pseudo-$l.log 2>&1 &
  done
  wait
  cat /root/data/video-walid.tmp /root/data/video-agent.tmp > /root/data/labelv2-video.txt
fi
wait
echo "== Images de vidéos : $(grep -c '^#' /root/data/labelv2-video.txt) $(date)"
cat data/widerface/labelv2/train/labelv2.txt /root/pack/labelv2-dark.txt /root/pack/labelv2-dark.txt /root/data/labelv2-video.txt > /root/data/labelv2-train.txt
for lr in 0.0002 0.00005; do
  W=work_dirs/reprise-$lr
  [ -s $W/fini ] && continue
  python -m yunet_train.cli.train --variant yunet_n --init-weights /root/pack/en-ligne.pth --freeze-bn \
    --ann-file /root/data/labelv2-train.txt --img-prefix /root/data/imgs \
    --epochs 10 --lr $lr --lr-steps 8 --warmup-iters 300 --batch-size 32 --workers 16 \
    --eval-interval 0 --checkpoint-interval 2 --no-tensorboard --work-dir $W
  for p in $W/epoch_*.pth; do
    python -m yunet_train.cli.export_onnx $p --variant yunet_n --dynamic-export --output-file ${p%.pth}.onnx
  done
  touch $W/fini
done
echo "== Fini $(date)"
