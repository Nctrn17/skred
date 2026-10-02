# ONNX Runtime Web, version 1.30.0 (licence MIT)

Moteur qui exécute le modèle de détection dans le navigateur. Trois fichiers repris du paquet npm
`onnxruntime-web@1.30.0` (dossier `dist/`) : `ort.wasm.min.mjs`, `ort-wasm-simd-threaded.mjs`,
`ort-wasm-simd-threaded.wasm`.

Avant toute mise à jour, vérifier qu'aucune adresse d'envoi de données n'apparaît :
`grep -o "https\?://[a-zA-Z0-9./_-]*" ort.wasm.min.mjs ort-wasm-simd-threaded.mjs`
ne doit renvoyer qu'un lien de documentation (web.dev).

Pourquoi pas MediaPipe : son détecteur (BlazeFace) est fait pour les selfies et rate les foules,
et la version 1.0.1 du paquet npm envoie des statistiques à Google.
