//! HTTP: раздача интерфейса (PWA и дашборд), WebSocket `/ws`, файлы.
//! Принимаются только подключения из локальной сети.

use crate::core::Core;
use crate::files::{Received, Ticket};
use crate::net::is_local;
use crate::util::now_ms;
use axum::body::Body;
use axum::extract::ws::WebSocketUpgrade;
use axum::extract::{ConnectInfo, DefaultBodyLimit, Path, Query, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode, Uri};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use futures_util::StreamExt;
use rust_embed::RustEmbed;
use serde_json::json;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::io::AsyncWriteExt;

/// Предел для файлов неизвестного размера.
const MAX_UPLOAD: u64 = 64 << 30;

#[derive(RustEmbed)]
#[folder = "$CARGO_MANIFEST_DIR/../../web/dist"]
#[allow_missing = true]
struct Assets;

pub fn router(core: Arc<Core>) -> Router {
    Router::new()
        .route("/ws", get(ws))
        .route("/api/info", get(info))
        .route("/api/upload/{ticket}", put(upload))
        .route("/api/download/{ticket}", get(download))
        .route("/api/admin/outbox", post(outbox))
        .route("/api/debug/events", get(debug_events))
        .fallback(get(assets))
        .layer(DefaultBodyLimit::disable())
        .layer(middleware::from_fn(guard))
        .with_state(core)
}

/// Только локальная сеть; CORS для APK (его страница живёт на http://localhost).
async fn guard(ConnectInfo(addr): ConnectInfo<SocketAddr>, req: Request, next: Next) -> Response {
    if !is_local(addr.ip()) {
        return (StatusCode::FORBIDDEN, "DotLink принимает подключения только из локальной сети").into_response();
    }
    let mut res = if req.method() == Method::OPTIONS { StatusCode::NO_CONTENT.into_response() } else { next.run(req).await };
    let h = res.headers_mut();
    h.insert("access-control-allow-origin", HeaderValue::from_static("*"));
    h.insert("access-control-allow-methods", HeaderValue::from_static("GET, PUT, POST, OPTIONS"));
    h.insert("access-control-allow-headers", HeaderValue::from_static("content-type, x-dotlink-admin"));
    h.insert("access-control-allow-private-network", HeaderValue::from_static("true"));
    h.insert("access-control-max-age", HeaderValue::from_static("600"));
    res
}

async fn ws(ws: WebSocketUpgrade, ConnectInfo(addr): ConnectInfo<SocketAddr>, State(core): State<Arc<Core>>) -> Response {
    ws.max_message_size(4 << 20).on_upgrade(move |s| {
        let wire = crate::transport::from_axum(s, crate::transport::Via::Lan, addr.to_string(), addr.ip().is_loopback());
        crate::session::run(core, wire)
    })
}

async fn info(State(core): State<Arc<Core>>) -> Json<serde_json::Value> {
    let mut v = core.pc_info();
    v["t"] = json!("dotlink");
    v["port"] = json!(core.port());
    Json(v)
}

fn err(code: StatusCode, msg: &str) -> Response {
    (code, Json(json!({ "error": msg }))).into_response()
}

async fn upload(State(core): State<Arc<Core>>, Path(ticket): Path<String>, body: Body) -> Response {
    let Some(Ticket::Upload { name, size, from }) = core.files.take(&ticket) else {
        return err(StatusCode::FORBIDDEN, "билет недействителен");
    };
    let dir = core.platform.downloads_dir();
    if let Err(e) = tokio::fs::create_dir_all(&dir).await {
        return err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string());
    }
    let path = crate::files::unique_path(&dir, &name);
    let tmp = path.with_extension("dotlink-part");
    let res = async {
        let mut f = tokio::io::BufWriter::with_capacity(1 << 20, tokio::fs::File::create(&tmp).await?);
        let mut got = 0u64;
        let mut s = body.into_data_stream();
        while let Some(chunk) = s.next().await {
            let chunk = chunk.map_err(std::io::Error::other)?;
            got += chunk.len() as u64;
            if got > size.unwrap_or(MAX_UPLOAD) {
                return Err(std::io::Error::other("файл больше заявленного"));
            }
            f.write_all(&chunk).await?;
        }
        f.flush().await?;
        if size.is_some_and(|s| s != got) {
            return Err(std::io::Error::other("передача прервана"));
        }
        tokio::fs::rename(&tmp, &path).await?;
        Ok::<_, std::io::Error>(got)
    }
    .await;
    match res {
        Ok(got) => {
            let from = core.store.device(&from).map(|d| d.name).unwrap_or(from);
            let fname = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or(name);
            core.received(Received { name: fname.clone(), size: got, from, at: now_ms(), path: path.to_string_lossy().into() });
            Json(json!({ "ok": true, "name": fname, "size": got })).into_response()
        }
        Err(e) => {
            let _ = tokio::fs::remove_file(&tmp).await;
            err(StatusCode::BAD_REQUEST, &e.to_string())
        }
    }
}

fn disposition(name: &str) -> HeaderValue {
    let ascii: String = name.chars().map(|c| if c.is_ascii_graphic() && c != '"' && c != '\\' || c == ' ' { c } else { '_' }).collect();
    let enc = percent_encoding::utf8_percent_encode(name, percent_encoding::NON_ALPHANUMERIC);
    HeaderValue::from_str(&format!("attachment; filename=\"{ascii}\"; filename*=UTF-8''{enc}")).unwrap_or(HeaderValue::from_static("attachment"))
}

async fn download(State(core): State<Arc<Core>>, Path(ticket): Path<String>) -> Response {
    let Some(Ticket::Download { path, name }) = core.files.take(&ticket) else { return err(StatusCode::FORBIDDEN, "билет недействителен") };
    let Ok(f) = tokio::fs::File::open(&path).await else { return err(StatusCode::NOT_FOUND, "файл не найден") };
    let len = f.metadata().await.map(|m| m.len()).unwrap_or(0);
    let mime = mime_guess::from_path(&name).first_or_octet_stream();
    let mut h = HeaderMap::new();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_str(mime.as_ref()).unwrap());
    h.insert(header::CONTENT_LENGTH, HeaderValue::from(len));
    h.insert(header::CONTENT_DISPOSITION, disposition(&name));
    (h, Body::from_stream(tokio_util::io::ReaderStream::with_capacity(f, 1 << 20))).into_response()
}

/// Дашборд кладёт сюда файл для отправки на телефон (или принятый по QR).
async fn outbox(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(core): State<Arc<Core>>,
    headers: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
    body: Body,
) -> Response {
    let token = headers.get("x-dotlink-admin").and_then(|v| v.to_str().ok()).unwrap_or("");
    if !addr.ip().is_loopback() || !crate::crypto::ct_eq(token.as_bytes(), core.admin_token.as_bytes()) {
        return err(StatusCode::FORBIDDEN, "только для дашборда");
    }
    let name = crate::util::safe_file_name(q.get("name").map(String::as_str).unwrap_or("файл"));
    let dir = core.data_dir.clone().unwrap_or_else(std::env::temp_dir).join("outbox");
    let _ = tokio::fs::create_dir_all(&dir).await;
    let path = dir.join(format!("{}-{}", crate::util::b64url(&crate::crypto::random::<6>()), name));
    let res = async {
        let mut f = tokio::io::BufWriter::new(tokio::fs::File::create(&path).await?);
        let mut got = 0u64;
        let mut s = body.into_data_stream();
        while let Some(c) = s.next().await {
            let c = c.map_err(std::io::Error::other)?;
            got += c.len() as u64;
            f.write_all(&c).await?;
        }
        f.flush().await?;
        Ok::<_, std::io::Error>(got)
    }
    .await;
    match res {
        Ok(size) => Json(json!({ "id": core.add_outbox(path, name.clone(), size), "name": name, "size": size })).into_response(),
        Err(e) => err(StatusCode::BAD_REQUEST, &e.to_string()),
    }
}

async fn debug_events(ConnectInfo(addr): ConnectInfo<SocketAddr>, State(core): State<Arc<Core>>) -> Response {
    match core.platform.debug_log() {
        Some(v) if addr.ip().is_loopback() => Json(v).into_response(),
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn assets(uri: Uri) -> Response {
    let mut path = uri.path().trim_start_matches('/').to_string();
    if path.is_empty() || path.ends_with('/') {
        path.push_str("index.html");
    }
    let file = Assets::get(&path).or_else(|| (!path.contains('.')).then(|| Assets::get(&format!("{path}/index.html"))).flatten());
    let Some(file) = file else {
        if path == "index.html" {
            return (
                StatusCode::OK,
                [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
                "<h1>DotLink</h1><p>Интерфейс не собран: выполните <code>npm run build</code> в папке web.</p>",
            )
                .into_response();
        }
        return StatusCode::NOT_FOUND.into_response();
    };
    let mime = mime_guess::from_path(&path).first_or_octet_stream();
    let cache = if path.starts_with("assets/") { "public, max-age=31536000, immutable" } else { "no-cache" };
    let ctype = if mime.type_() == "text" || path.ends_with(".js") { format!("{mime}; charset=utf-8") } else { mime.to_string() };
    ([(header::CONTENT_TYPE, ctype), (header::CACHE_CONTROL, cache.to_string())], file.data).into_response()
}
