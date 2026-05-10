---
title: Rust SDK
description: Rust SDK for participating in the Makaio bus protocol over WebSockets.
---

The Rust SDK (`makaio-sdk`) provides a native Rust client for participating in the Makaio bus
protocol over WebSockets. The crate is currently unpublished; use it from the framework workspace.

## Installation

```toml
[dependencies]
makaio-sdk = { path = "../sdks/rust" }
```

## Features

- Async WebSocket transport via `tokio-tungstenite`
- Zero-copy message deserialization with `serde`
- Typed subject emission, request handling, and subscription
- Connection lifecycle management

## Quick Start

```rust
use makaio_sdk::BusClient;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let client = BusClient::connect("ws://localhost:6252/bus").await?;
    let payload = serde_json::json!({ "key": "value" });
    client.emit("my.subject", &payload).await?;
    Ok(())
}
```

For full API details, see the [SDK source](https://github.com/makaio-ai/makaio-framework/tree/main/sdks/rust).
