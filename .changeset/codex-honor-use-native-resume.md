---
"@makaio/adapter-codex-app-server": patch
---

Fix: codex connector now honors `useNativeResume: false`.

Previously, `sendMessage` called `startThread()` before examining the
`options` parameter, so a `useNativeResume: false` decision from the
agent-turn executor had no effect — the connector would unconditionally
send `thread/resume` whenever `resumeAdapterSessionId` was set.

The fix clears `turnCtx.resumeAdapterSessionId` before invoking
`startThread()` when the caller supplies `useNativeResume: false`,
mirroring the suppression pattern already present in the
`claude-agent-sdk` connector.
