#!/usr/bin/env bash
# Vérifie que les fichiers tiers embarqués sont bien les versions officielles, à l'octet près.
# Besoin : npm.
# Usage : bash test/verifier-tiers.sh   (depuis la racine du dépôt)
set -e
ici=$(pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cd "$tmp"
ok=0

compare() {   # compare <fichier du dépôt> <fichier officiel> <nom>
  if cmp -s "$ici/$1" "$2"; then echo "identique    $3"; else echo "DIFFÉRENT    $3"; ok=1; fi
}

# ONNX Runtime Web 1.30.0 et Mediabunny 1.61.0, depuis npm.
npm pack onnxruntime-web@1.30.0 mediabunny@1.61.0 --silent > /dev/null
mkdir ort mb
tar -xzf onnxruntime-web-1.30.0.tgz -C ort
tar -xzf mediabunny-1.61.0.tgz -C mb
compare vendor/ort/ort-wasm-simd-threaded.wasm ort/package/dist/ort-wasm-simd-threaded.wasm "ONNX Runtime : ort-wasm-simd-threaded.wasm"
compare vendor/ort/ort-wasm-simd-threaded.mjs ort/package/dist/ort-wasm-simd-threaded.mjs "ONNX Runtime : ort-wasm-simd-threaded.mjs"
# Seule retouche : la dernière ligne « //# sourceMappingURL=... » est vidée (elle ferait charger un fichier annexe).
sed 's/^\/\/# sourceMappingURL=.*$//' ort/package/dist/ort.wasm.min.mjs > ort.wasm.min.mjs
compare vendor/ort/ort.wasm.min.mjs ort.wasm.min.mjs "ONNX Runtime : ort.wasm.min.mjs (ligne sourceMappingURL vidée)"
compare vendor/mediabunny/mediabunny.min.mjs mb/package/dist/bundles/mediabunny.min.mjs "Mediabunny : mediabunny.min.mjs"

# Le modèle (models/yunet.onnx) n'est plus un fichier tiers tel quel : il a été réentraîné pour skred.
# Sa recette est dans test/entrainer-nuit.sh, ses mesures dans models/README.md.

exit $ok
