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
// keep the screen on while images are being made: a tiny plugin of this app (ScreenAwake.set({ on }))
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
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "ScreenAwake")
public class ScreenAwakePlugin extends Plugin {
    @PluginMethod
    public void set(PluginCall call) {
        final boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        getActivity().runOnUiThread(() -> {
            if (on) getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            call.resolve();
        });
    }

    // Background generation: a foreground service (its notification shows the progress) keeps Android from
    // freezing the app while another app is on screen. on: start or update; off: stop.
    @PluginMethod
    public void background(PluginCall call) {
        final boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        final String title = call.getString("title", "그림을 만드는 중");
        final String text = call.getString("text", "");
        final Context ctx = getContext();
        try {
            if (on) {
                if (GenerationService.running) {
                    NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
                    nm.notify(GenerationService.NOTE_ID, GenerationService.note(ctx, title, text, true));
                } else {
                    Intent intent = new Intent(ctx, GenerationService.class);
                    intent.putExtra("title", title);
                    intent.putExtra("text", text);
                    ContextCompat.startForegroundService(ctx, intent);
                }
            } else {
                ctx.stopService(new Intent(ctx, GenerationService.class));
            }
            call.resolve();
        } catch (Exception e) {
            call.reject(String.valueOf(e.getMessage()));
        }
    }

    // A one-off notice (images finished while the app was in the background).
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

    // Battery: whether Android may still stop this app in the background, and the system screen to allow it.
    @PluginMethod
    public void battery(PluginCall call) {
        com.getcapacitor.JSObject out = new com.getcapacitor.JSObject();
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

    // Android 13+: the notification needs the user's permission (asked once; the service runs either way).
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
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import androidx.core.app.NotificationCompat;

public class GenerationService extends Service {
    static final String CHANNEL = "generation";
    static final int NOTE_ID = 7300;
    static final int DONE_ID = 7302;
    static volatile boolean running = false;
    private PowerManager.WakeLock lock;

    static Notification note(Context ctx, String title, String text, boolean ongoing) {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm.getNotificationChannel(CHANNEL) == null) {
                NotificationChannel ch = new NotificationChannel(CHANNEL, "그림 생성", NotificationManager.IMPORTANCE_LOW);
                ch.setDescription("백그라운드에서 그림을 만드는 동안 진행 상황을 보여 줍니다.");
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

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String title = intent != null && intent.getStringExtra("title") != null ? intent.getStringExtra("title") : "그림을 만드는 중";
        String text = intent != null && intent.getStringExtra("text") != null ? intent.getStringExtra("text") : "";
        Notification n = note(this, title, text, true);
        try {
            if (Build.VERSION.SDK_INT >= 29) startForeground(NOTE_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
            else startForeground(NOTE_ID, n);
        } catch (Exception e) {
            stopSelf();
            return START_NOT_STICKY;
        }
        running = true;
        if (lock == null) {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            lock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "naiartistshuffle:generation");
            lock.setReferenceCounted(false);
            lock.acquire(6 * 60 * 60 * 1000L);
        }
        return START_NOT_STICKY;
    }

    @Override
    public void onTimeout(int startId) {  // Android 15: dataSync time limit reached
        stopSelf();
    }

    @Override
    public void onDestroy() {
        running = false;
        if (lock != null && lock.isHeld()) lock.release();
        lock = null;
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
