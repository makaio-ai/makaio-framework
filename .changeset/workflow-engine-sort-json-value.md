---
'@makaio/subsystem-workflow-engine': patch
---

Workflow state schema signatures use `sortJsonValue` from contracts (key order now case-folded via `compareStrings`; the signature is an in-process cache key only).
