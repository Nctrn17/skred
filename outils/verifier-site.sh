#!/usr/bin/env bash
# Vérifie que skred.fr sert exactement le code du dépôt, à l'octet près : chaque fichier du site est téléchargé
# et comparé à sa version dans le dernier commit (pas aux fichiers modifiés sur le disque).
# Vérifie aussi que la politique de sécurité envoyée par le site est celle de _headers.
# Besoin : git, curl.
# Usage : bash outils/verifier-site.sh   (depuis la racine du dépôt)
#         SITE=https://autre.adresse bash outils/verifier-site.sh
set -e
site=${SITE:-https://skred.fr}
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
ok=0

# Même liste que build.mjs : les fichiers gardés hors ligne par sw.js, plus les pages et les licences.
# _headers n'est pas un fichier servi : Cloudflare le lit pour régler les en-têtes, vérifiés plus bas.
liste=$(git show HEAD:sw.js | sed -n '/^const FILES = \[/,/^\];/p' | grep -o "'[^']*'" | tr -d "'" | grep -v '^\./$')
fichiers="index.html mentions.html verifier.html 404.html sw.js favicon.ico icon.svg $liste
  models/LICENSE-yunet.txt vendor/fonts/LICENSE.txt vendor/ort/LICENSE.txt vendor/mediabunny/LICENSE.txt"

echo "Commit $(git rev-parse --short HEAD) comparé à $site"
for f in $fichiers; do
  # L'accueil est servi à l'adresse « / » ; les autres pages peuvent être redirigées (-L suit la redirection).
  if [ "$f" = index.html ]; then url="$site/"; else url="$site/$f"; fi
  git show "HEAD:$f" > "$tmp/depot"
  if ! curl -sSL --compressed "$url" -o "$tmp/site"; then echo "INJOIGNABLE  $f"; ok=1; continue; fi
  if cmp -s "$tmp/depot" "$tmp/site"; then echo "identique    $f"; else echo "DIFFÉRENT    $f"; ok=1; fi
done

# La politique de sécurité : celle envoyée par le site doit être mot pour mot celle du dépôt.
attendue=$(git show HEAD:_headers | sed -n 's/^ *Content-Security-Policy: *//p' | tr -d '\r')
recue=$(curl -sSI "$site/" | sed -n 's/^[Cc]ontent-[Ss]ecurity-[Pp]olicy: *//p' | tr -d '\r')
if [ "$attendue" = "$recue" ]; then echo "identique    en-tête Content-Security-Policy"; else echo "DIFFÉRENT    en-tête Content-Security-Policy"; ok=1; fi

exit $ok
