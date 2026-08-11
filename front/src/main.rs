//! shodh-front — the Associative Memory dashboard server.
//!
//! A thin front for the shodh backend: it serves the single-page UI (the React
//! app under `front/ui`, embedded as one self-contained file at compile time —
//! see `build.rs`), and reverse-proxies every `/api/*` call to the backend
//! (`SHODH_API_URL`), injecting the API key. Responses are STREAMED, so the
//! Server-Sent-Events endpoint (`/api/events`, the live recall river) forwards
//! without buffering.
//!
//! It also reverse-proxies `/seat/*` to the conversation-seat harness
//! (`SHODH_SEAT_URL`), stripping the `/seat` prefix and injecting its bearer
//! token — the browser holds neither the backend API key nor the seat token,
//! and the seat's SSE message stream forwards unbuffered like the backend's.
//!
//! Env:
//!   SHODH_FRONT_PORT   listen port           (default 8787)
//!   SHODH_API_URL      backend base URL       (default http://127.0.0.1:3030)
//!   SHODH_API_KEY      injected as X-API-Key  (default empty)
//!   SHODH_SEAT_URL     seat harness base URL  (default http://127.0.0.1:3141)
//!   SHODH_SEAT_TOKEN   injected as Authorization: Bearer (default empty)

use axum::{
    body::{Body, Bytes},
    extract::State,
    http::{HeaderMap, Method, StatusCode, Uri},
    response::{Html, IntoResponse, Response},
    routing::{any, get},
    Router,
};
use std::net::SocketAddr;

/// The UI is embedded in the binary — the front is self-contained and needs no
/// working directory.
///
/// This is the React app under `front/ui`, built by Vite into exactly ONE
/// self-contained file: `vite-plugin-singlefile` inlines every script,
/// stylesheet and asset into the HTML (see front/ui/vite.config.ts), so there
/// is nothing beside it to serve. `dist/` is a build artefact and is not
/// committed; `build.rs` fails with the remedy if it has not been produced.
const INDEX_HTML: &str = include_str!("../ui/dist/index.html");

#[derive(Clone)]
struct Backend {
    base: String,
    api_key: String,
    seat_base: String,
    seat_token: String,
    client: reqwest::Client,
}

#[tokio::main]
async fn main() {
    let port: u16 = std::env::var("SHODH_FRONT_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(8787);
    let base = std::env::var("SHODH_API_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:3030".to_string())
        .trim_end_matches('/')
        .to_string();
    let api_key = std::env::var("SHODH_API_KEY").unwrap_or_default();
    let seat_base = std::env::var("SHODH_SEAT_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:3141".to_string())
        .trim_end_matches('/')
        .to_string();
    let seat_token = std::env::var("SHODH_SEAT_TOKEN").unwrap_or_default();

    let backend = Backend {
        base: base.clone(),
        api_key,
        seat_base,
        seat_token,
        client: reqwest::Client::new(),
    };

    let app = Router::new()
        .route("/", get(index))
        .route("/api/{*path}", any(proxy))
        .route("/seat/{*path}", any(seat_proxy))
        .with_state(backend);

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .unwrap_or_else(|e| panic!("shodh-front: cannot bind {addr}: {e}"));
    println!("shodh-front on http://{addr}  →  backend {base}");
    axum::serve(listener, app).await.unwrap();
}

async fn index() -> Html<&'static str> {
    Html(INDEX_HTML)
}

/// Reverse-proxy `/api/*` to the backend, streaming the response so SSE works.
async fn proxy(
    State(backend): State<Backend>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    // Preserve the full original path + query ("/api/recall?..." etc.).
    let path_and_query = uri
        .path_and_query()
        .map(|pq| pq.as_str())
        .unwrap_or_else(|| uri.path());
    let target = format!("{}{}", backend.base, path_and_query);

    let mut req = backend.client.request(method, &target).body(body);
    // Forward the request headers the backend cares about; inject the key.
    for name in ["content-type", "accept"] {
        if let Some(v) = headers.get(name) {
            req = req.header(name, v);
        }
    }
    if !backend.api_key.is_empty() {
        req = req.header("X-API-Key", &backend.api_key);
    }

    forward(req, &backend.base).await
}

/// Reverse-proxy `/seat/*` to the conversation-seat harness, stripping the
/// `/seat` prefix (`/seat/v1/models` → `{SHODH_SEAT_URL}/v1/models`) and
/// injecting the seat bearer token. Streaming end-to-end — the seat's message
/// endpoint is SSE.
async fn seat_proxy(
    State(backend): State<Backend>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let path_and_query = uri
        .path_and_query()
        .map(|pq| pq.as_str())
        .unwrap_or_else(|| uri.path());
    let stripped = path_and_query.strip_prefix("/seat").unwrap_or(path_and_query);
    let target = format!("{}{}", backend.seat_base, stripped);

    let mut req = backend.client.request(method, &target).body(body);
    for name in ["content-type", "accept"] {
        if let Some(v) = headers.get(name) {
            req = req.header(name, v);
        }
    }
    if !backend.seat_token.is_empty() {
        req = req.header("Authorization", format!("Bearer {}", backend.seat_token));
    }

    forward(req, &backend.seat_base).await
}

/// Send a proxied request and stream the response back unbuffered.
async fn forward(req: reqwest::RequestBuilder, upstream: &str) -> Response {
    match req.send().await {
        Ok(resp) => {
            let status = StatusCode::from_u16(resp.status().as_u16())
                .unwrap_or(StatusCode::BAD_GATEWAY);
            let content_type = resp
                .headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("application/octet-stream")
                .to_string();
            let mut builder = Response::builder()
                .status(status)
                .header("content-type", content_type);
            // Keep SSE responses unbuffered end-to-end.
            if let Some(cc) = resp.headers().get("cache-control") {
                if let Ok(cc) = cc.to_str() {
                    builder = builder.header("cache-control", cc.to_string());
                }
            }
            builder
                .body(Body::from_stream(resp.bytes_stream()))
                .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
        }
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            format!("shodh-front proxy error → {upstream}: {e}"),
        )
            .into_response(),
    }
}
