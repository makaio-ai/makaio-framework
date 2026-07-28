---
'@makaio/client-claude-code': patch
---

Admit `rate_limit_event` into the SDK message union.

The CLI emits `rate_limit_event` whenever subscription rate-limit info
changes; the `sdk.event` union did not include it, so every occurrence was
reported as a schema violation for traffic the client knowingly forwards.
The message is diagnostic-only: it joins `SDKMessageSchema` (and is exported
as `SDKRateLimitEventMessageSchema` / `SDKRateLimitInfoSchema`) but stays out
of `KNOWN_SDK_MESSAGE_TYPES`, so turn-state routing is unchanged.
