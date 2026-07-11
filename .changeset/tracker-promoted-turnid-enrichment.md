---
"@makaio/ai-adapters-core": patch
---

Resolve event-enrichment turnIds from the executing message handle instead of the shared `currentTurnId` field. A concurrent `sendMessage` overwrites the shared field while an earlier turn is still streaming, so intermediate events (message, reasoning, tool use) could carry the queued turn's id — and consumers keyed on turnId+messageId, like the session bridge's block accumulation, would drop them, omitting queued follow-up replies from persisted history.
