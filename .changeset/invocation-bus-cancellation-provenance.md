---
"@makaio/runtime-node": patch
"@makaio/framework": patch
---

Use the Bus cancellation provenance predicate when reading an Attempt's frozen
instruction. Local Preparation, control binding and Invocation still support
direct AbortSignal reasons and ordinary DOM AbortError exceptions, but only
classify a BusAbortError as cancellation when it belongs to their own signal.
Foreign Bus cancellation failures remain technical outcomes without discarding
retained Workspace files or bypassing Authority acknowledgement.
