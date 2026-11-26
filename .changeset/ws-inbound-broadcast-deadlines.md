---
'@makaio/bus-transport-websocket': patch
---

Charge WebSocket server authorization time to inbound broadcast deadlines. Expired broadcasts return a timeout
response before dispatch. Local handlers receive the remaining budget. Peers receive the caller's original timeout,
and response aggregation retains its fixed, capped timeout.
