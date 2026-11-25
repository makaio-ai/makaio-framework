---
"@makaio/runtime-node": major
---

Worker model replies now reject credentials sent on any attempt of the same turn, including raw, percent-encoded, and embedded base64 representations, even when the base64 contains ASCII whitespace.

This is a breaking behavior change for worker model credentials shorter than 16 bytes in the Authorization header. The model port returns `environmentMissing` before sending such a credential upstream. The startup failure log reports a fixed diagnostic identifier.
