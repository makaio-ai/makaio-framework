---
"@makaio/bus-core": minor
---

`serializeTransportError` now uses the same codec as `serializeError` (structured members collected, an own `data` bag nests at `data.data`, flat members are no longer dropped). `serializeError` accepts `unknown`: plain-object inputs contribute `message`, `code`, and `subject` string members plus their remaining own enumerable props into `data`; `null` and primitives produce a message-only payload whose text is `String(error)` (previously `'Unknown error'` for non-string primitives).
