//! Диспетчер задач в кармане: что сейчас грузит ПК. Процессы одной программы (у браузера их
//! десятки) складываются в одну строку. Завершить можно программу, но не служебные процессы
//! Windows и не сам DotLink.

use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct App {
    pub name: String,
    pub count: usize,
    /// доля всего процессора, 0..1
    pub cpu: f32,
    /// память, байт
    pub mem: u64,
    #[serde(skip)]
    pub pids: Vec<u32>,
}

/// Без этих процессов Windows не работает — их завершать нельзя.
const SYSTEM: &[&str] = &[
    "system",
    "idle",
    "registry",
    "smss",
    "csrss",
    "wininit",
    "winlogon",
    "services",
    "lsass",
    "lsaiso",
    "svchost",
    "dwm",
    "fontdrvhost",
    "memory compression",
    "secure system",
    "sihost",
    "ctfmon",
    "spoolsv",
    "audiodg",
    "conhost",
    "runtimebroker",
    "searchhost",
    "startmenuexperiencehost",
    "shellexperiencehost",
    "textinputhost",
    "dllhost",
    "taskhostw",
    "wudfhost",
    "msmpeng",
    "nissrv",
    "securityhealthservice",
];

fn base(name: &str) -> String {
    let n = name.trim();
    let n = n.strip_suffix(".exe").or_else(|| n.strip_suffix(".EXE")).unwrap_or(n);
    n.to_string()
}

pub fn protected(name: &str) -> bool {
    let n = base(name).to_lowercase();
    SYSTEM.contains(&n.as_str()) || n.starts_with("dotlink")
}

pub struct Procs {
    sys: Mutex<System>,
}

impl Default for Procs {
    fn default() -> Self {
        Self { sys: Mutex::new(System::new()) }
    }
}

impl Procs {
    /// Список программ: сначала по процессору, при равенстве — по памяти.
    /// Загрузка процессора считается между двумя вызовами (первый даёт нули).
    pub fn top(&self, limit: usize, q: Option<&str>) -> Vec<App> {
        let mut sys = self.sys.lock();
        sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing().with_cpu().with_memory());
        let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1) as f32;
        let me = std::process::id();
        let mut by: HashMap<String, App> = HashMap::new();
        for (pid, p) in sys.processes() {
            if pid.as_u32() == me || pid.as_u32() == 0 {
                continue;
            }
            let name = base(&p.name().to_string_lossy());
            if name.is_empty() {
                continue;
            }
            let e = by.entry(name.to_lowercase()).or_insert_with(|| App { name: name.clone(), count: 0, cpu: 0.0, mem: 0, pids: vec![] });
            e.count += 1;
            e.cpu += p.cpu_usage() / 100.0 / cores;
            e.mem += p.memory();
            e.pids.push(pid.as_u32());
        }
        let q = q.map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty());
        let mut v: Vec<App> = by.into_values().filter(|a| q.as_ref().is_none_or(|q| a.name.to_lowercase().contains(q))).collect();
        for a in &mut v {
            a.cpu = (a.cpu * 1000.0).round() / 1000.0;
        }
        v.sort_by(|a, b| b.cpu.partial_cmp(&a.cpu).unwrap_or(std::cmp::Ordering::Equal).then(b.mem.cmp(&a.mem)));
        v.truncate(limit);
        v
    }

    /// Завершить все процессы программы. Возвращает, сколько завершилось.
    pub fn kill(&self, name: &str) -> anyhow::Result<usize> {
        if protected(name) {
            anyhow::bail!("«{name}» — часть Windows, её не завершить");
        }
        let mut sys = self.sys.lock();
        sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
        let want = base(name).to_lowercase();
        let me = std::process::id();
        let pids: Vec<Pid> = sys
            .processes()
            .iter()
            .filter(|(pid, p)| pid.as_u32() != me && base(&p.name().to_string_lossy()).to_lowercase() == want)
            .map(|(pid, _)| *pid)
            .collect();
        if pids.is_empty() {
            anyhow::bail!("«{name}» уже не запущена");
        }
        let killed = pids.iter().filter(|pid| sys.process(**pid).is_some_and(|p| p.kill())).count();
        if killed == 0 {
            anyhow::bail!("Windows не дала завершить «{name}» (нужны права администратора)");
        }
        Ok(killed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_processes_are_protected() {
        assert!(protected("csrss.exe"));
        assert!(protected("SVCHOST"));
        assert!(protected("dotlink-server"));
        assert!(!protected("chrome.exe"));
        assert!(Procs::default().kill("lsass.exe").is_err());
    }

    #[test]
    fn lists_running_programs_grouped() {
        let p = Procs::default();
        let _ = p.top(50, None);
        std::thread::sleep(std::time::Duration::from_millis(200));
        let v = p.top(500, None);
        let first = v[0].name.clone();
        assert!(p.top(500, Some(&first[..2].to_uppercase())).iter().any(|a| a.name == first), "поиск без учёта регистра");
        assert!(!v.is_empty());
        assert!(v.iter().all(|a| a.count >= 1 && a.count == a.pids.len()));
        // сам DotLink в списке не показывается
        assert!(v.iter().all(|a| !a.pids.contains(&std::process::id())));
        let names: Vec<_> = v.iter().map(|a| a.name.to_lowercase()).collect();
        let mut dedup = names.clone();
        dedup.sort();
        dedup.dedup();
        assert_eq!(names.len(), dedup.len(), "одна строка на программу");
    }

    #[test]
    fn kills_a_real_child_process() {
        // копия системной программы под уникальным именем — чтобы не задеть чужие процессы
        let (src, args): (&str, &[&str]) = if cfg!(windows) { (r"C:\Windows\System32\PING.EXE", &["-n", "30", "127.0.0.1"]) } else { ("/bin/sleep", &["30"]) };
        let name = format!("dltest{}", std::process::id());
        let exe = std::env::temp_dir().join(if cfg!(windows) { format!("{name}.exe") } else { name.clone() });
        std::fs::copy(src, &exe).unwrap();
        let mut child = std::process::Command::new(&exe).args(args).stdout(std::process::Stdio::null()).spawn().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(100));
        assert_eq!(Procs::default().kill(&name).unwrap(), 1);
        assert!(!child.wait().unwrap().success());
        let _ = std::fs::remove_file(&exe);
        assert!(Procs::default().kill(&name).is_err(), "уже не запущена");
    }
}
