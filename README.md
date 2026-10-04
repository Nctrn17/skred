# skred

Masquer les visages d'une vidéo ou d'une photo avant de la poster, directement dans le navigateur du téléphone.
Rien n'est envoyé à un serveur : pas de compte, pas de statistiques, pas de fichier tiers chargé depuis un autre site.

## Pourquoi

Les vidéos de blocus et de manifestation servent à identifier les personnes filmées. Un flou ou une mosaïque
peuvent être défaits par une IA. Un carré plein, non : il n'y a plus d'image dessous.

## Ce que fait l'outil

1. Tu choisis une vidéo ou une photo.
2. La vidéo est analysée 30 fois par seconde, et un carré noir (ou un émoji posé sur un carré noir) est placé sur chaque visage, sur toutes les images.
3. Tu vérifies : tu ajoutes un masque là où un visage a été raté, tu retires un masque posé à tort.
4. Le fichier est entièrement refait : le lieu, la date et le modèle du téléphone du fichier d'origine disparaissent.

## Ce que l'outil ne fait pas

- Il ne cache ni les vêtements, ni les tatouages, ni la voix, ni le lieu.
- Il peut rater un visage. La vérification à l'œil avant de poster reste indispensable.
- Il ne promet pas une protection totale.

## Comment c'est fait

- Site statique, sans étape de construction : `index.html`, `style.css`, `app.js`.
- Détection des visages : modèle YuNet (OpenCV), exécuté par ONNX Runtime Web (`detector.js`, `detect-worker.js`),
  sur plusieurs cœurs en parallèle.
- Suivi : une seule case par visage d'une image à l'autre, agrandie de 30 %, prolongée de quelques images avant et après.
- Export rapide : le fichier d'origine est relu image par image, chaque image est masquée puis réencodée
  par l'encodeur du téléphone (WebCodecs, via Mediabunny). Plus rapide que la durée de la vidéo.
- Export de secours, si le navigateur ne sait pas faire l'export rapide : enregistrement de l'image masquée
  pendant qu'elle défile (canvas + MediaRecorder). `?lent` dans l'adresse force ce mode.
- Photo : JPEG.
- Installable sur l'écran d'accueil (`manifest.webmanifest`) et utilisable sans réseau : `sw.js` garde une copie
  des fichiers du site sur le téléphone. Avec du réseau, c'est toujours la version en ligne qui est servie.
- Tout est servi par le site lui-même, et une politique de sécurité (`_headers`) interdit au navigateur
  toute connexion vers un autre site.

## Mettre en ligne

Hébergé sur Cloudflare (Workers, fichiers statiques seulement, réglages dans `wrangler.jsonc`) :

```bash
node build.mjs
npx wrangler deploy
```

## Lancer en local

```bash
node dev-server.mjs
```

Puis ouvrir http://localhost:5173.

## Tester

```bash
python test/make-test-video.py
node test/run-test.mjs
```

Le test ouvre Chrome sans fenêtre, analyse une vidéo dont la position des visages est connue, exporte,
puis vérifie dans le fichier produit qu'aucun visage n'est visible, que les métadonnées ont disparu
et qu'aucune requête n'est partie après le chargement de la page.

## Limites connues

- Avec l'export de secours, l'export dure aussi longtemps que la vidéo.
- L'analyse est lente sur les longues vidéos.
- Test automatique sur Chrome pour ordinateur. Essayé à la main sur Android et sur iPhone.

## Composants tiers

- [YuNet](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet), licence MIT (`models/`).
- [ONNX Runtime Web](https://github.com/microsoft/onnxruntime), licence MIT (`vendor/ort/`).
- [Mediabunny](https://github.com/Vanilagy/mediabunny), licence MPL-2.0 (`vendor/mediabunny/`).
