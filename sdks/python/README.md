# Makaio Python SDK

Python SDK for participating in the Makaio bus protocol over WebSocket or
stdio for detached extension processes.

Wire envelope handling, request correlation, subscription advertisement, HMAC
auth, and typed subject descriptors generated from
`sdks/manifest/makaio-bus-protocol.json`. Payload validation remains
server-side.

## Install

```bash
# Development (editable install from workspace root)
python -m pip install -e sdks/python
```

## Quick start

```python
import asyncio

from makaio import BusClient, EventContext
from makaio.generated import agent
from makaio.generated.payloads.agent import AgentCompletePayload


async def main() -> None:
    client = BusClient("ws://localhost:6252/bus")
    await client.connect()

    async def on_complete(ctx: EventContext[AgentCompletePayload]) -> None:
        print(f"outcome: {ctx.payload.outcome}")

    await client.subscribe(agent.complete, on_complete)

    await client.emit(
        agent.message,
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

## API

### `BusClient`

```python
BusClient(
    url: str | None = None,          # defaults to MAKAIO_BUS_URL or ws://127.0.0.1:6252/bus
    dispatch: "local-first" | "remote" = "local-first",
    auth: bool | None = None,        # None = auto-probe; True = force HMAC; False = skip
    auto_reconnect: bool = False,
    connect_timeout_ms: float = 5_000,
)
```

**Lifecycle**

```python
await client.connect()
await client.close()
```

**Event subscription**

```python
sub = await client.subscribe(
    subject,
    handler,
    priority=0,
    delivery_class="relayable",  # or "first-hop-only"
)
await sub.close()  # unsubscribe
```

**Request handlers**

```python
sub = await client.on_request(
    subject,
    handler,
    priority=0,
    delivery_class="relayable",  # or "first-hop-only"
)
await sub.close()
```

**Fire-and-forget event**

```python
await client.emit(subject, payload)
```

**Request/response**

```python
result = await client.request(subject, payload, timeout_ms=10_000)
```

**Wait for one event**

```python
ctx = await client.once(subject, filter={"sessionId": "..."}, timeout_ms=30_000)
```

### Handler signatures

Event handlers receive `EventContext`; request handlers receive `RequestContext`.

```python
from makaio import EventContext, RequestContext
from makaio.generated import agent, approval
from makaio.generated.payloads.agent import AgentStartedPayload
from makaio.generated.payloads.approval import ApprovalRequestRequest


async def on_started(ctx: EventContext[AgentStartedPayload]) -> None:
    print(ctx.payload.model, ctx.payload.cwd)


async def handle_approval(ctx: RequestContext[ApprovalRequestRequest, object]) -> None:
    if ctx.payload.risk_level == "destructive":
        ctx.set_result({"action": "deny", "message": "Requires manual approval"})
    else:
        ctx.set_result({"action": "allow"})
```

`RequestContext` methods: `set_result(value)`, `extend_result(mapping)`,
`replace_payload(new)`, `await ctx.next()` (pass to next handler in chain).

### Typed subjects

Subjects are typed descriptors in namespace modules generated from the protocol
manifest. Import them instead of string literals.

```python
from makaio.generated import agent, session, tool, approval

# EventSubject — use with subscribe() and emit()
agent.started         # EventSubject[AgentStartedPayload]
agent.complete        # EventSubject[AgentCompletePayload]
session.turn_completed  # EventSubject[SessionTurnCompletedPayload]

# RequestSubject — use with request() and on_request()
session.send_message  # RequestSubject[SessionSendMessageRequest, SessionSendMessageResponse]
approval.request      # RequestSubject[ApprovalRequestRequest, ApprovalRequestResponse]
tool.execute          # RequestSubject[ToolExecuteRequest, ToolExecuteResponse]
```

All methods accept plain strings too:

```python
await client.subscribe("agent.*", handler)   # wildcard pattern
await client.emit("agent.message", payload)  # plain string
```

### camelCase / snake_case

Wire messages use camelCase. Payload dataclasses use snake_case. Typed subject
descriptors make `BusClient` convert registered inbound payloads and typed
request responses automatically. Use the `_serialization` helpers when working
with plain string subjects or raw payload dictionaries:

```python
from makaio._serialization import from_wire, to_wire

# Inbound: camelCase wire dict → typed dataclass
payload = from_wire(ctx.payload, AgentStartedPayload)

# Outbound: typed dataclass → camelCase wire dict
wire = to_wire(SessionSendMessageRequest(session_id="s1", message={"text": "hi"}))
```

### Dispatch modes

`"local-first"` (default): `request()` checks for a local handler first. If
one is registered, the request is handled in-process without a wire round-trip.
`"remote"`: always sends over the transport.

```python
client = BusClient(dispatch="remote")
```

### `probe_health`

Check server availability and auth requirements without opening a WebSocket
connection.

```python
from makaio import probe_health

health = await probe_health("ws://localhost:6252/bus")
if health is not None:
    print(health.auth)  # True if HMAC auth is required
```

### `ExtensionHost`

Lifecycle wrapper for detached extension processes.

```python
from makaio import BusClient
from makaio.extension_host import ExtensionHost

client = BusClient.from_stdio()
await client.connect()

host = ExtensionHost("my-extension", client)

@host.on_init
async def setup() -> None:
    print("initializing")

@host.on_destroy
async def teardown() -> None:
    print("shutting down")

await host.start()             # waits for extension.<name>.init, then emits .ready
await host.run_until_destroyed()  # waits for extension.<name>.destroy, then emits .stopped
```

## Test

```bash
AI_AGENT=1 yarn test:sdk:python
```
