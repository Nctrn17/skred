# Modèle de détection : YuNet (OpenCV Zoo, licence MIT)

Source : https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet
(fichier `face_detection_yunet_2023mar.onnx`).

Le fichier d'origine n'accepte que des images de 640 x 640. `yunet.onnx` est le même modèle,
avec seulement les dimensions d'entrée et de sortie déclarées libres :

```python
import onnx
m = onnx.load('face_detection_yunet_2023mar.onnx')
d = m.graph.input[0].type.tensor_type.shape.dim
d[2].dim_param = 'h'; d[3].dim_param = 'w'
for out in m.graph.output:
    out.type.tensor_type.shape.dim[1].dim_param = 'n'
del m.graph.value_info[:]
onnx.save(m, 'yunet.onnx')
```

Le décodage des sorties (dans `detector.js`) suit `modules/objdetect/src/face_detect.cpp` d'OpenCV.
