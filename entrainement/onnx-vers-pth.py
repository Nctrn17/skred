# Reconstruit les poids PyTorch du modèle du site (models/yunet.onnx) pour pouvoir le réentraîner : ses fichiers
# d'entraînement sont perdus. À l'export, chaque normalisation (BN) a été fondue dans la convolution d'avant : on remet
# ces poids fondus dans la convolution et une BN neutre derrière (à garder figée, voir entrainement/reprise.patch).
# Vérifie à la fin que le modèle reconstruit donne les mêmes sorties que l'ONNX.
# Usage : PYTHONPATH=<libfacedetection.train> python onnx-vers-pth.py models/yunet.onnx en-ligne.pth
import sys, onnx, numpy as np, torch, onnxruntime as ort
from onnx import numpy_helper
from yunet_train.tasks.face import build_yunet
src, dst = sys.argv[1], sys.argv[2]
g = onnx.load(src).graph
init = {i.name: numpy_helper.to_array(i) for i in g.initializer}
onnx_convs = [n for n in g.node if n.op_type == 'Conv']
model = build_yunet('yunet_n'); model.eval()
# convolutions dans l'ordre d'exécution, et la BN qui suit chacune (si elle existe)
order = []
hooks = [m.register_forward_hook(lambda mod, i, o, name=name: order.append(name)) for name, m in model.named_modules() if isinstance(m, torch.nn.Conv2d)]
model(torch.zeros(1, 3, 160, 160)); [h.remove() for h in hooks]
mods = dict(model.named_modules())
def bn_after(name):
    parent, leaf = name.rsplit('.', 1)
    p = mods[parent]
    if type(p).__name__ == 'ConvDPUnit' and leaf == 'conv2' and p.withBNRelu: return parent + '.bn'
    if type(p).__name__ == 'Conv_head' and leaf == 'conv1': return parent + '.bn1'
    return None
assert len(order) == len(onnx_convs), (len(order), len(onnx_convs))
sd = model.state_dict()
for name, node in zip(order, onnx_convs):
    W, b = init[node.input[1]], init[node.input[2]]
    assert tuple(W.shape) == tuple(sd[name + '.weight'].shape), name
    sd[name + '.weight'] = torch.from_numpy(W.copy()); sd[name + '.bias'] = torch.from_numpy(b.copy())
    bn = bn_after(name)
    if bn:
        eps = mods[bn].eps
        sd[bn + '.weight'] = torch.ones_like(sd[bn + '.weight']); sd[bn + '.bias'] = torch.zeros_like(sd[bn + '.bias'])
        sd[bn + '.running_mean'] = torch.zeros_like(sd[bn + '.running_mean']); sd[bn + '.running_var'] = torch.full_like(sd[bn + '.running_var'], 1 - eps)
    else:
        assert not node.input[1].startswith('onnx::'), name
model.load_state_dict(sd); model.eval()
torch.save({'state_dict': model.state_dict(), 'meta': {'source': src}}, dst)
# vérification : mêmes sorties que l'ONNX
sess = ort.InferenceSession(src)
x = np.random.RandomState(0).uniform(0, 255, (1, 3, 320, 480)).astype(np.float32)
ref = sess.run(None, {sess.get_inputs()[0].name: x})
with torch.no_grad(): cls, bbox, obj, kps = model(torch.from_numpy(x))
names = [o.name for o in sess.get_outputs()]
mine = {}
for k, st in enumerate((8, 16, 32)):
    mine[f'cls_{st}'] = cls[k].permute(0, 2, 3, 1).reshape(1, -1, 1).sigmoid().numpy()
    mine[f'obj_{st}'] = obj[k].permute(0, 2, 3, 1).reshape(1, -1, 1).sigmoid().numpy()
    mine[f'bbox_{st}'] = bbox[k].permute(0, 2, 3, 1).reshape(1, -1, 4).numpy()
print('écart max', max(float(np.abs(mine[n] - r).max()) for n, r in zip(names, ref) if n in mine))
