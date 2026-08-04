---
"@makaio/ai-adapters-core": minor
"@makaio/contracts": minor
"@makaio/framework": minor
"@makaio/services-core": minor
---

Split provider-session provenance from resume currency on the session record.

`session.adapterSessionId` keeps its write-once meaning as the immutable origin
identity (import conflict key). Two new columns track where the provider session
actually is: `currentAdapterSessionId` plus a tri-state
`currentAdapterSessionIdState` (`inherited` | `moved` | `confirmed`), defaulted so
existing rows and imports read as `inherited` without a backfill.

A new `agent.adapterSession.moved` event is the single seam every provider-session
movement converges on — provider confirmation, connector swaps, pre-confirmation
rotation when a turn disables native resume, and cold rehydration that mints a new
provider session. A service-tier handler applies those movements to the session row
under lead-agent ownership, with an adapter-identity consistency guard and a
change guard.

Attach now resolves the resume currency once and uses that single value for
locality evaluation, live-writer detection, and the resume target, so a resumed
provider session can no longer diverge from the verdict it was granted under. An
unconfirmed movement degrades through the new `adapter-session-moved` locality
reason instead of resuming an abandoned provider thread. Native fork resolves the
source session's currency the same way, so a fork after a rotation or cold
rehydrate branches from the live provider session rather than the origin one.

Movement announcements are awaited by their producers, which orders the session
row's currency write ahead of the action that depends on it: the dispatch that
abandons the old provider session, and the first agent event that advertises a
newly confirmed one.
