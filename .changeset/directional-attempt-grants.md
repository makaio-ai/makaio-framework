---
'@makaio/bus-transport-websocket': major
'@makaio/framework': major
'@makaio/runtime-node': major
---

Replace flat HMAC identity subject grants with separate message and subscription grants.
Peers can now advertise subjects without being permitted to originate requests, events, or broadcasts for them. The retired `allowedSubjects` option and resolver are rejected or removed; migrate callers to `allowedMessageSubjects` and `allowedSubscriptionSubjects`.

Workflow execution attempts now receive delivery and cancellation subjects only as subscriptions. The WebSocket server binds operation and control delivery recipients to the authenticated Attempt identity at every outbound request, event, and broadcast delivery, even when an Attempt has no active subscription advertisement.
