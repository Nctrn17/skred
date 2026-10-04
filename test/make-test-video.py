# Fabrique les vidéos de test : un visage connu (photo NASA du domaine public, fournie par scikit-image)
# collé à 4 tailles sur un fond, avec du son et de fausses métadonnées de lieu.
# Besoin : pip install scikit-image opencv-python, et ffmpeg dans le PATH.
import os
import subprocess
import cv2
import skimage.data as data

here = os.path.dirname(os.path.abspath(__file__))
os.chdir(here)
cv2.imwrite('astro.png', cv2.cvtColor(data.astronaut(), cv2.COLOR_RGB2BGR))
cv2.imwrite('bg.png', cv2.cvtColor(data.rocket(), cv2.COLOR_RGB2BGR))

graph = (
    "[0:v]scale=-2:1400,crop=720:1280:'40+30*t':'60',fps=30[bg];"
    "[1:v]crop=220:260:140:20,split=4[f0][f1][f2][f3];"
    "[f0]scale=330:390[big];[f1]scale=120:142[mid];[f2]scale=48:57[s1];[f3]scale=34:40[s2];"
    "[bg][big]overlay=x='60+280*abs(sin(t*2.5))':y='120+200*abs(cos(t*1.7))'[a];"
    "[a][mid]overlay=x=80:y=820[b];[b][s1]overlay=x='500+60*sin(t)':y=1000[c];[c][s2]overlay=x=620:y=1180[v]"
)
subprocess.run([
    'ffmpeg', '-y', '-v', 'error', '-loop', '1', '-i', 'bg.png', '-loop', '1', '-i', 'astro.png',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5', '-filter_complex', graph,
    '-map', '[v]', '-map', '2:a', '-t', '5', '-r', '30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    '-metadata', 'location=+48.8566+002.3522/', '-metadata', 'make=TestPhone', 'test2.mp4',
], check=True)
# La même en 1080 x 1920, la taille d'une vidéo de téléphone.
subprocess.run(['ffmpeg', '-y', '-v', 'error', '-i', 'test2.mp4', '-vf', 'scale=1080:1920',
                '-c:v', 'libx264', '-crf', '18', '-c:a', 'copy', 'test3.mp4'], check=True)
# La même de nuit : sombre, bruitée, floue. Le grand visage doit rester masqué même s'il est mal reconnu.
subprocess.run(['ffmpeg', '-y', '-v', 'error', '-i', 'test2.mp4', '-vf',
                'eq=brightness=-0.2:gamma=0.5:saturation=1.2,noise=alls=30:allf=t,tmix=frames=3,boxblur=3:1',
                '-c:v', 'libx264', '-crf', '20', '-c:a', 'copy', '-metadata', 'location=+48.8566+002.3522/',
                '-metadata', 'make=TestPhone', 'test5.mp4'], check=True)
print('test2.mp4, test3.mp4 et test5.mp4 créés')
