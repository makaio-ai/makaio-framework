---
"@makaio/bus-transport-websocket": minor
---

Detect half-open WebSocket client connections with a ping/pong liveness watchdog. The client now sends periodic pings and terminates the connection when pongs stop arriving, so the existing reconnect path recovers instead of hanging on a dead socket. Heartbeat interval and timeout are configurable via the new client options.
