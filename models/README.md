# Modèle de détection : YuNet_n réentraîné pour la nuit (licence BSD-3)

Base : YuNet_n de [libfacedetection.train](https://github.com/ShiqiYu/libfacedetection.train) (Shiqi Yu, BSD-3,
`LICENSE-yunet.txt`), même famille et mêmes sorties que le YuNet d'OpenCV.

`yunet.onnx` part des poids publiés (`weights/yunet_n.pth`) et a été réentraîné 40 passes sur WIDER FACE
(photos de jour) et DARK FACE (photos de nuit). Recette complète : `test/entrainer-nuit.sh`, après
`test/prepare-darkface.py`. 1 000 photos de DARK FACE (`test/darkface-split.json`) n'ont jamais servi à
l'entraînement et servent à la mesure.

Mesuré avec la règle du site (`test/eval-faces.py`), contre l'ancien modèle (YuNet 2023mar d'OpenCV Zoo) :

| | Visages ratés de nuit (1 287) | Visages ratés de jour (14 954) | Grands masques sans visage, jour |
|---|---|---|---|
| Ancien modèle | 185 | 1 016 | 326 |
| Celui-ci | 64 | 938 | 332 |

Le décodage des sorties (dans `detector.js`) suit `modules/objdetect/src/face_detect.cpp` d'OpenCV.
