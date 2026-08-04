---
"@makaio/contracts": minor
"@makaio/framework": minor
"@makaio/services-core": major
---

Add the durable foundation for session ownership: claims, fencing and agent currency.

A provider-native session now has a place to record exactly one durable runtime
owner. The new `adapter_session_claims` table carries the claim token, a monotone
fence per claim generation, and the agent/session/machine/adapter identity; a
unique index over `(machine_id, adapter_id, provider_session_id)` is what makes
"exactly one winner" a property of the schema rather than of handler code, which
is the only formulation that also holds across processes.

The agent row gains the same currency trias the session row already had —
`currentAdapterSessionId` plus a tri-state `currentAdapterSessionIdState` — next
to a `revision` compare-and-swap counter and the `currencyFence` of the
generation that last wrote it. Fence orders claim generations, revision orders
writes inside one generation, and persisting the fence on the agent row is what
lets a write from a superseded owner be refused even after the claim was taken
over, released or re-taken. Both counters and the currency pair are written
exclusively through the new `storage:sessionOwnership` seam: whole-record
`storage:agent.set` omits them and `storage:agent.updateRuntime` cannot express
them, so a writer holding a pre-movement snapshot cannot resurrect an abandoned
provider session. `adapterSessionId` — the agent's immutable *origin* provider
session, and the only resumable ID an `inherited` agent has — is protected the
same way but one step later: `storage:agent.set` writes it when it creates the
row and never again, so a snapshot that omitted it or read it stale cannot erase
it. Changing it on a live agent is `storage:agent.updateRuntime`'s job.

A claim is an ownership of an agent *in a session*, so `settleCurrency`
additionally requires the claim to be filed under the agent's current session: an
agent moved between sessions by a whole-record write leaves its old generation
unable to settle it, and above all unable to publish its currency onto a session
that generation was never part of. `release` deliberately does not apply that
rule — giving a claim up needs no authority beyond having taken it, and demanding
membership there would leave a moved agent's old claim blocking its ownership key
forever.

`AdapterSessionCurrencySnapshot` and `resolveResumableAdapterSessionId` give the
session row and the agent row one shared shape and one shared rule for turning
it into a resume target, instead of each reader re-deriving the mapping.

`storage:session.update` is deliberately left alone — it does not become a
compare-and-swap surface. Nothing consumes the new seam yet.

**BREAKING** (`@makaio/services-core`): the package root no longer re-exports the dual-table definitions `importCursorsDual`, `messageRoutingDual`, `sessionEventsDual` and `turnsDual`; import them from `@makaio/services-core/session` like the other dual tables. The root barrel already omitted `agentsDual`/`sessionsDual`, so the subpath is now the single home for all of them.
