---
'@makaio/framework': major
'@makaio/contracts': minor
'@makaio/runtime-node': major
---

Verify a redeemed worker's runtime credential over the protected setup connection and reuse the original session expiry. The existing worker-provider entry exports the bootstrap digest helper. **Breaking for protected connection exchange bindings:** Owners using this exchange must supply an opaque `identityRevocationKey` with the locked booking. The exchange persists it on first use and requires the same key for replay and reconnect. Direct atomic redemption retains its run-derived revocation key.

Reconnect remains test-only pending owner status composition and session revocation. The test status reader is fixture-owned. The stock worker still requires a bound order decoder before executing an ordered run.
