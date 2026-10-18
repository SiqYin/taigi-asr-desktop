package ai.taigi.asrweb;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ContentValues;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.KeyEvent;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.webkit.WebViewAssetLoader;

import java.io.OutputStream;

/**
 * 台語語音轉錄 · 安卓版外殼。
 *
 * 與參考專案（shavian-transliteratar）的 file:// 殼不同，本專案必須用
 * {@link WebViewAssetLoader} 以 https://appassets.androidplatform.net/ 提供資產：
 *
 *   1. Service Worker 只在安全來源（https / localhost）可用，而多執行緒 WASM
 *      需要 Service Worker 注入 COOP/COEP 標頭以取得 SharedArrayBuffer；
 *   2. file:// 來源無法註冊 Service Worker，會退回單執行緒，速度差數倍。
 *
 * 另外透過 JavascriptInterface 讓網頁把字幕檔寫進系統「下載」目錄，
 * 這是桌面端「輸出到資料夾」在 Android 上的等價行為。
 */
public class MainActivity extends Activity {

    private static final String ASSET_HOST = "appassets.androidplatform.net";
    private static final String START_URL =
            "https://" + ASSET_HOST + "/assets/www/index.html";

    private WebView webView;
    private ValueCallback<Uri[]> filePathCallback;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // 讓 WebView 除錯可在 chrome://inspect 中檢視（僅 debug 版本）
        if (BuildConfig.DEBUG) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        webView = new WebView(this);
        webView.setBackgroundColor(0xFF0F141B);
        setContentView(webView);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);              // localStorage：設定
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);               // 資產走 AssetLoader
        settings.setAllowContentAccess(false);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setTextZoom(100);
        // 平板／橫向時不要讓 WebView 自己縮放，交給 CSS 響應式處理
        settings.setLayoutAlgorithm(WebSettings.LayoutAlgorithm.NORMAL);

        webView.setWebViewClient(new WebViewClient() {
            private final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                    .setDomain(ASSET_HOST)
                    .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(MainActivity.this))
                    .build();

            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return loader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                // 站內（appassets）自己處理；外部連結交給系統瀏覽器
                if (ASSET_HOST.equals(url.getHost())) return false;
                try {
                    startActivity(new android.content.Intent(android.content.Intent.ACTION_VIEW, url));
                } catch (Exception ignored) {
                    // 沒有可開啟的 App
                }
                return true;
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage message) {
                android.util.Log.d("TaigiWeb", message.message() + " @" + message.lineNumber());
                return true;
            }

            @Override
            public boolean onShowFileChooser(
                    WebView view,
                    ValueCallback<Uri[]> callback,
                    FileChooserParams params) {
                filePathCallback = callback;
                try {
                    startActivityForResult(params.createIntent(), 1001);
                    return true;
                } catch (Exception err) {
                    filePathCallback = null;
                    return false;
                }
            }
        });

        webView.addJavascriptInterface(new Bridge(), "TaigiAndroid");

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState);
        } else {
            webView.loadUrl(START_URL);
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, android.content.Intent data) {
        if (requestCode == 1001) {
            if (filePathCallback != null) {
                Uri[] results = null;
                if (resultCode == Activity.RESULT_OK && data != null) {
                    if (data.getClipData() != null) {
                        int count = data.getClipData().getItemCount();
                        results = new Uri[count];
                        for (int i = 0; i < count; i++) {
                            results[i] = data.getClipData().getItemAt(i).getUri();
                        }
                    } else if (data.getData() != null) {
                        results = new Uri[]{data.getData()};
                    }
                }
                filePathCallback.onReceiveValue(results);
                filePathCallback = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && webView.canGoBack()) {
            webView.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.removeJavascriptInterface("TaigiAndroid");
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    /** 給網頁呼叫的原生橋接：把字幕文字寫進系統下載目錄。 */
    private class Bridge {

        /**
         * @param filename 建議檔名（例如 xxx.srt）
         * @param mime     MIME 類型
         * @param base64   UTF-8 內容的 Base64（避免字串跨介面傳輸的編碼問題）
         * @return 實際寫入的 URI 字串，失敗時回傳 null
         */
        @JavascriptInterface
        public String saveText(String filename, String mime, String base64) {
            try {
                byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
                String safeName = filename.replaceAll("[\\\\/:*?\"<>|]", "_");
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    ContentValues values = new ContentValues();
                    values.put(MediaStore.Downloads.DISPLAY_NAME, safeName);
                    values.put(MediaStore.Downloads.MIME_TYPE,
                            mime == null ? "application/octet-stream" : mime.split(";")[0]);
                    values.put(MediaStore.Downloads.IS_PENDING, 1);
                    Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                    if (uri == null) return null;
                    try (OutputStream out = getContentResolver().openOutputStream(uri)) {
                        if (out == null) return null;
                        out.write(bytes);
                    }
                    values.clear();
                    values.put(MediaStore.Downloads.IS_PENDING, 0);
                    getContentResolver().update(uri, values, null, null);
                    notifySaved(safeName);
                    return uri.toString();
                }

                java.io.File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
                if (!dir.exists() && !dir.mkdirs()) return null;
                java.io.File target = new java.io.File(dir, safeName);
                try (OutputStream out = new java.io.FileOutputStream(target)) {
                    out.write(bytes);
                }
                notifySaved(safeName);
                return target.getAbsolutePath();
            } catch (Exception err) {
                android.util.Log.e("TaigiWeb", "saveText 失敗", err);
                return null;
            }
        }

        @JavascriptInterface
        public String platform() {
            return "android-" + Build.VERSION.SDK_INT;
        }

        /** 回傳裝置是否為低記憶體機型（供網頁端提示使用者改用較短音訊）。 */
        @JavascriptInterface
        public boolean isLowRamDevice() {
            android.app.ActivityManager am =
                    (android.app.ActivityManager) getSystemService(ACTIVITY_SERVICE);
            return am != null && am.isLowRamDevice();
        }

        /** 裝置可用記憶體（MB），供網頁端估算能否載入 848 MB 模型。 */
        @JavascriptInterface
        public long availableMemoryMb() {
            android.app.ActivityManager am =
                    (android.app.ActivityManager) getSystemService(ACTIVITY_SERVICE);
            if (am == null) return -1;
            android.app.ActivityManager.MemoryInfo info = new android.app.ActivityManager.MemoryInfo();
            am.getMemoryInfo(info);
            return info.totalMem / (1024 * 1024);
        }

        private void notifySaved(String name) {
            runOnUiThread(() -> Toast.makeText(
                    MainActivity.this,
                    getString(R.string.saved_to_downloads, name),
                    Toast.LENGTH_LONG).show());
        }
    }
}
