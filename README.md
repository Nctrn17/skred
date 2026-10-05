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

## Comment le vérifier

Pas besoin de nous croire sur parole : chacun de ces points se vérifie sans rien installer de spécial.

- **App Android : aucune permission, pas même internet.** Dans les réglages du téléphone, Applications → skred →
  Autorisations : la liste est vide. Sans la permission internet, Android interdit lui-même à l'app d'envoyer quoi que ce soit.
  Le fichier qui le déclare : `android/app/src/main/AndroidManifest.xml`.
- **Site : en mode avion.** Ouvre skred.fr une première fois avec du réseau, puis passe en mode avion et traite une vidéo :
  tout marche. Sans réseau, rien ne peut partir.
- **Site : l'onglet Réseau du navigateur.** Sur ordinateur, ouvre les outils de développement (F12), onglet Réseau,
  puis traite une vidéo. Après le chargement de la page, aucune requête n'apparaît pendant l'analyse ni pendant l'export.
- **Site : la politique de sécurité.** Chaque fichier du site est servi avec l'en-tête `Content-Security-Policy`
  (`_headers`), visible dans l'onglet Réseau. `connect-src 'self'` interdit au navigateur toute connexion vers un autre site.
  skred.fr lui-même ne sert que des fichiers statiques : aucun code côté serveur ne pourrait recevoir une vidéo.
- **Le test automatique** (voir « Tester ») échoue si une seule requête part après le chargement de la page.
- **Le code est public.** Les envois réseau se cherchent en quelques secondes : `grep -rn "fetch(" app.js sw.js`.

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

Adresse : https://skred.fr. Hébergé sur Cloudflare (Workers, fichiers statiques seulement, réglages dans `wrangler.jsonc`).
L'ancienne adresse skred.vercel.app redirige vers skred.fr (`vercel.json`).

Publier :

```bash
node build.mjs
npx wrangler deploy
```

## App Android

Dossier `android/` : le site entier rangé dans une app, affiché par une WebView (`MainActivity.java`).
L'app n'a aucune permission, pas même internet. Elle fait ce que le navigateur faisait seul : choisir un fichier,
enregistrer le résultat dans la galerie (Films/skred, Images/skred), le partager, garder l'écran allumé, et ouvrir
une vidéo partagée depuis la galerie. Les fichiers du site sont copiés dans l'app à chaque construction,
d'après la même liste que `build.mjs`. Textes de la fiche : `fastlane/metadata/android/`.

Construire (JDK 17 ou plus, SDK Android 36) :

```bash
cd android && ./gradlew assembleRelease
```

L'APK sort dans `android/app/build/outputs/apk/release/`. Il est signé seulement si le fichier décrivant la clé
existe (`~/.skred-signature/keystore.properties`, ou le chemin donné par `SKRED_KEYSTORE`).
La version de test (`assembleDebug`) embarque deux vidéos de `test/` et ouvre la page avec `?debug`,
pour piloter l'app depuis l'ordinateur (`adb forward`, puis le même protocole que `test/run-test.mjs`).

Distribution : APK sur les publications GitHub, repris par IzzyOnDroid. Pas sur le dépôt principal de F-Droid
pour l'instant : il refuse les fichiers `.wasm` déjà compilés, comme celui d'ONNX Runtime.

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
puis vérifie dans le fichier produit, image par image et sur 25 points de chaque visage, qu'aucun visage
n'est visible, que les métadonnées ont disparu et qu'aucune requête n'est partie après le chargement de la page.
Il échoue (code de sortie 1) au moindre défaut.

### Aucune trace du visage dans le fichier

```bash
python test/make-faces-pair.py
node test/test-sans-trace.mjs
```

Deux vidéos identiques au pixel près, sauf l'intérieur des visages. La seconde reçoit exactement les mêmes
masques que la première, puis les deux sont exportées : les fichiers produits doivent être identiques octet
pour octet. Le résultat ne dépend donc pas du visage d'origine, et aucun filigrane ne peut permettre de le
retrouver. Le carré noir est peint sur l'image avant qu'elle parte à l'encodeur, qui ne voit jamais le visage.

### Fichiers tiers

```bash
bash test/verifier-tiers.sh
```

Télécharge ONNX Runtime et Mediabunny depuis npm et le modèle YuNet depuis OpenCV Zoo, et vérifie que les
fichiers du dépôt sont identiques aux originaux, à l'octet près. Deux retouches, refaites par le script :
la ligne `sourceMappingURL` de `ort.wasm.min.mjs` est vidée, et le modèle déclare ses dimensions libres
(voir `models/README.md`).

## Limites connues

- Avec l'export de secours, l'export dure aussi longtemps que la vidéo.
- L'analyse est lente sur les longues vidéos.
- Test automatique sur Chrome pour ordinateur. Essayé à la main sur Android et sur iPhone.

## Composants tiers

- [YuNet](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet), licence MIT (`models/`).
- [ONNX Runtime Web](https://github.com/microsoft/onnxruntime), licence MIT (`vendor/ort/`).
- [Mediabunny](https://github.com/Vanilagy/mediabunny), licence MPL-2.0 (`vendor/mediabunny/`).
- Polices Archivo et JetBrains Mono, licence SIL OFL 1.1 (`vendor/fonts/`).

## Licence

Code sous licence [AGPL-3.0](LICENSE). Tu peux le copier, le modifier et le mettre en ligne,
à condition de publier le code de ta version sous la même licence, y compris si elle n'est servie que sur un site.
