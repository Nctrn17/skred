package fr.skred.app;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.view.WindowManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import androidx.core.content.FileProvider;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.Collections;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * skred pour Android : le site entier est rangé dans l'app (assets/site) et affiché par une WebView.
 * L'app n'a aucune permission, pas même internet. Les fichiers sont servis à une adresse locale
 * (https://appassets.androidplatform.net), qui ne quitte jamais le téléphone.
 *
 * Ce que le navigateur faisait seul et que l'app fait ici, à la demande de la page (objet skredAndroid) :
 * choisir un fichier, enregistrer la vidéo masquée dans la galerie, la partager, garder l'écran allumé,
 * et recevoir une vidéo partagée depuis la galerie.
 */
public class MainActivity extends Activity {
    private static final String HOST = "appassets.androidplatform.net";
    private static final String ORIGIN = "https://" + HOST;
    private static final int PICK = 1;

    private WebView web;
    private ValueCallback<Uri[]> pickCallback;
    private Uri sharedUri;
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final Handler ui = new Handler(Looper.getMainLooper());

    // Fichier en cours de réception depuis la page.
    private File outFile;
    private OutputStream out;
    private String outName, outType, outAction;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        sharedUri = sharedFrom(getIntent());

        web = new WebView(this);
        web.setBackgroundColor(0xFFEFEDE6);
        // L'app dessine sous les barres du système : un cadre autour de la page laisse la place qu'elles occupent
        // (la WebView, elle, ne tient pas compte de ses propres marges).
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(0xFFEFEDE6);
        root.addView(web);
        setContentView(root);
        ViewCompat.setOnApplyWindowInsetsListener(root, (v, insets) -> {
            Insets b = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            v.setPadding(b.left, b.top, b.right, b.bottom);
            return WindowInsetsCompat.CONSUMED;
        });

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);

        WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
            .setDomain(HOST)
            .addPathHandler("/__partage/", path -> sharedResponse())
            .addPathHandler("/", this::siteResponse)
            .build();

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                WebResourceResponse r = loader.shouldInterceptRequest(req.getUrl());
                // Tout ce qui n'est pas un fichier de l'app est refusé (de toute façon, pas d'accès à internet).
                return r != null ? r : new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", null, null);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                return !HOST.equals(req.getUrl().getHost());
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (pickCallback != null) pickCallback.onReceiveValue(null);
                pickCallback = callback;
                Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                i.putExtra(Intent.EXTRA_MIME_TYPES, new String[] { "video/*", "image/*" });
                try {
                    startActivityForResult(i, PICK);
                } catch (Exception e) {
                    pickCallback = null;
                    return false;
                }
                return true;
            }
        });

        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(web, "skredAndroid", Collections.singleton(ORIGIN),
                (view, message, origin, isMainFrame, reply) -> onMessage(message, reply));
        }

        web.loadUrl(ORIGIN + "/site/index.html" + (BuildConfig.DEBUG ? "?debug" : ""));
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        Uri u = sharedFrom(intent);
        if (u != null) {
            sharedUri = u;
            web.loadUrl(ORIGIN + "/site/index.html" + (BuildConfig.DEBUG ? "?debug" : ""));
        }
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request != PICK || pickCallback == null) return;
        Uri u = result == RESULT_OK && data != null ? data.getData() : null;
        pickCallback.onReceiveValue(u != null ? new Uri[] { u } : null);
        pickCallback = null;
    }

    @Override
    protected void onDestroy() {
        io.shutdown();
        web.destroy();
        super.onDestroy();
    }

    private static Uri sharedFrom(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return null;
        return intent.getParcelableExtra(Intent.EXTRA_STREAM);
    }

    /* ---------- Fichiers servis à la page ---------- */

    private WebResourceResponse siteResponse(String path) {
        try {
            InputStream in = getAssets().open(path.isEmpty() ? "site/index.html" : path);
            return new WebResourceResponse(mime(path), null, in);
        } catch (IOException e) {
            return null;
        }
    }

    private static String mime(String path) {
        String p = path.toLowerCase();
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".js") || p.endsWith(".mjs")) return "text/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".wasm")) return "application/wasm";
        if (p.endsWith(".json") || p.endsWith(".webmanifest")) return "application/json";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".ico")) return "image/x-icon";
        if (p.endsWith(".woff2")) return "font/woff2";
        if (p.endsWith(".txt")) return "text/plain";
        return "application/octet-stream";
    }

    // La vidéo partagée depuis la galerie, que la page vient chercher à l'adresse /__partage/.
    private WebResourceResponse sharedResponse() {
        if (sharedUri == null) return null;
        try {
            String type = getContentResolver().getType(sharedUri);
            InputStream in = getContentResolver().openInputStream(sharedUri);
            return new WebResourceResponse(type != null ? type : "application/octet-stream", null, in);
        } catch (Exception e) {
            return null;
        }
    }

    private String sharedName() {
        try (Cursor c = getContentResolver().query(sharedUri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (c != null && c.moveToFirst()) return c.getString(0);
        } catch (Exception e) { /* nom inconnu */ }
        return "fichier";
    }

    /* ---------- Messages de la page ---------- */

    private void onMessage(WebMessageCompat message, JavaScriptReplyProxy reply) {
        if (message.getType() == WebMessageCompat.TYPE_ARRAY_BUFFER) {
            byte[] chunk = message.getArrayBuffer();
            io.execute(() -> write(chunk));
            return;
        }
        try {
            JSONObject m = new JSONObject(message.getData());
            switch (m.getString("t")) {
                case "hello": {
                    JSONObject r = new JSONObject();
                    r.put("t", "hello");
                    r.put("ab", WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_ARRAY_BUFFER));
                    if (sharedUri != null) {
                        r.put("shared", sharedName());
                        r.put("sharedType", getContentResolver().getType(sharedUri));
                    }
                    reply.postMessage(r.toString());
                    break;
                }
                case "partageLu":
                    sharedUri = null;
                    break;
                case "awake":
                    if (m.getBoolean("on")) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                    else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                    break;
                case "begin": {
                    String name = m.getString("name").replaceAll("[^\\w.-]", "_");
                    String type = m.getString("type"), action = m.getString("action");
                    io.execute(() -> begin(name, type, action));
                    break;
                }
                case "chunk64": {
                    byte[] chunk = Base64.decode(m.getString("d"), Base64.DEFAULT);
                    io.execute(() -> write(chunk));
                    break;
                }
                case "end":
                    io.execute(() -> end(reply));
                    break;
            }
        } catch (Exception e) {
            reply.postMessage("{\"t\":\"error\"}");
        }
    }

    private void begin(String name, String type, String action) {
        closeOut();
        try {
            File dir = new File(getCacheDir(), "out");
            if (dir.exists()) for (File f : dir.listFiles()) f.delete();   // un seul fichier à la fois
            dir.mkdirs();
            outFile = new File(dir, name);
            out = new FileOutputStream(outFile);
            outName = name;
            outType = type;
            outAction = action;
        } catch (IOException e) {
            out = null;
        }
    }

    private void write(byte[] chunk) {
        if (out == null) return;
        try {
            out.write(chunk);
        } catch (IOException e) {
            closeOut();
        }
    }

    private void end(JavaScriptReplyProxy reply) {
        boolean ok = out != null;
        closeOut();
        String result;
        if (!ok) result = "error";
        else if ("share".equals(outAction)) result = share() ? "shared" : "error";
        else result = save() ? "saved" : "error";
        ui.post(() -> reply.postMessage("{\"t\":\"" + result + "\"}"));
    }

    private void closeOut() {
        if (out == null) return;
        try {
            out.close();
        } catch (IOException e) { /* déjà fermé */ }
        out = null;
    }

    // Enregistre dans la galerie : Films/skred pour une vidéo, Images/skred pour une photo.
    private boolean save() {
        boolean photo = outType.startsWith("image/");
        ContentResolver cr = getContentResolver();
        ContentValues v = new ContentValues();
        v.put(MediaStore.MediaColumns.DISPLAY_NAME, outName);
        v.put(MediaStore.MediaColumns.MIME_TYPE, outType);
        v.put(MediaStore.MediaColumns.RELATIVE_PATH, (photo ? Environment.DIRECTORY_PICTURES : Environment.DIRECTORY_MOVIES) + "/skred");
        v.put(MediaStore.MediaColumns.IS_PENDING, 1);
        Uri collection = photo
            ? MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
            : MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
        Uri item = cr.insert(collection, v);
        if (item == null) return false;
        try (InputStream in = new FileInputStream(outFile); OutputStream o = cr.openOutputStream(item)) {
            byte[] buf = new byte[1 << 16];
            for (int n; (n = in.read(buf)) > 0; ) o.write(buf, 0, n);
        } catch (Exception e) {
            cr.delete(item, null, null);
            return false;
        }
        v.clear();
        v.put(MediaStore.MediaColumns.IS_PENDING, 0);
        cr.update(item, v, null, null);
        outFile.delete();
        return true;
    }

    private boolean share() {
        try {
            Uri u = FileProvider.getUriForFile(this, "fr.skred.app.files", outFile);
            Intent send = new Intent(Intent.ACTION_SEND);
            send.setType(outType);
            send.putExtra(Intent.EXTRA_STREAM, u);
            send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            ui.post(() -> startActivity(Intent.createChooser(send, null)));
            return true;
        } catch (Exception e) {
            return false;
        }
    }
}
