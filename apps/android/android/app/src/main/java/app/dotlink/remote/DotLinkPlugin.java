package app.dotlink.remote;

import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
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
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Нативная часть DotLink: поиск ПК в сети (mDNS + UDP-маяк), файлы из «Поделиться»
 * и их загрузка на ПК прямо из натива — без перегонки байтов через WebView.
 */
@CapacitorPlugin(name = "DotLink")
public class DotLinkPlugin extends Plugin {
    private static final String SERVICE = "_dotlink._tcp.";
    private static final int BEACON_PORT = 47801;
    private static final List<JSObject> shared = Collections.synchronizedList(new ArrayList<>());
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
        JSArray arr = new JSArray();
        synchronized (shared) {
            for (JSObject o : shared) arr.put(o);
            shared.clear();
        }
        JSObject ret = new JSObject();
        ret.put("files", arr);
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
}
