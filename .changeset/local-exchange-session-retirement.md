---
'@makaio/framework': patch
---

Retire local protected WebSocket exchange sessions at idle expiry or when their issuer invalidates the committed identity key. Remove routes and subscriptions before starting the close handshake. Protected exchange composition remains test-only.
