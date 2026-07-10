---
"@makaio/ai-adapters-core": patch
---

Restore the `MessageHandle.wasDelivered` getter and the `rejectQueuedHandles` / `SESSION_CLOSED_QUEUE_ERROR` barrel exports that an automated sync commit accidentally reverted. The message lifecycle tracker and the Claude adapter sessions depend on both.
