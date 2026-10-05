# skred

*[Version française](README.md)*

Hide the faces in a video or photo before posting it, right in the phone's browser.
Nothing is sent to a server: no account, no analytics, no third-party file loaded from another site.

Live at [skred.fr](https://skred.fr) (French interface). Also available as an Android app.

## Why

Videos of protests and blockades are used to identify the people filmed. A blur or a mosaic
can be undone by AI. A solid box cannot: there is no image left underneath.

## What it does

1. You pick a video or a photo.
2. The video is analysed 30 times per second, and a black box (or an emoji on a black box) is placed on every face, on every frame.
3. You check: add a mask where a face was missed, remove one placed by mistake.
4. The file is fully re-encoded: the location, date and phone model stored in the original file are gone.

## What it does not do

- It does not hide clothes, tattoos, voices or places.
- It can miss a face. Checking by eye before posting is still required.
- It does not promise complete protection.

## How to verify it

You don't have to take our word for it. Each point below can be checked without special tools.

- **Android app: no permissions, not even internet.** In the phone settings, Apps → skred → Permissions:
  the list is empty. Without the internet permission, Android itself prevents the app from sending anything.
  The file that declares it: `android/app/src/main/AndroidManifest.xml`.
- **Website: airplane mode.** Open skred.fr once with a connection, switch to airplane mode, then process a video:
  everything works. With no network, nothing can leave.
- **Website: the browser's Network tab.** On a computer, open the developer tools (F12), Network tab, then process a video.
  Once the page has loaded, no request appears during analysis or export.
- **Website: the security policy.** Every file is served with a `Content-Security-Policy` header (`_headers`),
  visible in the Network tab. `connect-src 'self'` forbids the browser from connecting to any other site.
  skred.fr itself only serves static files: there is no server-side code that could receive a video.
- **The automated test** (see "Testing") fails if a single request goes out after the page has loaded.
- **The code is public.** Network calls can be found in seconds: `grep -rn "fetch(" app.js sw.js`.

## How it works

- Static site, no build step for the code: `index.html`, `style.css`, `app.js`.
- Face detection: the YuNet model (OpenCV), run by ONNX Runtime Web (`detector.js`, `detect-worker.js`),
  on several cores in parallel. Very dark frames are analysed twice, as is and brightened, and the results are merged.
- Tracking: one box per face from frame to frame, enlarged by 30%, extended a few frames before and after.
- Fast export: the original file is decoded frame by frame, each frame is masked then re-encoded
  by the phone's encoder (WebCodecs, through Mediabunny). Faster than real time.
- Fallback export, when the browser cannot do the fast one: the masked image is recorded while it plays
  (canvas + MediaRecorder). Add `?lent` to the URL to force this mode.
- Photos: JPEG.
- Installable on the home screen (`manifest.webmanifest`) and usable offline: `sw.js` keeps a copy
  of the site's files on the phone. With a connection, the online version is always served.
- Everything is served by the site itself, and a security policy (`_headers`) forbids the browser
  from connecting to any other site.

## Deploying

Hosted on Cloudflare (Workers, static assets only, settings in `wrangler.jsonc`).

```bash
node build.mjs
npx wrangler deploy
```

## Android app

Folder `android/`: the whole site packaged in an app, displayed by a WebView (`MainActivity.java`).
The app has no permissions, not even internet. It does what the browser did on its own: pick a file,
save the result to the gallery (Movies/skred, Pictures/skred), share it, keep the screen on, and open
a video shared from the gallery. The site files are copied into the app at each build,
from the same list as `build.mjs`. Store listing texts: `fastlane/metadata/android/`.

Build (JDK 17 or later, Android SDK 36):

```bash
cd android && ./gradlew assembleRelease
```

The APK lands in `android/app/build/outputs/apk/release/`. It is signed only if the key description file
exists (`~/.skred-signature/keystore.properties`, or the path given by `SKRED_KEYSTORE`).
The debug build (`assembleDebug`) bundles two videos from `test/` and opens the page with `?debug`,
so the app can be driven from a computer (`adb forward`, then the same protocol as `test/run-test.mjs`).

Distribution: APK on GitHub releases, picked up by IzzyOnDroid. Not on the main F-Droid repository
for now: it rejects prebuilt `.wasm` files, such as ONNX Runtime's.

## Running locally

```bash
node dev-server.mjs
```

Then open http://localhost:5173.

## Testing

```bash
python test/make-test-video.py
node test/run-test.mjs
```

The test opens headless Chrome, analyses a video whose face positions are known, exports it,
then checks in the output file, frame by frame and on 25 points of each face, that no face
is visible, that the metadata is gone and that no request went out after the page loaded.
It fails (exit code 1) on the slightest defect.

### No trace of the face in the file

```bash
python test/make-faces-pair.py
node test/test-sans-trace.mjs
```

Two videos identical to the pixel, except inside the faces. The second one gets exactly the same
masks as the first, then both are exported: the output files must be byte-for-byte identical.
The result therefore does not depend on the original face, and no watermark could be used to
recover it. The black box is painted on the frame before it reaches the encoder, which never sees the face.

### Third-party files

```bash
bash test/verifier-tiers.sh
```

Downloads ONNX Runtime and Mediabunny from npm and the YuNet model from OpenCV Zoo, and checks that the
files in the repository are byte-for-byte identical to the originals. Two edits, redone by the script:
the `sourceMappingURL` line of `ort.wasm.min.mjs` is emptied, and the model declares free input dimensions
(see `models/README.md`).

### Detection accuracy

`test/eval-faces.py` measures missed faces and false masks on two annotated datasets:
WIDER FACE (validation set, daytime) and DARK FACE (night). `test/eval-centerface.py` compares
the same rule with CenterFace, the model used by [deface](https://github.com/ORB-HD/deface).

## Known limitations

- With the fallback export, exporting takes as long as the video.
- Analysis is slow on long videos.
- Automated test on desktop Chrome. Tested by hand on Android and iPhone.

## Third-party components

- [YuNet](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet), MIT licence (`models/`).
- [ONNX Runtime Web](https://github.com/microsoft/onnxruntime), MIT licence (`vendor/ort/`).
- [Mediabunny](https://github.com/Vanilagy/mediabunny), MPL-2.0 licence (`vendor/mediabunny/`).
- Archivo and JetBrains Mono fonts, SIL OFL 1.1 licence (`vendor/fonts/`).

## Licence

Code under the [AGPL-3.0](LICENSE). You may copy, modify and host it,
as long as you publish the code of your version under the same licence, even if it is only served as a website.
