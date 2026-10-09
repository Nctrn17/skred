# Contribuer à skred

Ce document concerne le fork [ethoneslop/skred](https://github.com/ethoneslop/skred), maintenu par **ethone**, à partir du [projet d'origine Nctrn17/skred](https://github.com/Nctrn17/skred).

Pour un bug, une demande de fonctionnalité ou un souci de sécurité concernant cette version, ouvre une [issue sur ce fork](https://github.com/ethoneslop/skred/issues). ethone assure le suivi de ses ajouts et de leur sécurité. Les signalements concernant cette version doivent lui parvenir sur ce fork, et non sur le dépôt d'origine. Voir aussi [SECURITY.md](SECURITY.md).

Les modifications apportées par ethone doivent être documentées par des commits sur ce fork. Les crédits du projet d'origine et des composants tiers doivent être conservés.

Merci de vouloir aider. skred protège des personnes filmées : chaque changement est relu avant d'entrer,
et certains sont refusés même s'ils partent d'une bonne idée. Ce fichier dit à quoi t'attendre, pour que tu
ne passes pas des heures sur une PR qui ne pourra pas être acceptée.

Tu peux écrire en français ou en anglais.

## Avant de commencer

- **Petite correction** (faute, bug évident, texte peu clair) : ouvre directement une PR.
- **Nouvelle fonction ou gros changement** : ouvre d'abord une issue pour en parler. On vérifie ensemble que
  l'idée colle au projet avant que tu écrives le code.

## Ce qui est refusé d'office

- **Une protection partielle présentée comme une protection.** Flou, mosaïque, voix légèrement déformée :
  ces effets donnent l'impression d'être caché sans l'être vraiment. skred met un carré plein parce qu'il
  n'y a plus rien dessous. Un nouvel effet doit tenir la même promesse, ou ne pas exister.
- **Toute requête après le chargement de la page.** Pas de statistiques, pas de police, script ou fichier
  chargé depuis un autre site, pas de serveur. Rien ne doit quitter le téléphone. La règle
  `Content-Security-Policy` (`index.html` et `_headers`) ne s'assouplit pas.
- **Un réglage de détection changé sans mesure.** Les seuils (`MIN_SCORE`, `TRACK`…) viennent de mesures.
  Un changement doit être mesuré avec `entrainement/eval-faces.py` (photos annotées) et
  `entrainement/eval-reel.mjs` (vidéos réelles), chiffres avant et après dans la PR. Rater un visage de plus
  coûte plus cher que poser un masque de trop.
- **Un fichier de `vendor/` retouché.** Ils doivent rester identiques aux originaux (`bash test/verifier-tiers.sh`).

## Comment faire une PR facile à relire

- **Un seul sujet par PR**, le plus court possible.
- **Pas de remise en page.** Pas de Prettier ou autre outil de mise en forme sur des fichiers entiers : une
  PR où 1 500 lignes changent pour 50 lignes utiles ne peut pas être relue. Garde le style du fichier :
  guillemets simples, lignes longues acceptées, commentaires en français.
- **Pars du dernier `main`**, et relis ta fusion : elle ne doit défaire aucun changement récent.
- **Explique le pourquoi** dans la description : quel problème, sur quel téléphone et quel navigateur,
  comment tu as vérifié.

## Tests

Ils doivent passer avant toute PR qui touche au site :

```bash
node outils/dev-server.mjs
python test/make-test-video.py
node test/run-test.mjs
python test/make-faces-pair.py
node test/test-sans-trace.mjs
```

Le serveur tourne dans un terminal à part. Les tests automatiques ne tournent que sur Chrome pour ordinateur :
si ton changement touche à la lecture vidéo, au son ou à l'export, essaie-le aussi sur un vrai téléphone
(Android et, si possible, iPhone) et dis-le dans la PR. Safari sur iPhone a ses propres règles, notamment
pour lancer une vidéo avec le son.

Un test existant ne se modifie pas pour le faire passer : si tu penses qu'il est faux, explique pourquoi.

## Textes affichés

- L'app **tutoie**, partout.
- Phrases courtes, mots simples : beaucoup de gens l'utilisent dans l'urgence, sur un téléphone.
- Pas de tiret cadratin (—).
- Ne jamais promettre plus que ce que fait l'outil. Ce qu'il ne fait pas (vêtements, tatouages, lieu, voix)
  doit rester dit clairement.

## Licence

skred est sous licence [AGPL-3.0](LICENSE). En proposant une PR, tu acceptes que ton code soit publié sous
cette même licence.
