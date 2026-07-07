---
"@makaio/contracts": minor
"@makaio/services-core": minor
---

Surface native-locality degrade reasons in the session event stream and chat timeline.

New `locality.degraded` core session event type carries intent, verdict kind, reason, and optional agent/adapter/turn identifiers. Emitted exactly once at each degrade site where native resume or fork falls back to history injection. A new `LocalityDegradeNotice` presentational component renders human-readable explanations in the chat timeline; foreign-machine verdicts show a generic "another machine" label.
