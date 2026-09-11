---
'@makaio/subsystem-workflow-engine': patch
---

Workflow state schema signatures normalise key order with `sortJsonValue` from contracts (key order now case-folded via `compareStrings`; the signature is an in-process cache key only).
