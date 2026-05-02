# Makaio Rust SDK

Rust SDK for participating in the Makaio bus protocol over WebSockets.

The crate is named `makaio-bus-sdk` and is currently unpublished (`publish = false`). Use it from
`sdks/rust` in this source workspace.

This client currently exposes the unauthenticated WebSocket protocol surface.

The SDK is intentionally small in Phase 1:

- strongly typed wire envelopes for `event`, `request`, `response`, `broadcast`, `broadcast-response`, `heartbeat`,
  `subscribe`, `unsubscribe`, and `subscribe-sync-complete`
- an async `BusClient` with `connect`, `close`, `emit`, `request`, `subscribe`, and `on_request`
- generated subject constants from `sdks/manifest/makaio-bus-protocol.json`
- typed structs for reliable Phase 1 payloads, while intentionally open JSON fields remain `serde_json::Value`

## Usage

```rust
use makaio_bus_sdk::{generated::subjects, BusClient};
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
