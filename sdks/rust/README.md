# Makaio Rust SDK

Rust SDK for participating in the Makaio bus protocol over WebSocket or stdio transports.

The crate is named `makaio-sdk` and is currently unpublished (`publish = false`). Use it from
`sdks/rust` in this source workspace.

This client exposes the protocol bus surface for WebSocket and newline-delimited stdio
transports:

- strongly typed wire envelopes for `event`, `request`, `response`, `broadcast`, `broadcast-response`, `heartbeat`,
  `subscribe`, `unsubscribe`, `subscribe-sync-complete`, and HMAC auth frames
- an async `BusClient` with `connect`, `connect_with_options`, `from_stdio`, `close`, `emit`, `request`,
  `subscribe`, and `on_request`
- generated subject constants and typed subject descriptors from `sdks/manifest/makaio-bus-protocol.json`
- typed structs for stable payloads, while intentionally open JSON fields remain `serde_json::Value`

## Connection Options

`BusClient::connect(url)` defaults to local-first request dispatch and automatic `/health` probing.
When the server reports `auth: true`, the client requires an explicit secret or `MAKAIO_BUS_SECRET`
and completes the HMAC handshake before normal bus frames are processed. Use
`BusClient::connect_with_options(url, BusClientOptions { ... })` to force remote dispatch, disable
auth, or pass an explicit HMAC secret.

## Dispatch Modes

- `DispatchMode::LocalFirst`: local request handlers run first; unresolved requests fall through to the remote bus.
- `DispatchMode::Remote`: outbound requests always go through the transport.

## Stdio

Detached extension processes can use `BusClient::from_stdio(stream)` with a bidirectional
newline-delimited JSON stream, or `BusClient::from_stdio_parts(reader, writer)` when stdin and
stdout are separate handles. The host owns process launch and trust; stdio disables HMAC auth.

## Usage

```rust
use makaio_sdk::{generated::subjects, BusClient};
use serde_json::json;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let bus = BusClient::connect("ws://localhost:6252/bus").await?;

    let _subscription = bus
        .subscribe(subjects::agent::MESSAGE, |event| async move {
            println!("agent message: {}", event.payload);
        })
        .await?;

    bus.emit(
        subjects::agent::MESSAGE,
        json!({
            "agentId": "agent-1",
            "adapterId": "adapter-1",
            "adapterName": "example",
            "adapterSessionId": "session-1",
            "content": "hello",
        }),
    )
    .await?;

    bus.close().await?;
    Ok(())
}
```

## Development

```bash
cd sdks/rust
cargo test
```
