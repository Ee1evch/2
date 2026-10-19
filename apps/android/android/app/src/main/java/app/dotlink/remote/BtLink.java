package app.dotlink.remote;

import android.annotation.SuppressLint;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothSocket;

import java.io.DataInputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.util.UUID;

/**
 * Канал до ПК по Bluetooth (RFCOMM) — когда нет ни Wi-Fi, ни интернета. Сопряжение Bluetooth
 * в настройках не нужно: соединение «insecure», а защищает его та же сессия DotLink (вход по ключу
 * устройства и шифрование), что и в сети. Кадры: 1 байт типа (0 текст, 1 данные) + u32 длина (BE)
 * + тело — как в crates/dotlink-core/src/transport.rs.
 */
class BtLink {
    /** Служба DotLink на ПК (тот же UUID в crates/dotlink-core/src/platform/windows/bt.rs). */
    static final UUID SERVICE = UUID.fromString("6c1f2d3e-9a4b-4f5c-8d7e-0a1b2c3d4e5f");
    private static final int MAX = 4 << 20;

    interface Sink {
        void message(int kind, byte[] body);
        void closed(String why);
    }

    private final BluetoothSocket socket;
    private final OutputStream out;
    private final Thread reader;
    private volatile boolean open = true;

    @SuppressLint("MissingPermission")
    static BtLink connect(String addr, Sink sink) throws IOException {
        BluetoothAdapter a = BluetoothAdapter.getDefaultAdapter();
        if (a == null) throw new IOException("в телефоне нет Bluetooth");
        if (!a.isEnabled()) throw new IOException("Bluetooth выключен");
        BluetoothDevice d = a.getRemoteDevice(addr.toUpperCase());
        a.cancelDiscovery();
        BluetoothSocket s = d.createInsecureRfcommSocketToServiceRecord(SERVICE);
        s.connect();
        return new BtLink(s, sink);
    }

    private BtLink(BluetoothSocket s, Sink sink) throws IOException {
        socket = s;
        out = s.getOutputStream();
        DataInputStream in = new DataInputStream(s.getInputStream());
        reader = new Thread(() -> {
            String why = null;
            try {
                while (open) {
                    int kind = in.readUnsignedByte();
                    int len = in.readInt();
                    if (len < 0 || len > MAX) throw new IOException("кадр слишком большой");
                    byte[] body = new byte[len];
                    in.readFully(body);
                    sink.message(kind, body);
                }
            } catch (IOException e) {
                why = open ? e.getMessage() : null;
            }
            close();
            sink.closed(why);
        }, "dotlink-bt");
        reader.start();
    }

    synchronized void send(int kind, byte[] body) throws IOException {
        byte[] head = { (byte) kind, (byte) (body.length >>> 24), (byte) (body.length >>> 16), (byte) (body.length >>> 8), (byte) body.length };
        out.write(head);
        out.write(body);
        out.flush();
    }

    void close() {
        open = false;
        try { socket.close(); } catch (IOException ignored) { }
    }
}
