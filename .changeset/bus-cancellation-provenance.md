---
'@makaio/framework': minor
---

Preserve Bus Request cancellation reasons consistently with and without a
timeout. Recognized Error reasons retain their identity; other reasons use
`BusAbortError`, a DOM `AbortError` whose `cause` is the exact original value.
Cross-realm Error recognition is conservative, not universal; unrecognized
reasons still retain their identity through `cause`. The exported
`isRequestCancellation(error, signal)` helper distinguishes that cancellation
from an independent failure without inspecting messages.

The shared request wait owns abort-listener cleanup, while deadlines remain
separate. Correlation cancellation uses the same representation. Request,
optional-request and broadcast handling preserve caller-supplied error reasons
instead of mistaking them for missing handlers or bus deadlines.
