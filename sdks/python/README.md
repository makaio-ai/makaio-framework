# Makaio Python SDK

Python SDK for participating in the Makaio bus protocol over WebSocket.

This package is intentionally small in Phase 1. It handles wire envelopes, request correlation,
subscription advertisement, no-handler responses, and generated subject constants from
`sdks/manifest/makaio-bus-protocol.json`. Payload validation remains server-side.

The Python distribution package is named `makaio-sdk`, but it is not published yet. Install it from
the workspace when developing locally.

This client currently exposes the unauthenticated WebSocket protocol surface.

## Install

```bash
python -m pip install -e sdks/python
```

## Usage

```python
import asyncio

from makaio import BusClient
from makaio.generated import subjects


async def main() -> None:
    client = BusClient("ws://localhost:6252/bus")
    await client.connect()

    async def on_agent_event(payload, message) -> None:
        print(f"{message['namespace']}.{message['subject']}", payload)

    await client.subscribe("agent.*", on_agent_event)
    await client.emit(
        subjects.AGENT_MESSAGE,
        {
            "agentId": "agent-1",
            "adapterId": "adapter-1",
            "adapterName": "example",
            "adapterSessionId": "adapter-session-1",
            "content": "hello",
        },
    )
    await client.close()


asyncio.run(main())
```

Handlers receive `(payload, message)`. Request handlers registered with `on_request` return the JSON
response payload. Use `close()` for clean shutdown. Server-side validation remains authoritative for
request, response, and event payloads.

## Test

```bash
cd sdks/python
python -m unittest discover -s tests
```
