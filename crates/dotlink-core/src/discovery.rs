//! Обнаружение ПК без интернета.
//! mDNS: служба `_dotlink._tcp.local.` (Android NsdManager, Bonjour).
//! UDP-маяк на порту 47801: телефон шлёт широковещательный `DOTLINK?`, ПК отвечает JSON —
//! выручает в сетях, где мультикаст режется (часто на хотспотах телефона).

use std::sync::Arc;
use tokio::net::UdpSocket;

pub const SERVICE: &str = "_dotlink._tcp.local.";
pub const BEACON_PORT: u16 = 47801;
pub const PROBE: &[u8] = b"DOTLINK?";

pub struct Discovery {
    mdns: Option<mdns_sd::ServiceDaemon>,
}

impl Drop for Discovery {
    fn drop(&mut self) {
        if let Some(d) = self.mdns.take() {
            let _ = d.shutdown();
        }
    }
}

fn dns_label(s: &str) -> String {
    let l: String = s.chars().map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' }).collect();
    let l = l.trim_matches('-').to_string();
    if l.is_empty() {
        "pc".into()
    } else {
        l.chars().take(40).collect()
    }
}

/// Запускает mDNS и маяк. Ошибки не фатальны: подключиться можно и по QR.
pub async fn start(info: impl Fn() -> serde_json::Value + Send + Sync + 'static, pc_id: &str, pc_name: &str, port: u16) -> Discovery {
    let mdns = (|| -> anyhow::Result<mdns_sd::ServiceDaemon> {
        let d = mdns_sd::ServiceDaemon::new()?;
        let ips: Vec<std::net::IpAddr> = crate::net::addrs().iter().filter_map(|a| a.ip.parse().ok()).collect();
        let host = format!("dotlink-{}.local.", dns_label(pc_name));
        let props = [("id", pc_id), ("v", "1"), ("name", pc_name)];
        let svc = mdns_sd::ServiceInfo::new(
            SERVICE,
            &format!("{} {}", pc_name.chars().take(40).collect::<String>(), &pc_id[..4.min(pc_id.len())]),
            &host,
            ips.as_slice(),
            port,
            &props[..],
        )?
        .enable_addr_auto();
        d.register(svc)?;
        Ok(d)
    })();
    let mdns = match mdns {
        Ok(d) => Some(d),
        Err(e) => {
            tracing::warn!("mDNS недоступен: {e:#}");
            None
        }
    };

    let info = Arc::new(info);
    match UdpSocket::bind(("0.0.0.0", BEACON_PORT)).await {
        Ok(sock) => {
            let _ = sock.set_broadcast(true);
            tokio::spawn(async move {
                let mut buf = [0u8; 64];
                loop {
                    let Ok((n, from)) = sock.recv_from(&mut buf).await else { continue };
                    if !buf[..n].starts_with(PROBE) || !crate::net::is_local(from.ip()) {
                        continue;
                    }
                    let reply = serde_json::to_vec(&info()).unwrap_or_default();
                    let _ = sock.send_to(&reply, from).await;
                }
            });
        }
        Err(e) => tracing::warn!("UDP-маяк {BEACON_PORT} недоступен: {e}"),
    }
    Discovery { mdns }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels() {
        assert_eq!(dns_label("DESKTOP-ABC 12"), "desktop-abc-12");
        assert_eq!(dns_label("Компьютер"), "pc");
    }
}
