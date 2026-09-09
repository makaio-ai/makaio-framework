---
"@makaio/runtime-node": patch
"@makaio/framework": patch
---

Keep TypeScript transform caches within the CodeExecution worker lifetime in source and built layouts, preventing file descriptor growth across repeated Piscina pool generations. Separate loader path redaction from environment flags so failure diagnostics retain ordinary digits while configured paths remain hidden.
