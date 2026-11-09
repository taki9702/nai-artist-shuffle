// After `npx cap add android`: app icon, dark window colors, file sharing from the app folder, saving to the
// phone's Download / Pictures folders, and the version from web/js/version.js.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const app = path.join(root, 'android', 'app');
const res = path.join(app, 'src', 'main', 'res');
const read = (f) => fs.readFileSync(f, 'utf8');
const write = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };

// version
const versionJs = read(path.join(root, 'web', 'js', 'version.js'));
const version = versionJs.match(/VERSION\s*=\s*'([^']+)'/)[1];
const code = Number(process.env.VERSION_CODE || process.env.GITHUB_RUN_NUMBER || 1);
const gradleFile = path.join(app, 'build.gradle');
let gradle = read(gradleFile);
gradle = gradle.replace(/versionCode\s+\d+/, `versionCode ${code}`).replace(/versionName\s+"[^"]*"/, `versionName "${version}"`);
write(gradleFile, gradle);
console.log(`version ${version} (${code})`);

// icons
const iconSrc = path.join(root, 'android-res');
for (const dir of fs.readdirSync(iconSrc)) {
  if (dir.startsWith('splash')) continue;
  fs.cpSync(path.join(iconSrc, dir), path.join(res, dir), { recursive: true });
}
// splash screens: the template's Capacitor logo becomes this app's icon on the dark background
for (const dir of fs.readdirSync(res)) {
  const file = path.join(res, dir, 'splash.png');
  if (!dir.startsWith('drawable') || !fs.existsSync(file)) continue;
  fs.copyFileSync(path.join(iconSrc, dir.includes('land') ? 'splash-land.png' : 'splash-port.png'), file);
}
write(path.join(res, 'mipmap-anydpi-v26', 'ic_launcher.xml'), `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
</adaptive-icon>
`);
write(path.join(res, 'mipmap-anydpi-v26', 'ic_launcher_round.xml'), read(path.join(res, 'mipmap-anydpi-v26', 'ic_launcher.xml')));
// a launcher icon left over from the template that we do not provide (keeps the build from mixing two icons)
for (const dir of fs.readdirSync(res)) {
  const stale = path.join(res, dir, 'ic_launcher_background.png');
  if (fs.existsSync(stale)) fs.rmSync(stale);
}

// dark window behind the page (status bar and navigation bar too)
write(path.join(res, 'values', 'app_colors.xml'), `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="app_bg">#141017</color>
</resources>
`);
const stylesFile = path.join(res, 'values', 'styles.xml');
let styles = read(stylesFile);
const darkItems = `
        <item name="android:windowBackground">@color/app_bg</item>
        <item name="android:statusBarColor">@color/app_bg</item>
        <item name="android:navigationBarColor">@color/app_bg</item>
        <item name="android:windowLightStatusBar">false</item>
        <item name="android:windowLightNavigationBar">false</item>`;
styles = styles.replace(/(<style name="AppTheme\.NoActionBar"[^>]*>)/, `$1${darkItems}`);
styles = styles.replace(/(<style name="AppTheme"[^>]*>)/, `$1${darkItems}`);
styles = styles.replace(/(<style name="AppTheme\.NoActionBarLaunch"[^>]*>)/, `$1
        <item name="windowSplashScreenBackground">@color/app_bg</item>
        <item name="android:windowBackground">@color/app_bg</item>`);
write(stylesFile, styles);

// share files from the app's own folder (pictures and exports live there)
const pathsFile = path.join(res, 'xml', 'file_paths.xml');
let paths = fs.existsSync(pathsFile) ? read(pathsFile) : '<?xml version="1.0" encoding="utf-8"?>\n<paths xmlns:android="http://schemas.android.com/apk/res/android">\n</paths>\n';
if (!paths.includes('<files-path')) paths = paths.replace('</paths>', '    <files-path name="app_files" path="." />\n</paths>');
if (!paths.includes('<cache-path')) paths = paths.replace('</paths>', '    <cache-path name="app_cache" path="." />\n</paths>');
if (!paths.includes('<external-path')) paths = paths.replace('</paths>', '    <external-path name="external" path="." />\n</paths>');
write(pathsFile, paths);

// manifest: old Android versions need storage permission to write to Download / Pictures
const manifestFile = path.join(app, 'src', 'main', 'AndroidManifest.xml');
let manifest = read(manifestFile);
const perms = [
  '<uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="29" />',
  '<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="32" />',
  '<uses-permission android:name="android.permission.WAKE_LOCK" />',
  '<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />',
  '<uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC" />',
  '<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />',
  '<uses-permission android:name="android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS" />',
];
for (const p of perms) if (!manifest.includes(p.split('"')[1])) manifest = manifest.replace(/(<manifest[^>]*>)/, `$1\n    ${p}`);
// the service that keeps the app running (with its notification) while images are made in the background
if (!manifest.includes('GenerationService')) manifest = manifest.replace('</application>',
  '    <service android:name=".GenerationService" android:exported="false" android:foregroundServiceType="dataSync" />\n    </application>');
if (!manifest.includes('requestLegacyExternalStorage')) manifest = manifest.replace('<application', '<application\n        android:requestLegacyExternalStorage="true"');
write(manifestFile, manifest);
// 앱 전용 플러그인(화면 켜 두기, 배터리, 알림)과 그림 생성 서비스(화면과 따로 돌아간다)
const config = JSON.parse(read(path.join(root, 'capacitor.config.json')));
const pkg = config.appId;
const javaDir = path.join(app, 'src', 'main', 'java', ...pkg.split('.'));
write(path.join(javaDir, 'ScreenAwakePlugin.java'), `package ${pkg};

import android.Manifest;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.view.WindowManager;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;

@CapacitorPlugin(name = "ScreenAwake")
public class ScreenAwakePlugin extends Plugin {
    @Override
    protected void handleOnResume() { GenerationService.appVisible = true; }

    @Override
    protected void handleOnPause() { GenerationService.appVisible = false; }

    @PluginMethod
    public void set(PluginCall call) {
        final boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        getActivity().runOnUiThread(() -> {
            if (on) getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            call.resolve();
        });
    }

    // 예전 방식(화면이 진행 알림만 띄우던 것). 지금은 생성 서비스가 알림을 직접 관리하므로 아무것도 하지 않는다.
    @PluginMethod
    public void background(PluginCall call) { call.resolve(); }

    @PluginMethod
    public void notice(PluginCall call) {
        try {
            Context ctx = getContext();
            NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            nm.notify(GenerationService.DONE_ID, GenerationService.note(ctx, call.getString("title", "NAI 작가 셔플"), call.getString("text", ""), false));
            call.resolve();
        } catch (Exception e) {
            call.reject(String.valueOf(e.getMessage()));
        }
    }

    // ---------------------------------------------------------------- 생성 서비스 (화면이 멈춰도 계속 뽑는다)
    // jobs: [{key, body}] body는 NovelAI에 보낼 JSON 문자열. 대기열 파일에 덧붙이고 서비스를 깨운다.
    @PluginMethod
    public void genEnqueue(PluginCall call) {
        Context ctx = getContext();
        boolean start = false;
        try {
            String apiKey = call.getString("apiKey", "");
            JSArray jobs = call.getArray("jobs");
            if (jobs == null || jobs.length() == 0) { call.resolve(); return; }
            synchronized (GenerationService.LOCK) {
                JSONArray q = GenerationService.readArr(GenerationService.queueFile(ctx));
                if (!GenerationService.running) {
                    GenerationService.cancel = false;
                    GenerationService.fatal = null;
                    GenerationService.done = 0;
                    GenerationService.total = q.length();
                }
                for (int i = 0; i < jobs.length(); i++) {
                    JSONObject j = jobs.getJSONObject(i);
                    JSONObject o = new JSONObject();
                    o.put("key", j.getString("key"));
                    o.put("body", j.getString("body"));
                    o.put("apiKey", apiKey);
                    q.put(o);
                }
                GenerationService.total += jobs.length();
                GenerationService.writeText(GenerationService.queueFile(ctx), q.toString());
                if (!GenerationService.running) { GenerationService.running = true; start = true; }
            }
            if (start) ContextCompat.startForegroundService(ctx, new Intent(ctx, GenerationService.class));
            call.resolve();
        } catch (Exception e) {
            if (start) synchronized (GenerationService.LOCK) { GenerationService.running = false; }
            call.reject(String.valueOf(e.getMessage()));
        }
    }

    // 진행 상황: 대기열 키, 끝난 결과, 지금 뽑는 키, 진행 수. 남은 대기열이 있는데 서비스가 꺼져 있으면 다시 켠다.
    @PluginMethod
    public void genStatus(PluginCall call) {
        Context ctx = getContext();
        JSObject out = new JSObject();
        boolean resume = false;
        try {
            synchronized (GenerationService.LOCK) {
                JSONArray q = GenerationService.readArr(GenerationService.queueFile(ctx));
                JSONArray r = GenerationService.readArr(GenerationService.resultsFile(ctx));
                JSArray keys = new JSArray();
                for (int i = 0; i < q.length(); i++) keys.put(q.getJSONObject(i).optString("key"));
                out.put("queueKeys", keys);
                out.put("results", new JSArray(r.toString()));
                if (!GenerationService.running && q.length() > 0) {
                    GenerationService.running = true;
                    GenerationService.cancel = false;
                    GenerationService.done = 0;
                    GenerationService.total = q.length();
                    resume = true;
                }
                out.put("running", GenerationService.running);
                out.put("current", GenerationService.current);
                out.put("done", GenerationService.done);
                out.put("total", GenerationService.total);
                long left = GenerationService.retryAt - System.currentTimeMillis();
                out.put("retryIn", left > 0 ? (int) Math.ceil(left / 1000.0) : 0);
            }
            if (resume) {
                try { ContextCompat.startForegroundService(ctx, new Intent(ctx, GenerationService.class)); }
                catch (Exception e) { synchronized (GenerationService.LOCK) { GenerationService.running = false; } }
            }
            call.resolve(out);
        } catch (Exception e) {
            call.reject(String.valueOf(e.getMessage()));
        }
    }

    // 화면이 가져간 결과는 지운다 (그림 파일도).
    @PluginMethod
    public void genAck(PluginCall call) {
        Context ctx = getContext();
        try {
            JSArray keys = call.getArray("keys");
            java.util.HashSet<String> set = new java.util.HashSet<>();
            if (keys != null) for (int i = 0; i < keys.length(); i++) set.add(keys.getString(i));
            synchronized (GenerationService.LOCK) {
                JSONArray r = GenerationService.readArr(GenerationService.resultsFile(ctx));
                JSONArray keep = new JSONArray();
                for (int i = 0; i < r.length(); i++) {
                    JSONObject o = r.getJSONObject(i);
                    String k = o.optString("key");
                    if (set.contains(k)) {
                        File f = GenerationService.imgFile(ctx, k);
                        if (f.exists()) f.delete();
                    } else keep.put(o);
                }
                GenerationService.writeText(GenerationService.resultsFile(ctx), keep.toString());
            }
            call.resolve();
        } catch (Exception e) {
            call.reject(String.valueOf(e.getMessage()));
        }
    }

    @PluginMethod
    public void genCancel(PluginCall call) {
        Context ctx = getContext();
        try {
            synchronized (GenerationService.LOCK) {
                GenerationService.cancel = true;
                if (!GenerationService.running) GenerationService.stopQueued(ctx, "멈췄어요");
            }
            call.resolve();
        } catch (Exception e) {
            call.reject(String.valueOf(e.getMessage()));
        }
    }

    @PluginMethod
    public void battery(PluginCall call) {
        JSObject out = new JSObject();
        try {
            android.os.PowerManager pm = (android.os.PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
            boolean free = Build.VERSION.SDK_INT < 23 || pm.isIgnoringBatteryOptimizations(getContext().getPackageName());
            out.put("unrestricted", free);
            if (!free && Boolean.TRUE.equals(call.getBoolean("ask", false))) {
                Intent intent = new Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                intent.setData(android.net.Uri.parse("package:" + getContext().getPackageName()));
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(intent);
            }
            call.resolve(out);
        } catch (Exception e) {
            call.reject(String.valueOf(e.getMessage()));
        }
    }

    @PluginMethod
    public void askNotifications(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(getActivity(), new String[] { Manifest.permission.POST_NOTIFICATIONS }, 7301);
        }
        call.resolve();
    }
}
`);
write(path.join(javaDir, 'GenerationService.java'), `package ${pkg};

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import androidx.core.app.NotificationCompat;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

// 그림 생성을 화면(웹뷰)과 따로 돌리는 포그라운드 서비스. 대기열은 파일(gen/queue.json),
// 끝난 결과는 gen/results.json, 그림은 gen/img/<key>.png. 화면이 멈추거나 닫혀도 계속 뽑는다.
public class GenerationService extends Service {
    static final String CHANNEL = "generation";
    static final int NOTE_ID = 7300;
    static final int DONE_ID = 7302;
    static final String GEN_URL = "https://image.novelai.net/ai/generate-image";
    static final int[] RETRY_DELAYS = { 5, 15, 45 };
    static final Object LOCK = new Object();
    static volatile boolean running = false;
    static volatile boolean cancel = false;
    static volatile boolean appVisible = true;
    static volatile String current = null;
    static volatile String fatal = null;
    static volatile int done = 0;
    static volatile int total = 0;
    static volatile long retryAt = 0;

    private Thread worker;
    private PowerManager.WakeLock lock;
    private WifiManager.WifiLock wifi;

    // ---------------------------------------------------------------- files
    static File dir(Context c) { File d = new File(c.getFilesDir(), "gen"); new File(d, "img").mkdirs(); return d; }
    static File queueFile(Context c) { return new File(dir(c), "queue.json"); }
    static File resultsFile(Context c) { return new File(dir(c), "results.json"); }
    static File imgFile(Context c, String key) { return new File(new File(dir(c), "img"), key.replaceAll("[^A-Za-z0-9_-]", "_") + ".png"); }

    static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[65536];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        return out.toByteArray();
    }

    static JSONArray readArr(File f) {
        try {
            if (!f.exists()) return new JSONArray();
            FileInputStream in = new FileInputStream(f);
            try { return new JSONArray(new String(readAll(in), "UTF-8")); } finally { in.close(); }
        } catch (Exception e) {
            return new JSONArray();
        }
    }

    static void writeBytes(File f, byte[] data) throws IOException {
        File tmp = new File(f.getPath() + ".tmp");
        FileOutputStream out = new FileOutputStream(tmp);
        try { out.write(data); out.getFD().sync(); } finally { out.close(); }
        if (!tmp.renameTo(f)) { f.delete(); if (!tmp.renameTo(f)) throw new IOException("파일을 저장하지 못했습니다: " + f.getName()); }
    }

    static void writeText(File f, String s) throws IOException { writeBytes(f, s.getBytes("UTF-8")); }

    // 남은 대기열을 모두 '중단' 결과로 옮긴다. LOCK 안에서 부른다.
    static void stopQueued(Context c, String why) throws Exception {
        JSONArray q = readArr(queueFile(c));
        if (q.length() == 0) return;
        JSONArray r = readArr(resultsFile(c));
        for (int i = 0; i < q.length(); i++) {
            JSONObject o = new JSONObject();
            o.put("key", q.getJSONObject(i).optString("key"));
            o.put("status", "stop");
            o.put("error", why);
            r.put(o);
        }
        writeText(resultsFile(c), r.toString());
        writeText(queueFile(c), "[]");
    }

    // ---------------------------------------------------------------- notifications
    static Notification note(Context ctx, String title, String text, boolean ongoing) {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm.getNotificationChannel(CHANNEL) == null) {
                NotificationChannel ch = new NotificationChannel(CHANNEL, "그림 생성", NotificationManager.IMPORTANCE_LOW);
                ch.setDescription("백그라운드에서 그림을 뽑는 동안 진행 상황을 보여 줍니다.");
                nm.createNotificationChannel(ch);
            }
        }
        Intent open = ctx.getPackageManager().getLaunchIntentForPackage(ctx.getPackageName());
        if (open == null) open = new Intent(ctx, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent tap = PendingIntent.getActivity(ctx, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new NotificationCompat.Builder(ctx, CHANNEL)
            .setSmallIcon(ongoing ? android.R.drawable.stat_sys_download : android.R.drawable.stat_sys_download_done)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(tap)
            .setOngoing(ongoing)
            .setAutoCancel(!ongoing)
            .setOnlyAlertOnce(true)
            .setSilent(ongoing)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build();
    }

    private String progressText() {
        String t = Math.min(done + 1, Math.max(total, 1)) + " / " + Math.max(total, 1);
        long left = retryAt - System.currentTimeMillis();
        if (left > 0) t += " · " + (int) Math.ceil(left / 1000.0) + "초 뒤 다시 시도";
        return t;
    }

    private void updateNote() {
        try {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            nm.notify(NOTE_ID, note(this, "그림을 뽑는 중", progressText(), true));
        } catch (Exception ignored) { }
    }

    // ---------------------------------------------------------------- service
    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Notification n = note(this, "그림을 뽑는 중", progressText(), true);
        try {
            if (Build.VERSION.SDK_INT >= 29) startForeground(NOTE_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
            else startForeground(NOTE_ID, n);
        } catch (Exception e) {
            synchronized (LOCK) { running = false; }
            stopSelf();
            return START_NOT_STICKY;
        }
        if (lock == null) {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            lock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "naiartistshuffle:generation");
            lock.setReferenceCounted(false);
            lock.acquire(6 * 60 * 60 * 1000L);
        }
        if (wifi == null) {
            try {
                WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
                wifi = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "naiartistshuffle:wifi");
                wifi.setReferenceCounted(false);
                wifi.acquire();
            } catch (Exception ignored) { wifi = null; }
        }
        if (worker == null || !worker.isAlive()) {
            worker = new Thread(this::work, "nai-generation");
            worker.start();
        }
        return START_NOT_STICKY;
    }

    private void work() {
        boolean wasCancelled = false;
        int made = 0;
        try {
            while (true) {
                JSONObject job;
                synchronized (LOCK) {
                    if (cancel) {
                        stopQueued(this, fatal != null ? fatal : "멈췄어요");
                        wasCancelled = true;
                        running = false;
                        break;
                    }
                    JSONArray q = readArr(queueFile(this));
                    if (q.length() == 0) { running = false; break; }
                    job = q.getJSONObject(0);
                }
                String key = job.optString("key");
                current = key;
                updateNote();
                JSONObject res = process(job);
                synchronized (LOCK) {
                    JSONArray q = readArr(queueFile(this));
                    JSONArray rest = new JSONArray();
                    boolean removed = false;
                    for (int i = 0; i < q.length(); i++) {
                        JSONObject o = q.getJSONObject(i);
                        if (!removed && key.equals(o.optString("key"))) { removed = true; continue; }
                        rest.put(o);
                    }
                    writeText(queueFile(this), rest.toString());
                    JSONArray r = readArr(resultsFile(this));
                    r.put(res);
                    writeText(resultsFile(this), r.toString());
                    done++;
                    if ("done".equals(res.optString("status"))) made++;
                    if (res.optBoolean("fatal")) { fatal = res.optString("error"); cancel = true; }
                    current = null;
                }
            }
        } catch (Exception e) {
            synchronized (LOCK) { running = false; fatal = "백그라운드 생성 오류: " + e.getMessage(); }
        }
        current = null;
        retryAt = 0;
        String why = fatal;
        cancel = false;
        if (!appVisible) {
            try {
                NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
                String title = why != null ? "뽑기가 멈췄어요" : wasCancelled ? "뽑기를 멈췄어요" : "다 뽑았어요";
                nm.notify(DONE_ID, note(this, title, why != null ? why : made + "장", false));
            } catch (Exception ignored) { }
        }
        stopSelf();
    }

    private static String reason(int code) {
        switch (code) {
            case 400: return "요청이 거부되었습니다. 프롬프트나 설정 값을 확인해 주세요.";
            case 401: return "API 키가 만료되었거나 올바르지 않습니다.";
            case 402: return "Anlas가 부족하거나 구독이 필요합니다.";
            case 403: return "이 작업을 할 권한이 없습니다. 구독 상태를 확인해 주세요.";
            case 429: return "요청이 너무 많습니다.";
            default: return code >= 500 ? "NovelAI 서버 오류입니다 (HTTP " + code + ")." : "HTTP " + code;
        }
    }

    static byte[] extractPng(byte[] d) throws IOException {
        if (d.length > 8 && (d[0] & 0xff) == 0x89 && d[1] == 'P' && d[2] == 'N' && d[3] == 'G') return d;
        ZipInputStream z = new ZipInputStream(new ByteArrayInputStream(d));
        try {
            ZipEntry e;
            while ((e = z.getNextEntry()) != null) {
                if (e.getName().toLowerCase().endsWith(".png")) return readAll(z);
            }
        } finally { z.close(); }
        return null;
    }

    private JSONObject process(JSONObject job) {
        JSONObject res = new JSONObject();
        String key = job.optString("key");
        String lastErr = "";
        try {
            res.put("key", key);
            byte[] body = job.getString("body").getBytes("UTF-8");
            String apiKey = job.optString("apiKey", "").trim();
            for (int attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
                if (cancel) { res.put("status", "stop"); res.put("error", fatal != null ? fatal : "멈췄어요"); return res; }
                try {
                    HttpURLConnection c = (HttpURLConnection) new URL(GEN_URL).openConnection();
                    c.setRequestMethod("POST");
                    c.setDoOutput(true);
                    c.setConnectTimeout(30000);
                    c.setReadTimeout(150000);
                    c.setFixedLengthStreamingMode(body.length);
                    c.setRequestProperty("Content-Type", "application/json");
                    c.setRequestProperty("Authorization", "Bearer " + apiKey);
                    c.setRequestProperty("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36");
                    c.setRequestProperty("Referer", "https://novelai.net/");
                    c.setRequestProperty("Origin", "https://novelai.net");
                    c.setRequestProperty("Accept", "*/*");
                    c.setRequestProperty("Accept-Language", "en-US,en;q=0.9");
                    OutputStream os = c.getOutputStream();
                    try { os.write(body); } finally { os.close(); }
                    int code = c.getResponseCode();
                    InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
                    byte[] data = in == null ? new byte[0] : readAll(in);
                    if (in != null) in.close();
                    c.disconnect();
                    if (code == 200) {
                        byte[] png = extractPng(data);
                        if (png == null) { res.put("status", "fail"); res.put("error", "응답에서 PNG를 찾지 못했습니다."); return res; }
                        writeBytes(imgFile(this, key), png);
                        res.put("status", "done");
                        return res;
                    }
                    String text = new String(data, 0, Math.min(data.length, 200), "UTF-8");
                    lastErr = reason(code) + (text.isEmpty() ? "" : " (" + text + ")");
                    if (code == 400 || code == 401 || code == 402 || code == 403) {
                        res.put("status", "fail"); res.put("error", lastErr); res.put("fatal", true);
                        return res;
                    }
                    if (!(code == 429 || code >= 500)) { res.put("status", "fail"); res.put("error", lastErr); return res; }
                } catch (IOException e) {
                    lastErr = "NovelAI에 연결하지 못했습니다: " + e.getMessage();
                }
                if (attempt < RETRY_DELAYS.length) {
                    retryAt = System.currentTimeMillis() + RETRY_DELAYS[attempt] * 1000L;
                    while (System.currentTimeMillis() < retryAt && !cancel) {
                        updateNote();
                        try { Thread.sleep(1000); } catch (InterruptedException ignored) { }
                    }
                    retryAt = 0;
                }
            }
            res.put("status", "fail");
            res.put("error", lastErr);
        } catch (Exception e) {
            try { res.put("status", "fail"); res.put("error", "생성 중 오류: " + e.getMessage()); } catch (Exception ignored) { }
        }
        return res;
    }

    @Override
    public void onTimeout(int startId) {  // Android 15: dataSync 시간 제한
        cancel = true;
        stopSelf();
    }

    @Override
    public void onDestroy() {
        if (lock != null && lock.isHeld()) lock.release();
        lock = null;
        if (wifi != null && wifi.isHeld()) wifi.release();
        wifi = null;
        stopForeground(true);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
`);
write(path.join(javaDir, 'MainActivity.java'), `package ${pkg};

import android.os.Build;
import android.os.Bundle;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ScreenAwakePlugin.class);
        super.onCreate(savedInstanceState);
        // the page keeps its priority in the background, so Android does not drop it while images are made
        try {
            if (Build.VERSION.SDK_INT >= 26 && getBridge() != null && getBridge().getWebView() != null) {
                getBridge().getWebView().setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
            }
        } catch (Exception ignored) { }
    }
}
`);
console.log('android project patched');
