package app.dotlink.remote;

import android.Manifest;
import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ComponentName;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.provider.Settings;
import android.util.Base64;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.PermissionState;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import android.database.Cursor;
import android.net.Uri;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Handler;
import android.os.Looper;
import android.provider.OpenableColumns;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Нативная часть DotLink: поиск ПК в сети (mDNS + UDP-маяк), файлы и ссылки из «Поделиться»,
 * трансляция экрана ({@link MirrorService}), управление телефоном с ПК ({@link ControlService}),
 * уведомления на ПК ({@link NotifyService}), Bluetooth-канал ({@link BtLink}), буфер обмена.
 */
@CapacitorPlugin(
    name = "DotLink",
    permissions = {
        @Permission(alias = "bluetooth", strings = { Manifest.permission.BLUETOOTH_CONNECT }),
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }),
    }
)
public class DotLinkPlugin extends Plugin {
    private static final String SERVICE = "_dotlink._tcp.";
    private static final int BEACON_PORT = 47801;
    private static final List<JSObject> shared = Collections.synchronizedList(new ArrayList<>());
    private static final List<String> sharedTexts = Collections.synchronizedList(new ArrayList<>());
    private final Map<Integer, BtLink> bt = new ConcurrentHashMap<>();
    private final AtomicInteger btIds = new AtomicInteger();
    private final ExecutorService io = Executors.newCachedThreadPool();

    // ───────── поиск ─────────

    @PluginMethod
    public void discover(PluginCall call) {
        final int timeout = Math.max(800, Math.min(10000, call.getInt("timeout", 2500)));
        final Map<String, JSObject> found = Collections.synchronizedMap(new LinkedHashMap<>());
        Context ctx = getContext();
        WifiManager wifi = (WifiManager) ctx.getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        final WifiManager.MulticastLock lock = wifi != null ? wifi.createMulticastLock("dotlink") : null;
        if (lock != null) {
            lock.setReferenceCounted(false);
            lock.acquire();
        }
        final NsdManager nsd = (NsdManager) ctx.getSystemService(Context.NSD_SERVICE);
        final NsdManager.DiscoveryListener listener = nsd != null ? startNsd(nsd, found) : null;
        io.execute(() -> udpProbe(found, timeout));

        new Handler(Looper.getMainLooper()).postDelayed(() -> {
            if (nsd != null && listener != null) {
                try { nsd.stopServiceDiscovery(listener); } catch (Exception ignored) { }
            }
            if (lock != null && lock.isHeld()) lock.release();
            JSArray arr = new JSArray();
            synchronized (found) { for (JSObject o : found.values()) arr.put(o); }
            JSObject ret = new JSObject();
            ret.put("pcs", arr);
            call.resolve(ret);
        }, timeout);
    }

    private static void put(Map<String, JSObject> found, String id, String name, String host, int port, String via) {
        if (id == null || id.isEmpty() || host == null || host.contains(":")) return; // только IPv4
        String key = id + "@" + host;
        if (found.containsKey(key)) return;
        JSObject o = new JSObject();
        o.put("id", id);
        o.put("name", name == null || name.isEmpty() ? host : name);
        o.put("host", host);
        o.put("port", port);
        o.put("via", via);
        found.put(key, o);
    }

    private NsdManager.DiscoveryListener startNsd(NsdManager nsd, Map<String, JSObject> found) {
        // старые Android разрешают только одно разрешение имени за раз — ставим в очередь
        final ArrayDeque<NsdServiceInfo> queue = new ArrayDeque<>();
        final boolean[] resolving = {false};
        final Runnable[] next = new Runnable[1];
        next[0] = () -> {
            NsdServiceInfo s;
            synchronized (queue) {
                if (resolving[0] || queue.isEmpty()) return;
                s = queue.poll();
                resolving[0] = true;
            }
            nsd.resolveService(s, new NsdManager.ResolveListener() {
                @Override public void onResolveFailed(NsdServiceInfo info, int code) {
                    synchronized (queue) { resolving[0] = false; }
                    next[0].run();
                }
                @Override public void onServiceResolved(NsdServiceInfo info) {
                    InetAddress h = info.getHost();
                    Map<String, byte[]> a = info.getAttributes();
                    String id = a.get("id") != null ? new String(a.get("id"), StandardCharsets.UTF_8) : null;
                    String name = a.get("name") != null ? new String(a.get("name"), StandardCharsets.UTF_8) : info.getServiceName();
                    if (h != null) put(found, id, name, h.getHostAddress(), info.getPort(), "mdns");
                    synchronized (queue) { resolving[0] = false; }
                    next[0].run();
                }
            });
        };
        NsdManager.DiscoveryListener l = new NsdManager.DiscoveryListener() {
            @Override public void onStartDiscoveryFailed(String t, int c) { }
            @Override public void onStopDiscoveryFailed(String t, int c) { }
            @Override public void onDiscoveryStarted(String t) { }
            @Override public void onDiscoveryStopped(String t) { }
            @Override public void onServiceLost(NsdServiceInfo s) { }
            @Override public void onServiceFound(NsdServiceInfo s) {
                synchronized (queue) { queue.add(s); }
                next[0].run();
            }
        };
        try {
            nsd.discoverServices(SERVICE, NsdManager.PROTOCOL_DNS_SD, l);
            return l;
        } catch (Exception e) {
            return null;
        }
    }

    /** Широковещательный «DOTLINK?» на все интерфейсы: Wi-Fi, хотспот, USB-модем. */
    private static void udpProbe(Map<String, JSObject> found, int timeout) {
        try (DatagramSocket s = new DatagramSocket()) {
            s.setBroadcast(true);
            byte[] probe = "DOTLINK?".getBytes(StandardCharsets.US_ASCII);
            List<InetAddress> targets = new ArrayList<>();
            targets.add(InetAddress.getByName("255.255.255.255"));
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (InterfaceAddress ia : ni.getInterfaceAddresses()) {
                    if (ia.getBroadcast() != null) targets.add(ia.getBroadcast());
                }
            }
            long deadline = System.currentTimeMillis() + timeout - 150;
            for (int round = 0; round < 2; round++) {
                for (InetAddress t : targets) {
                    try { s.send(new DatagramPacket(probe, probe.length, t, BEACON_PORT)); } catch (Exception ignored) { }
                }
                long until = Math.min(deadline, System.currentTimeMillis() + timeout / 2);
                byte[] buf = new byte[2048];
                while (System.currentTimeMillis() < until) {
                    s.setSoTimeout((int) Math.max(50, until - System.currentTimeMillis()));
                    DatagramPacket p = new DatagramPacket(buf, buf.length);
                    try { s.receive(p); } catch (SocketTimeoutException e) { break; }
                    try {
                        JSONObject j = new JSONObject(new String(p.getData(), 0, p.getLength(), StandardCharsets.UTF_8));
                        if (!"dotlink".equals(j.optString("t"))) continue;
                        put(found, j.optString("id"), j.optString("name"), p.getAddress().getHostAddress(), j.optInt("port", 47800), "udp");
                    } catch (Exception ignored) { }
                }
            }
        } catch (Exception ignored) { }
    }

    // ───────── «Поделиться» ─────────

    /** Вызывается из MainActivity для каждого входящего Intent. */
    static boolean takeIntent(Context ctx, Intent intent) {
        if (intent == null) return false;
        String action = intent.getAction();
        List<Uri> uris = new ArrayList<>();
        if (Intent.ACTION_SEND.equals(action)) {
            Uri u = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (u != null) uris.add(u);
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            ArrayList<Uri> list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (list != null) uris.addAll(list);
        }
        String text = intent.getStringExtra(Intent.EXTRA_TEXT);
        if (uris.isEmpty() && text != null && !text.trim().isEmpty()) {
            sharedTexts.add(text.trim());
            intent.setAction(Intent.ACTION_MAIN);
            return true;
        }
        if (uris.isEmpty()) return false;
        ContentResolver cr = ctx.getContentResolver();
        for (Uri u : uris) {
            JSObject o = new JSObject();
            o.put("uri", u.toString());
            String name = "файл";
            long size = -1;
            try (Cursor c = cr.query(u, null, null, null, null)) {
                if (c != null && c.moveToFirst()) {
                    int n = c.getColumnIndex(OpenableColumns.DISPLAY_NAME), sz = c.getColumnIndex(OpenableColumns.SIZE);
                    if (n >= 0) name = c.getString(n);
                    if (sz >= 0 && !c.isNull(sz)) size = c.getLong(sz);
                }
            } catch (Exception ignored) { }
            o.put("name", name);
            o.put("size", size);
            o.put("type", cr.getType(u) != null ? cr.getType(u) : "application/octet-stream");
            shared.add(o);
        }
        intent.setAction(Intent.ACTION_MAIN);
        return true;
    }

    void notifyShared() {
        notifyListeners("shared", new JSObject(), true);
    }

    @PluginMethod
    public void getShared(PluginCall call) {
        JSArray arr = new JSArray(), texts = new JSArray();
        synchronized (shared) {
            for (JSObject o : shared) arr.put(o);
            shared.clear();
        }
        synchronized (sharedTexts) {
            for (String t : sharedTexts) texts.put(t);
            sharedTexts.clear();
        }
        JSObject ret = new JSObject();
        ret.put("files", arr);
        ret.put("texts", texts);
        call.resolve(ret);
    }

    /** PUT содержимого content:// по ссылке-билету от ПК. */
    @PluginMethod
    public void upload(PluginCall call) {
        final String uri = call.getString("uri"), url = call.getString("url");
        if (uri == null || url == null) { call.reject("uri и url обязательны"); return; }
        io.execute(() -> {
            HttpURLConnection c = null;
            try (InputStream in = getContext().getContentResolver().openInputStream(Uri.parse(uri))) {
                if (in == null) throw new Exception("файл недоступен");
                c = (HttpURLConnection) new URL(url).openConnection();
                c.setRequestMethod("PUT");
                c.setDoOutput(true);
                c.setChunkedStreamingMode(1 << 16);
                c.setConnectTimeout(5000);
                try (OutputStream out = c.getOutputStream()) {
                    byte[] buf = new byte[1 << 16];
                    int n;
                    while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                }
                int code = c.getResponseCode();
                if (code / 100 != 2) throw new Exception("ПК ответил " + code);
                call.resolve();
            } catch (Exception e) {
                call.reject(e.getMessage() != null ? e.getMessage() : "ошибка загрузки");
            } finally {
                if (c != null) c.disconnect();
            }
        });
    }

    // ───────── ссылки и буфер обмена ─────────

    @PluginMethod
    public void openUrl(PluginCall call) {
        String url = call.getString("url");
        if (url == null) { call.reject("нет ссылки"); return; }
        try {
            Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject("нечем открыть ссылку");
        }
    }

    @PluginMethod
    public void readClipboard(PluginCall call) {
        ClipboardManager cm = (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
        JSObject ret = new JSObject();
        ClipData c = cm != null ? cm.getPrimaryClip() : null;
        if (c != null && c.getItemCount() > 0) {
            CharSequence t = c.getItemAt(0).coerceToText(getContext());
            if (t != null) ret.put("text", t.toString());
        }
        call.resolve(ret);
    }

    @PluginMethod
    public void writeClipboard(PluginCall call) {
        ClipboardManager cm = (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
        if (cm == null) { call.reject("буфер недоступен"); return; }
        cm.setPrimaryClip(ClipData.newPlainText("DotLink", call.getString("text", "")));
        call.resolve();
    }

    // ───────── трансляция экрана ─────────

    private final MirrorService.Sink mirrorSink = new MirrorService.Sink() {
        @Override public void frame(byte[] data, int flags, long ptsUs, int w, int h) {
            JSObject o = new JSObject();
            o.put("d", Base64.encodeToString(data, Base64.NO_WRAP));
            o.put("f", flags);
            o.put("t", ptsUs / 1000);
            o.put("w", w);
            o.put("h", h);
            notifyListeners("mirrorFrame", o);
        }
        @Override public void state(boolean on, int w, int h, String why) {
            JSObject o = new JSObject();
            o.put("on", on);
            o.put("w", w);
            o.put("h", h);
            o.put("codec", "avc");
            if (why != null) o.put("error", why);
            notifyListeners("mirrorState", o, true);
        }
    };

    /** Wake-on-LAN: волшебный пакет на порты 9 и 7 широковещательных адресов, трижды. */
    @PluginMethod
    public void wake(PluginCall call) {
        final byte[] packet = Base64.decode(call.getString("packet", ""), Base64.NO_WRAP);
        final JSArray hosts = call.getArray("hosts", new JSArray());
        if (packet.length != 102) { call.reject("неверный пакет"); return; }
        io.execute(() -> {
            int sent = 0;
            try (DatagramSocket s = new DatagramSocket()) {
                s.setBroadcast(true);
                for (int round = 0; round < 3; round++) {
                    for (int i = 0; i < hosts.length(); i++) {
                        for (int port : new int[] { 9, 7 }) {
                            try {
                                s.send(new DatagramPacket(packet, packet.length, InetAddress.getByName(hosts.getString(i)), port));
                                sent++;
                            } catch (Exception ignored) { }
                        }
                    }
                    Thread.sleep(120);
                }
            } catch (Exception ignored) { }
            if (sent > 0) call.resolve(); else call.reject("сеть недоступна");
        });
    }

    /** Кнопки громкости листают слайды, пока на телефоне открыта «Указка». */
    static volatile boolean volumeKeys;
    static volatile DotLinkPlugin instance;

    @PluginMethod
    public void setVolumeKeys(PluginCall call) {
        volumeKeys = call.getBoolean("on", false);
        call.resolve();
    }

    /** Вызывается из MainActivity: `true` — нажатие забрали себе. */
    static boolean onVolumeKey(boolean up, boolean down) {
        DotLinkPlugin p = instance;
        if (!volumeKeys || p == null) return false;
        if (down) {
            JSObject o = new JSObject();
            o.put("key", up ? "up" : "down");
            p.notifyListeners("volumeKey", o);
        }
        return true;
    }

    @Override
    public void load() {
        instance = this;
        MirrorService.sink = mirrorSink;
        NotifyService.sink = (app, title, text) -> {
            JSObject o = new JSObject();
            o.put("app", app);
            o.put("title", title);
            o.put("text", text);
            notifyListeners("notification", o);
        };
    }

    /** Запросить у Android разрешение на запись экрана и начать трансляцию. */
    @PluginMethod
    public void mirrorStart(PluginCall call) {
        if (MirrorService.running != null) { call.resolve(); MirrorService.running.requestKeyFrame(); return; }
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
            // значок трансляции в шторке — честное напоминание, что экран виден на ПК
            requestPermissionForAlias("notifications", call, "afterNotifyPermission");
            return;
        }
        askProjection(call);
    }

    @PermissionCallback
    private void afterNotifyPermission(PluginCall call) { askProjection(call); }

    private void askProjection(PluginCall call) {
        MediaProjectionManager mpm = (MediaProjectionManager) getContext().getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        startActivityForResult(call, mpm.createScreenCaptureIntent(), "onProjection");
    }

    @ActivityCallback
    private void onProjection(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) { call.reject("Трансляция отклонена на телефоне"); return; }
        Intent i = new Intent(getContext(), MirrorService.class)
            .putExtra(MirrorService.EXTRA_CODE, result.getResultCode())
            .putExtra(MirrorService.EXTRA_DATA, result.getData())
            .putExtra(MirrorService.EXTRA_MAX, call.getInt("max", 1280))
            .putExtra(MirrorService.EXTRA_BITRATE, call.getInt("bitrate", 6_000_000))
            .putExtra(MirrorService.EXTRA_FPS, call.getInt("fps", 60));
        if (Build.VERSION.SDK_INT >= 26) getContext().startForegroundService(i);
        else getContext().startService(i);
        call.resolve();
    }

    @PluginMethod
    public void mirrorStop(PluginCall call) {
        getContext().stopService(new Intent(getContext(), MirrorService.class));
        call.resolve();
    }

    @PluginMethod
    public void mirrorKey(PluginCall call) {
        MirrorService m = MirrorService.running;
        if (m != null) {
            m.requestKeyFrame();
            Integer b = call.getInt("bitrate");
            if (b != null) m.setBitrate(b);
        }
        call.resolve();
    }

    // ───────── управление телефоном с ПК ─────────

    private boolean serviceEnabled(Class<?> cls, String setting) {
        String list = Settings.Secure.getString(getContext().getContentResolver(), setting);
        if (list == null) return false;
        String me = new ComponentName(getContext(), cls).flattenToString();
        String shortName = new ComponentName(getContext(), cls).flattenToShortString();
        for (String s : list.split(":")) if (s.equalsIgnoreCase(me) || s.equalsIgnoreCase(shortName)) return true;
        return false;
    }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject o = new JSObject();
        o.put("control", ControlService.instance != null);
        o.put("controlEnabled", serviceEnabled(ControlService.class, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES));
        o.put("notifications", serviceEnabled(NotifyService.class, "enabled_notification_listeners"));
        o.put("mirror", MirrorService.running != null);
        BluetoothAdapterHolder.fill(o);
        call.resolve(o);
    }

    @PluginMethod
    public void openSettings(PluginCall call) {
        String what = call.getString("what", "");
        String action;
        switch (what) {
            case "accessibility": action = Settings.ACTION_ACCESSIBILITY_SETTINGS; break;
            case "notifications": action = "android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS"; break;
            case "bluetooth": action = Settings.ACTION_BLUETOOTH_SETTINGS; break;
            default: action = Settings.ACTION_SETTINGS;
        }
        try {
            getContext().startActivity(new Intent(action).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            call.resolve();
        } catch (Exception e) {
            call.reject("настройки недоступны");
        }
    }

    /** Жест или кнопка: tap, long, swipe, path, scroll, back, home, recents, notifications, quick, lock, screenshot, text, key. */
    @PluginMethod
    public void control(PluginCall call) {
        ControlService c = ControlService.instance;
        if (c == null) { call.reject("no-accessibility"); return; }
        String a = call.getString("a", "");
        double x = call.getDouble("x", 0.5), y = call.getDouble("y", 0.5);
        boolean ok;
        switch (a) {
            case "tap": ok = c.tap(x, y); break;
            case "long": ok = c.longPress(x, y, call.getInt("ms", 600)); break;
            case "swipe": ok = c.swipe(x, y, call.getDouble("x2", x), call.getDouble("y2", y), call.getInt("ms", 250)); break;
            case "scroll": ok = c.scroll(x, y, call.getDouble("y2", 0.0), call.getDouble("x2", 0.0)); break;
            case "path": {
                JSArray p = call.getArray("path", new JSArray());
                double[] pts = new double[p.length()];
                for (int i = 0; i < pts.length; i++) pts[i] = p.optDouble(i, 0);
                ok = c.path(pts, call.getInt("ms", 300));
                break;
            }
            case "text": ok = c.type(call.getString("text", "")); break;
            case "key": ok = c.key(call.getString("key", "")); break;
            default: ok = c.global(a);
        }
        if (ok) call.resolve(); else call.reject("действие не выполнено");
    }

    /** Мышь ПК на телефоне: курсор поверх всех окон. */
    @PluginMethod
    public void cursor(PluginCall call) {
        ControlService c = ControlService.instance;
        if (c == null) { call.reject("no-accessibility"); return; }
        String a = call.getString("a", "");
        getActivity().runOnUiThread(() -> {
            switch (a) {
                case "show": c.showCursor(); break;
                case "hide": c.hideCursor(); break;
                case "move": c.cursorMove(call.getInt("dx", 0), call.getInt("dy", 0)); break;
                case "button": c.cursorButton(call.getInt("b", 0), call.getBoolean("down", false)); break;
                case "scroll": c.cursorScroll(call.getInt("v", 0), call.getInt("h", 0)); break;
                default: break;
            }
            call.resolve();
        });
    }

    // ───────── Bluetooth ─────────

    @PluginMethod
    public void btConnect(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 31 && getPermissionState("bluetooth") != PermissionState.GRANTED) {
            requestPermissionForAlias("bluetooth", call, "afterBtPermission");
            return;
        }
        afterBtPermission(call);
    }

    @PermissionCallback
    private void afterBtPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 31 && getPermissionState("bluetooth") != PermissionState.GRANTED) { call.reject("нет разрешения на Bluetooth"); return; }
        String addr = call.getString("addr");
        if (addr == null) { call.reject("нет адреса ПК"); return; }
        final int id = btIds.incrementAndGet();
        io.execute(() -> {
            try {
                BtLink l = BtLink.connect(addr, new BtLink.Sink() {
                    @Override public void message(int kind, byte[] body) {
                        JSObject o = new JSObject();
                        o.put("id", id);
                        o.put("k", kind);
                        o.put("d", Base64.encodeToString(body, Base64.NO_WRAP));
                        notifyListeners("bt", o);
                    }
                    @Override public void closed(String why) {
                        bt.remove(id);
                        JSObject o = new JSObject();
                        o.put("id", id);
                        if (why != null) o.put("error", why);
                        notifyListeners("btClose", o);
                    }
                });
                bt.put(id, l);
                JSObject ret = new JSObject();
                ret.put("id", id);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject(e.getMessage() != null ? e.getMessage() : "ПК не ответил по Bluetooth");
            }
        });
    }

    @PluginMethod
    public void btSend(PluginCall call) {
        BtLink l = bt.get(call.getInt("id", -1));
        if (l == null) { call.reject("канал закрыт"); return; }
        final int kind = call.getInt("k", 1);
        final byte[] body = Base64.decode(call.getString("d", ""), Base64.NO_WRAP);
        io.execute(() -> {
            try { l.send(kind, body); call.resolve(); } catch (Exception e) { l.close(); call.reject("канал закрыт"); }
        });
    }

    @PluginMethod
    public void btClose(PluginCall call) {
        BtLink l = bt.remove(call.getInt("id", -1));
        if (l != null) l.close();
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        for (BtLink l : bt.values()) l.close();
        bt.clear();
        super.handleOnDestroy();
    }

    /** Сведения об адаптере без падения на телефонах без Bluetooth и без разрешения. */
    private static final class BluetoothAdapterHolder {
        @android.annotation.SuppressLint("MissingPermission")
        static void fill(JSObject o) {
            try {
                android.bluetooth.BluetoothAdapter a = android.bluetooth.BluetoothAdapter.getDefaultAdapter();
                o.put("bluetooth", a != null && a.isEnabled());
            } catch (Exception e) {
                o.put("bluetooth", false);
            }
        }
    }
}
