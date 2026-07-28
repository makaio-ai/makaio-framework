---
'@makaio/ai-adapters-core': patch
'@makaio/contracts': patch
---

Gate warm-path rehydration behind the same native-resume decision as the cold path, and stop pinning used provider session IDs on fresh generations. `adapter.rehydrateAgent` no longer promotes the `adapterSessionId` identity marker to a provider resume target when the agent is still registered: native resume now requires the caller's explicit `resumeAdapterSessionId` or a host-tier locality verdict on the stored record, exactly like cold rehydration. Fresh replacement connectors (warm and cold) now mint a new provider session identity instead of inheriting the previous one — pinning a used ID collided with the provider's durable session store (claude CLI: "Session ID already in use"). Connector swap overrides gained key-presence semantics for `resumeAdapterSessionId` (mirroring `reasoningEffort`) so a replacement generation can be built explicitly fresh instead of silently inheriting the agent's start-time resume target.
