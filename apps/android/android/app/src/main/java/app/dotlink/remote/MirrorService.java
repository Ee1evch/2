package app.dotlink.remote;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.ComponentCallbacks;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.content.res.Configuration;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaFormat;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.DisplayMetrics;
import android.view.Surface;
import android.view.WindowManager;

import java.nio.ByteBuffer;

/**
 * Трансляция экрана телефона на ПК: MediaProjection → виртуальный дисплей → аппаратный кодер H.264
 * в режиме низкой задержки. Кадры (Annex B) уходят в {@link Sink} — плагин передаёт их в WebView,
 * а оттуда они идут на ПК зашифрованной сессией. При повороте экрана кодер перезапускается
 * с новыми размерами. Работает как foreground-сервис: Android показывает значок записи экрана.
 */
public class MirrorService extends Service {
    public interface Sink {
        void frame(byte[] data, int flags, long ptsUs, int w, int h);
        void state(boolean on, int w, int h, String why);
    }

    static final String EXTRA_CODE = "code", EXTRA_DATA = "data", EXTRA_MAX = "max", EXTRA_BITRATE = "bitrate", EXTRA_FPS = "fps";
    static final int FLAG_KEY = 1, FLAG_CONFIG = 2;
    private static final String CHANNEL = "mirror";

    static volatile Sink sink;
    static volatile MirrorService running;

    private MediaProjection projection;
    private VirtualDisplay display;
    private MediaCodec codec;
    private Thread drain;
    private int w, h, max = 1280, bitrate = 6_000_000, fps = 60;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ComponentCallbacks rotation = new ComponentCallbacks() {
        @Override public void onConfigurationChanged(Configuration c) { main.postDelayed(MirrorService.this::restartIfRotated, 200); }
        @Override public void onLowMemory() { }
    };

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) { stopSelf(); return START_NOT_STICKY; }
        startForegroundCompat();
        max = intent.getIntExtra(EXTRA_MAX, max);
        bitrate = intent.getIntExtra(EXTRA_BITRATE, bitrate);
        fps = intent.getIntExtra(EXTRA_FPS, fps);
        MediaProjectionManager mpm = (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        Intent data = intent.getParcelableExtra(EXTRA_DATA);
        try {
            projection = mpm.getMediaProjection(intent.getIntExtra(EXTRA_CODE, 0), data);
        } catch (Exception e) {
            fail("нет разрешения на запись экрана");
            return START_NOT_STICKY;
        }
        if (projection == null) { fail("нет разрешения на запись экрана"); return START_NOT_STICKY; }
        projection.registerCallback(new MediaProjection.Callback() {
            @Override public void onStop() { main.post(MirrorService.this::stopSelf); }
        }, main);
        running = this;
        registerComponentCallbacks(rotation);
        try {
            begin();
        } catch (Exception e) {
            fail("кодер не запустился: " + e.getMessage());
        }
        return START_NOT_STICKY;
    }

    private void startForegroundCompat() {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL) == null) {
            nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Трансляция экрана", NotificationManager.IMPORTANCE_LOW));
        }
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        Notification n = b.setSmallIcon(android.R.drawable.ic_menu_slideshow)
            .setContentTitle("Экран транслируется на ПК")
            .setContentText("DotLink · остановить можно с ПК или здесь")
            .setContentIntent(pi)
            .setOngoing(true)
            .build();
        if (Build.VERSION.SDK_INT >= 29) startForeground(7, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
        else startForeground(7, n);
    }

    /** Размер кадра: длинная сторона не больше max, обе кратны 16 — так любят аппаратные кодеры. */
    private int[] size() {
        DisplayMetrics m = new DisplayMetrics();
        ((WindowManager) getSystemService(WINDOW_SERVICE)).getDefaultDisplay().getRealMetrics(m);
        double k = Math.min(1.0, (double) max / Math.max(m.widthPixels, m.heightPixels));
        int sw = Math.max(16, (int) Math.round(m.widthPixels * k) / 16 * 16);
        int sh = Math.max(16, (int) Math.round(m.heightPixels * k) / 16 * 16);
        return new int[] { sw, sh, m.densityDpi };
    }

    private void begin() throws Exception {
        int[] s = size();
        w = s[0];
        h = s[1];
        MediaFormat f = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, w, h);
        f.setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface);
        f.setInteger(MediaFormat.KEY_BIT_RATE, bitrate);
        f.setInteger(MediaFormat.KEY_FRAME_RATE, fps);
        f.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 2);
        // неподвижный экран: кодер повторяет кадр, чтобы ПК не ждал
        f.setLong(MediaFormat.KEY_REPEAT_PREVIOUS_FRAME_AFTER, 100_000);
        f.setInteger(MediaFormat.KEY_PROFILE, MediaCodecInfo.CodecProfileLevel.AVCProfileBaseline);
        f.setInteger(MediaFormat.KEY_LEVEL, MediaCodecInfo.CodecProfileLevel.AVCLevel41);
        if (Build.VERSION.SDK_INT >= 30) f.setInteger(MediaFormat.KEY_LOW_LATENCY, 1);
        if (Build.VERSION.SDK_INT >= 23) f.setInteger(MediaFormat.KEY_PRIORITY, 0);
        codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC);
        try {
            codec.configure(f, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
        } catch (Exception e) {
            // часть кодеров не принимает профиль/уровень — без них
            f.removeKey(MediaFormat.KEY_PROFILE);
            f.removeKey(MediaFormat.KEY_LEVEL);
            codec.configure(f, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
        }
        Surface input = codec.createInputSurface();
        codec.start();
        display = projection.createVirtualDisplay("DotLink", w, h, s[2], DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, input, null, null);
        final MediaCodec c = codec;
        final int fw = w, fh = h;
        drain = new Thread(() -> pump(c, fw, fh), "dotlink-mirror");
        drain.start();
        Sink sk = sink;
        if (sk != null) sk.state(true, w, h, null);
    }

    private static void pump(MediaCodec c, int w, int h) {
        MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
        while (!Thread.currentThread().isInterrupted()) {
            int i;
            try { i = c.dequeueOutputBuffer(info, 100_000); } catch (Exception e) { return; }
            if (i < 0) continue;
            try {
                ByteBuffer out = c.getOutputBuffer(i);
                if (out != null && info.size > 0) {
                    byte[] data = new byte[info.size];
                    out.position(info.offset);
                    out.get(data);
                    int flags = 0;
                    if ((info.flags & MediaCodec.BUFFER_FLAG_KEY_FRAME) != 0) flags |= FLAG_KEY;
                    if ((info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0) flags |= FLAG_CONFIG;
                    Sink sk = sink;
                    if (sk != null) sk.frame(data, flags, info.presentationTimeUs, w, h);
                }
                c.releaseOutputBuffer(i, false);
            } catch (Exception e) {
                return;
            }
            if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) return;
        }
    }

    private void end() {
        if (drain != null) { drain.interrupt(); try { drain.join(300); } catch (InterruptedException ignored) { } drain = null; }
        if (display != null) { display.release(); display = null; }
        if (codec != null) { try { codec.stop(); } catch (Exception ignored) { } codec.release(); codec = null; }
    }

    private void restartIfRotated() {
        if (projection == null || codec == null) return;
        int[] s = size();
        if (s[0] == w && s[1] == h) return;
        end();
        try { begin(); } catch (Exception e) { fail("кодер не перезапустился: " + e.getMessage()); }
    }

    /** Новый ключевой кадр — ПК только подключился или потерял кадр. */
    void requestKeyFrame() {
        MediaCodec c = codec;
        if (c == null) return;
        Bundle b = new Bundle();
        b.putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0);
        try { c.setParameters(b); } catch (Exception ignored) { }
    }

    void setBitrate(int bps) {
        MediaCodec c = codec;
        if (c == null || bps <= 0) return;
        Bundle b = new Bundle();
        b.putInt(MediaCodec.PARAMETER_KEY_VIDEO_BITRATE, bps);
        try { c.setParameters(b); } catch (Exception ignored) { }
    }

    private void fail(String why) {
        Sink sk = sink;
        if (sk != null) sk.state(false, 0, 0, why);
        stopSelf();
    }

    @Override
    public void onDestroy() {
        try { unregisterComponentCallbacks(rotation); } catch (Exception ignored) { }
        end();
        if (projection != null) { projection.stop(); projection = null; }
        if (running == this) running = null;
        Sink sk = sink;
        if (sk != null) sk.state(false, 0, 0, null);
        super.onDestroy();
    }
}
