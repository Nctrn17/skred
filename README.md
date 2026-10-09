# skred

*[English version](README.en.md)*

Masquer les visages d'une vidéo ou d'une photo avant de la poster, directement dans le navigateur du téléphone.
Les vidéos, les photos et les fichiers produits sont traités en local, sur ton appareil. Le service ne les envoie à aucun serveur. Tu choisis ensuite si tu souhaites enregistrer ou partager le résultat. Pas de compte, pas de statistiques, pas de fichier tiers chargé depuis un autre site.

Cette version est maintenue par **ethone** dans le fork [ethoneslop/skred](https://github.com/ethoneslop/skred), à partir du [projet d'origine Nctrn17/skred](https://github.com/Nctrn17/skred). Pour un problème avec cette version, ouvre une [issue sur le fork](https://github.com/ethoneslop/skred/issues).

## Pourquoi

Les vidéos de blocus et de manifestation servent à identifier les personnes filmées. Un flou ou une mosaïque
peuvent être défaits par une IA. Un carré plein, non : il n'y a plus d'image dessous.

## Ce que fait l'outil

1. Tu choisis une vidéo ou une photo.
2. La vidéo est analysée 30 fois par seconde, et un carré noir (ou un émoji posé sur un carré noir) est placé sur chaque visage, sur toutes les images.
3. Tu vérifies : tu ajoutes un masque là où un visage a été raté, tu retires un masque posé à tort. Chaque masque a sa ligne dans la timeline : clique sur son trait pour le sélectionner. Avec les flèches ‹ ›, tu peux déplacer les masques image par image. Tire les coins pour choisir librement leur largeur et leur hauteur. Pose deux points clés ◆ à des images différentes pour faire évoluer la position et la taille entre elles. Règle le début et la fin du masque en secondes ou avec « Début ici » et « Fin ici ». Les boutons de zoom agrandissent l'aperçu ; « Déplacer » permet de le faire glisser pour atteindre un petit visage.
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
- **Vérifier le code servi.** `outils/verifier-site.sh` compare les fichiers d'un site au dernier commit du dépôt.
  Pour ce fork, indique l'adresse où ta version est publiée avec `SITE` (voir « Tester »). Par défaut, le script vérifie skred.fr, le site du projet d'origine.

## Comment c'est fait

- Site statique, sans étape de construction : `index.html`, `style.css`, `app.js`.
- Détection des visages : modèle YuNet_n réentraîné pour mieux voir la nuit (`models/README.md`), exécuté par ONNX Runtime Web (`detector.js`, `detect-worker.js`),
  sur plusieurs cœurs en parallèle. Les images très sombres sont analysées deux fois, telles quelles et éclaircies,
  et les visages trouvés sont réunis.
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

## Rangement

- À la racine : le site lui-même (`index.html`, `app.js`, `style.css`…), avec `models/` (le modèle de détection),
  `vendor/` (bibliothèques et polices) et `icons/`.
- `outils/` : construire le site publié, le servir en local, vérifier que skred.fr sert bien ce dépôt.
- `test/` : les tests du site.
- `entrainement/` : mesure et entraînement du modèle de détection.
- `android/` et `fastlane/` : l'app Android et les textes de sa fiche.

## Mettre en ligne

Le site du projet d'origine est https://skred.fr. Ce dépôt contient la version modifiée par ethone. La configuration Cloudflare incluse sert des fichiers statiques seulement (`wrangler.jsonc`).

Publier :

```bash
node outils/build.mjs
npx wrangler deploy
```

## App Android

Dossier `android/` : le site entier rangé dans une app, affiché par une WebView (`MainActivity.java`).
L'app n'a aucune permission, pas même internet. Elle fait ce que le navigateur faisait seul : choisir un fichier,
enregistrer le résultat dans la galerie (Films/skred, Images/skred), le partager, garder l'écran allumé, et ouvrir
une vidéo partagée depuis la galerie. Les fichiers du site sont copiés dans l'app à chaque construction,
d'après la même liste que `outils/build.mjs`. Textes de la fiche : `fastlane/metadata/android/`.

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
node outils/dev-server.mjs
```

Puis ouvrir http://localhost:5173.

## Tester

Les corrections image par image se testent avec Node seul :

```bash
node test/test-edition.mjs
```

Pour vérifier l'analyse et le fichier vidéo exporté :

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

Télécharge ONNX Runtime et Mediabunny depuis npm et vérifie que les fichiers du dépôt sont identiques aux
originaux, à l'octet près. Seule retouche, refaite par le script : la ligne `sourceMappingURL` de `ort.wasm.min.mjs`
est vidée. Le modèle, lui, a été réentraîné pour skred : sa recette est dans `entrainement/entrainer-nuit.sh`.

### Le site en ligne

```bash
bash outils/verifier-site.sh
```

Télécharge chaque fichier servi par skred.fr (la même liste que `outils/build.mjs`) et le compare, à l'octet près,
à sa version dans le dernier commit. Vérifie aussi que l'en-tête `Content-Security-Policy` reçu est celui de `_headers`.
Autre adresse : `SITE=https://… bash outils/verifier-site.sh`.

### Précision de la détection

`entrainement/eval-faces.py` mesure les visages ratés et les faux masques sur deux banques de photos annotées :
WIDER FACE (validation, de jour) et DARK FACE (de nuit). `entrainement/eval-centerface.py` compare la même règle
à CenterFace, le modèle de [deface](https://github.com/ORB-HD/deface).

## Limites connues

- Avec l'export de secours, l'export dure aussi longtemps que la vidéo.
- L'analyse est lente sur les longues vidéos.
- Test automatique sur Chrome pour ordinateur. Essayé à la main sur Android et sur iPhone.

## Composants tiers

- [YuNet_n](https://github.com/ShiqiYu/libfacedetection.train), licence BSD-3, réentraîné sur WIDER FACE et DARK FACE (`models/`).
- [ONNX Runtime Web](https://github.com/microsoft/onnxruntime), licence MIT (`vendor/ort/`).
- [Mediabunny](https://github.com/Vanilagy/mediabunny), licence MPL-2.0 (`vendor/mediabunny/`).
- Polices Archivo et JetBrains Mono, licence SIL OFL 1.1 (`vendor/fonts/`).

## Contribuer

Avant d'ouvrir une PR sur le fork [ethoneslop/skred](https://github.com/ethoneslop/skred), lis [CONTRIBUTING.md](CONTRIBUTING.md).

## Participation d'ethone

**ethone** participe sous pseudonyme, à titre non professionnel. Ses contributions à cette version comprennent le déplacement des masques image par image et par points clés, le redimensionnement libre en carré ou en rectangle avec des poignées, le choix de leur début et de leur fin, la timeline avec une ligne par masque et le zoom de l'aperçu.

ethone est responsable de ses ajouts à ce fork. Il assure leur maintenance et le suivi de la sécurité de cette version du service. Ses modifications doivent être documentées par des commits sur [son fork](https://github.com/ethoneslop/skred).

Pour tout bug ou souci de sécurité concernant cette version, ouvre une [issue sur le fork d'ethone](https://github.com/ethoneslop/skred/issues), et non sur le dépôt d'origine, afin qu'il puisse suivre et traiter le signalement directement. Voir aussi [SECURITY.md](SECURITY.md) et les [mentions légales](mentions.html).

## Licence

Code sous licence [AGPL-3.0](LICENSE). Tu peux le copier, le modifier et le mettre en ligne,
à condition de publier le code de ta version sous la même licence, y compris si elle n'est servie que sur un site.
