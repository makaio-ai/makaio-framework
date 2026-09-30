---
"@makaio/framework": patch
"@makaio/bus-core": patch
"@makaio/inbound-hooks": patch
"@makaio/cli": patch
"@makaio/bus-transport-websocket": patch
---

`createBusInstance` accepts an optional `debugLog` sink for internal bus diagnostics (default `console.debug`). The CLI and the hook fast path pass a stderr writer, so these diagnostics no longer land on stdout, which carries command data, the JSON-RPC stream, and the hook response.

The never-throwing debug sink wrapper (`toSafeDebugLog`) now lives in `@makaio/bus-core` and is exported; the WebSocket transport uses it instead of a local copy.
