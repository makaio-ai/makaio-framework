# @makaio/bus-transport-message-channel

`MessageChannel`/`MessagePort` transport for `@makaio/bus-core`. Enables the
framework bus to communicate across browser tab boundaries via a `SharedWorker`,
between a page and an embedded `iframe`, or between Node.js worker threads.

## Use Cases

- **SharedWorker hub** — multiple browser tabs each hold one `MessagePort` end;
  the SharedWorker holds the other and routes bus messages between them and the
  backend.
- **iframe embed** — a host page and a sandboxed iframe communicate through a
  `MessageChannel` pair.
- **Node.js worker threads** — pass `worker_threads.MessagePort` instances to
  bridge two in-process bus instances for testing or task isolation.
- **Custom bridges** — any object satisfying the `MessagePortLike` interface
  (e.g. React Native bridge, Electron IPC) can be used without modification.

## Quick Start

```typescript
import { createMessagePortTransport } from '@makaio/bus-transport-message-channel';
import { MakaioBus } from '@makaio/bus-core';

// In the host page (or SharedWorker client side):
const { port1, port2 } = new MessageChannel();

const transport = createMessagePortTransport({
  port: port1,
  name: 'shared-worker',
  // Set envelope: true when the port is multiplexed across logical channels
  envelope: true,
});

MakaioBus.registerTransport(transport);
await MakaioBus.connect();

// Wait until the remote peer has completed subscribe synchronisation
await transport.ready;

// port2 is transferred to the SharedWorker (or iframe) via postMessage
worker.port.postMessage({ port: port2 }, [port2]);
```

## API

### `createMessagePortTransport(options)`

Factory function. Returns a `MessagePortTransport` instance.

```typescript
import type { MessagePortTransportOptions } from '@makaio/bus-transport-message-channel';
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `port` | `MessagePortLike` | required | The port to wrap |
| `name` | `string` | `'message-port'` | Unique name within the bus transport registry |
| `envelope` | `boolean` | `false` | Wrap outbound messages in `{ channel: 'bus', message }` and unwrap inbound. Enable when the port is multiplexed (e.g. SharedWorker) |
| `debug` | `boolean` | `false` | Enable diagnostic logging |

### `MessagePortTransport`

Extends `BusTransport` with:

| Member | Description |
|--------|-------------|
| `ready` | `Promise<void>` that resolves when the remote bus completes the `subscribe-sync-complete` handshake. Requests must not be routed through this transport before it resolves |
| `subscribe(subject, filter?, priorities?)` | Subscribe to a subject on the remote peer |
| `unsubscribe(subject)` | Unsubscribe from a subject on the remote peer |
| `getSubscriptions()` | Return the current local subscription set |

### `MessagePortLike`

Duck-typed interface compatible with browser `MessagePort` and Node.js
`worker_threads.MessagePort`. Any object with `postMessage` and `onmessage`
satisfies this interface.

## Envelope Mode

When `envelope: true`, outbound messages are wrapped as:

```json
{ "channel": "bus", "message": { ... } }
```

Inbound messages without this envelope shape are silently ignored. Use this
when the `MessagePort` carries multiple logical channels and a discriminator
is needed to separate bus traffic from other messages.

## Subscribe Synchronisation

The transport implements the same subscribe-sync handshake as the WebSocket
transport. On connect, the remote bus sends its current subscription set
followed by a `subscribe-sync-complete` message. The `ready` promise resolves
after this handshake completes and the pre-registration buffer has been
replayed, guaranteeing that `remoteRequestHandlers` are fully populated before
the transport accepts routed requests.

For the transport architecture overview — subscribe-sync handshake, priority-cursor dispatch,
relay behavior, and how to build a custom transport — see the
[Transport Guide](../../docs/transport.md).

---

*Part of the [Makaio AI Framework](../../README.md)*
