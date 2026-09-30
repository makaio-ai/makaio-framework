---
"@makaio/framework": patch
"@makaio/inbound-hooks": patch
---

`connectFastHookBus` and `emitInboundHookReceivedFast` accept a `debug` option so callers can control transport debug logging instead of inheriting `MAKAIO_DEBUG`.
