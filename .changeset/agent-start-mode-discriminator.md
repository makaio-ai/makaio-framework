---
"@makaio/ai-adapters-core": minor
"@makaio/contracts": minor
"@makaio/hooks": minor
"@makaio/agent-sdk": minor
---

Add a required `startMode` discriminator (`fresh` | `resume` | `fork` | `rotation`) to the `agent.started` event, derived in the turn pipeline. SDK SessionStart hooks now filter to `['fresh', 'fork']` by default (overridable via `startModes`), so they fire once per session start instead of on every turn and query rotation.
