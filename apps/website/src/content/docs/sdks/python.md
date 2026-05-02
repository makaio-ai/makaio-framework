---
title: Python SDK
description: Python SDK for participating in the Makaio bus protocol over WebSocket.
---

The Python SDK (`makaio-bus`) provides a lightweight client for participating in the Makaio bus
protocol over WebSocket. It is not published yet; install it from the framework workspace while
developing locally.

## Installation

From the repository root:

```bash
python -m pip install -e sdks/python
```

## Features

- WebSocket transport lifecycle management
- Wire envelope handling and request correlation
- Typed subject emission, request handling, and subscription
- Async/await API built on `asyncio`

## Quick Start

```python
import asyncio

from makaio import BusClient

async def main() -> None:
    client = BusClient("ws://localhost:6252/bus")
    await client.connect()
    await client.emit("my.subject", {"key": "value"})
    await client.close()

asyncio.run(main())
```

For full API details, see the [SDK source](https://github.com/makaio-ai/makaio-framework/tree/main/sdks/python).
