//! Bluetooth RFCOMM на Windows (WinRT): служба DotLink объявляется в SDP, телефон подключается
//! «insecure»-сокетом без сопряжения в настройках Bluetooth — защищает соединение сессия DotLink.

use super::super::{BtAccept, BtConn};
use parking_lot::Mutex;
use windows::core::GUID;
use windows::Devices::Bluetooth::BluetoothAdapter;
use windows::Devices::Bluetooth::Rfcomm::{RfcommServiceId, RfcommServiceProvider};
use windows::Foundation::TypedEventHandler;
use windows::Networking::Sockets::{SocketProtectionLevel, StreamSocket, StreamSocketListener, StreamSocketListenerConnectionReceivedEventArgs};
use windows::Storage::Streams::{DataReader, DataWriter, InputStreamOptions};

/// Тот же UUID — в apps/android/…/BtLink.java.
const SERVICE: GUID = GUID::from_u128(0x6c1f2d3e_9a4b_4f5c_8d7e_0a1b2c3d4e5f);

struct Server {
    provider: RfcommServiceProvider,
    listener: StreamSocketListener,
    addr: String,
}

static SERVER: Mutex<Option<Server>> = Mutex::new(None);

fn format_addr(a: u64) -> String {
    (0..6).rev().map(|i| format!("{:02X}", (a >> (i * 8)) & 0xFF)).collect::<Vec<_>>().join(":")
}

pub fn set(on: bool, accept: BtAccept) -> anyhow::Result<Option<String>> {
    let mut g = SERVER.lock();
    if !on {
        if let Some(s) = g.take() {
            let _ = s.provider.StopAdvertising();
            let _ = s.listener.Close();
        }
        return Ok(None);
    }
    if let Some(s) = g.as_ref() {
        return Ok(Some(s.addr.clone()));
    }
    let Ok(adapter) = BluetoothAdapter::GetDefaultAsync().and_then(|op| op.get()) else { return Ok(None) };
    if !adapter.IsClassicSupported().unwrap_or(false) {
        anyhow::bail!("адаптер поддерживает только Bluetooth LE");
    }
    let addr = format_addr(adapter.BluetoothAddress()?);
    let provider = RfcommServiceProvider::CreateAsync(&RfcommServiceId::FromUuid(SERVICE)?)?.get()?;
    let listener = StreamSocketListener::new()?;
    listener.ConnectionReceived(&TypedEventHandler::<StreamSocketListener, StreamSocketListenerConnectionReceivedEventArgs>::new(move |_, args| {
        if let Ok(a) = args.ok() {
            if let Ok(sock) = a.Socket() {
                if let Err(e) = bridge(sock, &accept) {
                    tracing::warn!("Bluetooth: {e}");
                }
            }
        }
        Ok(())
    }))?;
    listener
        .BindServiceNameWithProtectionLevelAsync(&provider.ServiceId()?.AsString()?, SocketProtectionLevel::BluetoothEncryptionAllowNullAuthentication)?
        .get()?;
    provider.StartAdvertisingWithRadioDiscoverability(&listener, true)?;
    *g = Some(Server { provider, listener, addr: addr.clone() });
    Ok(Some(addr))
}

fn bridge(sock: StreamSocket, accept: &BtAccept) -> windows::core::Result<()> {
    let peer = sock.Information().and_then(|i| i.RemoteHostName()).and_then(|h| h.DisplayName()).map(|s| s.to_string()).unwrap_or_else(|_| "телефон".into());
    let reader = DataReader::CreateDataReader(&sock.InputStream()?)?;
    reader.SetInputStreamOptions(InputStreamOptions::Partial)?;
    let writer = DataWriter::CreateDataWriter(&sock.OutputStream()?)?;
    let keep = sock.clone();
    accept(BtConn {
        peer,
        read: Box::new(move |buf| {
            let n = reader.LoadAsync(buf.len() as u32).and_then(|op| op.get()).map_err(std::io::Error::other)? as usize;
            if n == 0 {
                return Ok(0);
            }
            reader.ReadBytes(&mut buf[..n]).map_err(std::io::Error::other)?;
            Ok(n)
        }),
        write: Box::new(move |b| {
            let _ = &keep; // сокет жив, пока жив канал
            writer.WriteBytes(b).map_err(std::io::Error::other)?;
            writer.StoreAsync().and_then(|op| op.get()).map_err(std::io::Error::other)?;
            Ok(())
        }),
    });
    Ok(())
}
