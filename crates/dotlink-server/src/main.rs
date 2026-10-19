//! DotLink без окна: то же ядро, что в приложении для Windows, но управляется из консоли.
//! Нужен для разработки, e2e-тестов и запуска на ПК без Tauri.
//!
//!   dotlink-server [--port 47800] [--data-dir DIR] [--bind 0.0.0.0] [--mock] [--no-discovery]

use std::sync::Arc;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt().with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into())).init();

    let mut opts = dotlink_core::Options::default();
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--port" => opts.port = Some(args.next().ok_or_else(|| anyhow::anyhow!("--port N"))?.parse()?),
            "--data-dir" => opts.data_dir = Some(args.next().ok_or_else(|| anyhow::anyhow!("--data-dir DIR"))?.into()),
            "--memory" => opts.data_dir = None,
            "--bind" => opts.bind = args.next().ok_or_else(|| anyhow::anyhow!("--bind IP"))?.parse()?,
            "--mock" => opts.platform = Arc::new(dotlink_core::platform::mock::MockPlatform::new()),
            "--no-discovery" => opts.discovery = false,
            "-h" | "--help" => {
                println!("dotlink-server [--port 47800] [--data-dir DIR | --memory] [--bind 0.0.0.0] [--mock] [--no-discovery]");
                return Ok(());
            }
            other => anyhow::bail!("неизвестный аргумент {other}"),
        }
    }

    let run = dotlink_core::start(opts).await?;
    let p = run.core.hub.get("pairing").unwrap_or_default();
    println!();
    println!("  DotLink · {}", run.core.store.read().pc_name);
    println!("  Дашборд:   {}", run.admin_url);
    println!("  Телефон:   {}", p["url"].as_str().unwrap_or(""));
    println!("  PIN:       {}", p["pin"].as_str().unwrap_or(""));
    println!();
    // строка для скриптов и e2e-тестов
    println!("DOTLINK_READY port={} admin={}", run.addr.port(), run.core.admin_token);

    tokio::signal::ctrl_c().await?;
    Ok(())
}
