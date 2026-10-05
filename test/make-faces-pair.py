# Fabrique deux vidéos identiques au pixel près, sauf l'intérieur des visages (couleurs inversées dans la seconde).
# Elles servent au test « sans trace » : skred doit produire exactement le même fichier pour les deux,
# preuve que rien du visage d'origine ne passe dans le fichier masqué.
# Même scène que make-test-video.py. Encodage sans perte (VP9), pour que seuls les visages diffèrent.
# Zone inversée : 24-58 % de la largeur, 25-55 % de la hauteur de chaque photo collée (front, yeux, nez, bouche).
import os
import subprocess

here = os.path.dirname(os.path.abspath(__file__))
os.chdir(here)
sizes = [(330, 390), (120, 142), (48, 57), (34, 40)]
pos = [("60+280*abs(sin(t*2.5))", "120+200*abs(cos(t*1.7))"), ("80", "820"), ("500+60*sin(t)", "1000"), ("620", "1180")]

def build(negate, out):
    g = "[0:v]scale=-2:1400,crop=720:1280:'40+30*t':'60',fps=30[bg];[1:v]crop=220:260:140:20,split=8[f0][f1][f2][f3][g0][g1][g2][g3];"
    last = 'bg'
    for i, (w, h) in enumerate(sizes):
        x0, y0, cw, ch = round(w * 0.24), round(h * 0.25), round(w * 0.34), round(h * 0.30)
        g += f"[f{i}]scale={w}:{h}[p{i}];[g{i}]scale={w}:{h},crop={cw}:{ch}:{x0}:{y0}{',negate' if negate else ''}[n{i}];"
        x, y = pos[i]
        g += f"[{last}][p{i}]overlay=x='{x}':y='{y}'[a{i}];[a{i}][n{i}]overlay=x='{x}+{x0}':y='{y}+{y0}'[b{i}];"
        last = f'b{i}'
    g = g[:-len(f'[{last}];')] + '[v]'
    subprocess.run(['ffmpeg', '-y', '-v', 'error', '-loop', '1', '-i', 'bg.png', '-loop', '1', '-i', 'astro.png',
                    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5', '-filter_complex', g, '-map', '[v]', '-map', '2:a',
                    '-t', '5', '-r', '30', '-c:v', 'libvpx-vp9', '-lossless', '1', '-pix_fmt', 'yuv420p', '-c:a', 'libopus', out], check=True)

build(False, 'visage-a.webm')
build(True, 'visage-b.webm')
print('visage-a.webm et visage-b.webm créés')
