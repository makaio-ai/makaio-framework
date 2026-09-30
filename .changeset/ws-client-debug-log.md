---
"@makaio/framework": patch
"@makaio/bus-transport-websocket": patch
"@makaio/inbound-hooks": patch
---

Add an optional `debugLog` sink to the WebSocket client transport (default `console.info`). The exported `createE2ERelayCodec` accepts the same optional `debugLog` (default `console.info`). The hook fast path now routes transport debug output to stderr, so it no longer lands on stdout, which is the hook response channel.
