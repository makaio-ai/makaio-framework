---
title: Python SDK
description: Python SDK for participating in the Makaio bus protocol over WebSocket or stdio.
---

The Python SDK (`makaio-sdk`) provides a full bus node for participating in the Makaio bus
protocol. It is not published yet; install it from the framework workspace while developing locally.

## Installation

From the repository root:

```bash
python -m pip install -e sdks/python
```

## Features

- WebSocket and stdio transport (detached extension processes)
- HMAC authentication with automatic `/health` probing
- Local-first request dispatch with middleware chaining (`RequestContext.next()`)
- Typed subject descriptors and payload dataclasses generated from the protocol manifest
- `EventContext` / `RequestContext` handler API
- `once()` for waiting on a single event with optional filter and timeout
- `ExtensionHost` lifecycle wrapper for detached extensions
- `camelCase` / `snake_case` serialization between wire format and Python dataclasses
- Async/await API built on `asyncio` (Python 3.10+)

## Quick Start

```python
import asyncio

from makaio import BusClient, EventContext
from makaio.generated import agent

async def main() -> None:
    client = BusClient("ws://localhost:6252/bus")
    await client.connect()

    async def on_complete(ctx: EventContext) -> None:
        print(f"agent completed: {ctx.payload}")

    await client.subscribe(agent.complete, on_complete)
    await client.emit(agent.message, {"agentId": "a1", "content": "hello"})
    await client.close()

asyncio.run(main())
```

For full API details, see the [SDK source](https://github.com/makaio-ai/makaio-framework/tree/main/sdks/python).
