//! Сетевые интерфейсы ПК и проверка, что подключение пришло из локальной сети.

use serde::Serialize;
use std::net::IpAddr;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Addr {
    pub ip: String,
    pub iface: String,
    /// wifi | lan | usb | hotspot | other
    pub kind: &'static str,
}

/// Только частные, локальные и петлевые адреса: DotLink не принимает подключения из интернета.
pub fn is_local(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => {
            let o = v.octets();
            v.is_loopback() || v.is_private() || v.is_link_local() || (o[0] == 100 && (o[1] & 0xC0) == 64)
        }
        IpAddr::V6(v) => {
            if let Some(m) = v.to_ipv4_mapped() {
                return is_local(IpAddr::V4(m));
            }
            let s = v.segments();
            v.is_loopback() || (s[0] & 0xfe00) == 0xfc00 || (s[0] & 0xffc0) == 0xfe80
        }
    }
}

fn classify(name: &str, ip: &[u8; 4]) -> (&'static str, i32) {
    let n = name.to_lowercase();
    let virt = ["vethernet", "virtualbox", "vmware", "hyper-v", "docker", "wsl", "vbox", "tailscale", "zerotier", "loopback", "br-", "veth"];
    if virt.iter().any(|v| n.contains(v)) {
        return ("other", 9);
    }
    // Windows «Мобильный хот-спот» раздаёт 192.168.137.0/24, телефоны — 192.168.43.x / 172.20.10.x
    if ip[0] == 192 && ip[1] == 168 && ip[2] == 137 {
        return ("hotspot", 2);
    }
    if n.contains("rndis") || n.contains("usb") || (ip[0] == 192 && ip[1] == 168 && ip[2] == 42) {
        return ("usb", 1);
    }
    if (ip[0] == 192 && ip[1] == 168 && ip[2] == 43) || (ip[0] == 172 && ip[1] == 20 && ip[2] == 10) {
        return ("hotspot", 0);
    }
    if n.contains("wi-fi") || n.contains("wifi") || n.contains("wlan") || n.contains("wireless") || n.starts_with("wl") || n.contains("беспровод") {
        return ("wifi", 0);
    }
    if n.contains("ethernet") || n.starts_with("eth") || n.starts_with("en") || n.contains("подключение по локальной") {
        return ("lan", 1);
    }
    ("other", 5)
}

/// IPv4-адреса ПК, самые вероятные для телефона — первыми.
pub fn addrs() -> Vec<Addr> {
    let mut v: Vec<(i32, Addr)> = if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|i| match i.ip() {
            IpAddr::V4(ip) if !ip.is_loopback() && is_local(IpAddr::V4(ip)) => {
                let (kind, rank) = classify(&i.name, &ip.octets());
                Some((rank, Addr { ip: ip.to_string(), iface: i.name.clone(), kind }))
            }
            _ => None,
        })
        .collect();
    v.sort_by_key(|(r, _)| *r);
    v.dedup_by(|a, b| a.1.ip == b.1.ip);
    v.into_iter().map(|(_, a)| a).collect()
}

/// Куда слать «волшебный пакет» Wake-on-LAN: MAC сетевой карты и широковещательный адрес её сети.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Wol {
    pub mac: String,
    pub bcast: String,
}

/// Только настоящие сетевые карты (кабель и Wi-Fi): будить ПК умеют они, а не виртуальные адаптеры.
pub fn wol_targets() -> Vec<Wol> {
    let mut v: Vec<(i32, Wol)> = if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|i| {
            let if_addrs::IfAddr::V4(a) = &i.addr else { return None };
            if a.ip.is_loopback() || !is_local(IpAddr::V4(a.ip)) {
                return None;
            }
            let (kind, _) = classify(&i.name, &a.ip.octets());
            let rank = match kind {
                "lan" => 0,
                "wifi" => 1,
                _ => return None,
            };
            let mac = mac_address::mac_address_by_name(&i.name).ok().flatten()?;
            if mac.bytes() == [0; 6] {
                return None;
            }
            let bcast = a.broadcast.map(|b| b.to_string()).unwrap_or_else(|| "255.255.255.255".into());
            Some((rank, Wol { mac: mac.to_string(), bcast }))
        })
        .collect();
    v.sort_by_key(|(r, _)| *r);
    v.dedup_by(|a, b| a.1.mac == b.1.mac);
    v.into_iter().map(|(_, w)| w).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_ranges() {
        for ok in ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.5", "169.254.3.4", "100.64.0.1", "::1", "fe80::1", "fd00::5", "::ffff:192.168.0.2"] {
            assert!(is_local(ok.parse().unwrap()), "{ok}");
        }
        for bad in ["8.8.8.8", "172.32.0.1", "100.128.0.1", "2001:db8::1", "::ffff:1.1.1.1"] {
            assert!(!is_local(bad.parse().unwrap()), "{bad}");
        }
    }

    #[test]
    fn interface_kinds() {
        assert_eq!(classify("Wi-Fi", &[192, 168, 1, 5]).0, "wifi");
        assert_eq!(classify("Ethernet 2", &[192, 168, 42, 100]).0, "usb");
        assert_eq!(classify("Подключение по локальной сети* 10", &[192, 168, 137, 1]).0, "hotspot");
        assert_eq!(classify("vEthernet (WSL)", &[172, 20, 0, 1]).0, "other");
    }
}
