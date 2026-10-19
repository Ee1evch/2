use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;

pub fn b64(b: &[u8]) -> String {
    STANDARD.encode(b)
}

pub fn b64url(b: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(b)
}

/// Принимает base64 в любом алфавите (стандартный или URL), с выравниванием или без.
pub fn unb64(s: &str) -> Option<Vec<u8>> {
    let t: String = s.trim().trim_end_matches('=').chars().map(|c| match c {
        '+' => '-',
        '/' => '_',
        c => c,
    }).collect();
    URL_SAFE_NO_PAD.decode(t).ok()
}

pub fn unb64_arr<const N: usize>(s: &str) -> Option<[u8; N]> {
    unb64(s)?.try_into().ok()
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

pub fn hostname() -> String {
    let h = std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).ok().or_else(sysinfo::System::host_name);
    h.filter(|s| !s.trim().is_empty()).unwrap_or_else(|| "ПК".into())
}

/// Имя файла от телефона → безопасное имя для Windows.
pub fn safe_file_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let mut s: String = base
        .chars()
        .map(|c| if c.is_control() || r#"<>:"/\|?*"#.contains(c) { '_' } else { c })
        .collect::<String>()
        .trim()
        .trim_end_matches(['.', ' '])
        .to_string();
    let stem = s.split('.').next().unwrap_or("").to_ascii_uppercase();
    const RESERVED: [&str; 22] = ["CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"];
    if RESERVED.contains(&stem.as_str()) {
        s.insert(0, '_');
    }
    if s.is_empty() || s.chars().all(|c| c == '.') {
        s = "файл".into();
    }
    if s.chars().count() > 150 {
        let ext: String = s.rsplit_once('.').map(|(_, e)| e.chars().take(12).collect()).unwrap_or_default();
        s = s.chars().take(130).collect::<String>() + if ext.is_empty() { "" } else { "." } + &ext;
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_names() {
        assert_eq!(safe_file_name("../../etc/passwd"), "passwd");
        assert_eq!(safe_file_name("C:\\Windows\\win.ini"), "win.ini");
        assert_eq!(safe_file_name("фото: 1?.jpg"), "фото_ 1_.jpg");
        assert_eq!(safe_file_name("con.txt"), "_con.txt");
        assert_eq!(safe_file_name("..."), "файл");
        assert_eq!(safe_file_name("a. "), "a");
    }

    #[test]
    fn base64_any_alphabet() {
        let b = [0xfb, 0xff, 0x01];
        assert_eq!(unb64(&b64(&b)).unwrap(), b);
        assert_eq!(unb64(&b64url(&b)).unwrap(), b);
    }
}
