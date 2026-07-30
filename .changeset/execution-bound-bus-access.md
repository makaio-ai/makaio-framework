---
'@makaio/framework': minor
'@makaio/runtime-node': minor
'@makaio/bus-transport-websocket': patch
---

Publish workflow execution attempt bus-access provisioning with canonical
identity claims and subject restrictions. WebSocket server requests now target
only matching subscriptions and never route an inbound request back to its
origin socket.
