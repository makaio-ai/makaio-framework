---
title: Rust SDK
description: Rust SDK for participating in the Makaio bus protocol over WebSocket or stdio.
---

The Rust SDK (`makaio-sdk`) provides a native Rust bus node for participating in the Makaio bus
protocol. The crate is currently unpublished; use it from the framework workspace.

## Installation

```toml
[dependencies]
makaio-sdk = { path = "../sdks/rust" }
```

## Features

- WebSocket and stdio transport (detached extension processes)
- HMAC authentication with automatic `/health` probing
- Local-first request dispatch with middleware chaining (`RequestContext`)
- Typed subject traits (`EventSubject`, `RequestSubject`) and generated payload structs
- `emit_subject()` / `request_subject()` ergonomics for generated subject descriptors
- Dispatch modes: `LocalFirst` (default) and `Remote`
- Async runtime via `tokio` and `tokio-tungstenite`
- Zero-copy message deserialization with `serde`

## Quick Start

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

    bus.emit(subjects::agent::MESSAGE, json!({ "agentId": "a1", "content": "hello" })).await?;
    bus.close().await?;
    Ok(())
}
```

For full API details, see the [SDK source](https://github.com/makaio-ai/makaio-framework/tree/main/sdks/rust).
