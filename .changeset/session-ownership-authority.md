---
'@makaio/ai-adapters-core': major
'@makaio/contracts': major
'@makaio/framework': minor
'@makaio/services-core': major
---

Make the session service the authority on session ownership: reserved starts, settled movements, and one writer per row.

The durable claims and fences the previous release added are now consumed. Every
act that changes who owns a provider session is one storage transaction, and
every authority decision is a predicate over durable rows evaluated *inside* the
transaction that acts on it — never a read, an elapsed timer, or a liveness
probe. That is what closes the window a start used to run in: the agent row, the
ownership key and the session's lead designation were written by three separate
callers in an order nothing enforced, so a movement announced during a start had
no legitimate writer and two runtimes could each believe they owned one provider
conversation.

**Starts are reserved before they are dispatched.** A fresh lead start mints the
agent identity itself, persists the row as `starting`, and takes a *keyless
reservation* — no ownership key yet, because the provider will mint its own — in
the same transaction that designates the session's lead. A restart reserves the
provider session it is about to resume, as a **member**, against the live adapter
instance it resolved for that agent rather than the one persisted on the row. The
row becomes usable only after the settlement is accepted, and only through a
compare-and-swap that names the state it is leaving.

**A refusal is modeled, not an error.** A restart whose provider session is
already owned degrades to the same history-injected recovery an unresumable agent
takes. A settlement refused after a live connector exists is not a start failure:
it says this runtime may not own what the connector is talking to, so the
connector is stopped and the claims retired, while a settlement that merely did
not land keeps everything and lets the next send resolve it. Failure cleanup is
split by evidence — a refusal the adapter reports as `not-dispatched` is rolled
back completely (clean release, lead designation restored through the same
compare-and-swap that wrote it, row deleted); anything of unknown extent retires
the claims as `abandoned`, because only a failure of known extent may free an
ownership key.

**A start in flight is joinable.** A concurrent send that finds an agent mid-start
joins that attempt instead of opening a second lifecycle for the same identity,
and decides what to do from the row the attempt left behind — never from the
promise's outcome. Across processes the arbiter is the new status
compare-and-swap, so a reservation whose owner crashed stays recoverable.

**Deleting a session retires its ownership rows itself**, in the order every
ownership operation uses (`agents` → claims → `sessions`), instead of letting
the foreign keys cascade in the opposite one. The cascade is functionally
complete but takes the session row first, which is a lock cycle against any
concurrent reservation or settlement — and a Postgres deadlock there has no
retry anywhere to absorb it.

**An observed continuation reopens the session it continues.** A `resume` or
`compact` observation that rebinds a stored session reports the continuation to
the authority, which reopens a `closed` row — and always acts on the lineage
root, because provider-session identity lives there and compress children are
synthesized views carrying none. `archived` is deliberately left alone.

Ownership refuses a removed agent everywhere by predicate: no reservation,
settlement, takeover or lead designation can give a `disposed` agent authority
again, and a key held by a claim whose owning agent row is `disposed` is taken
over inside the reserving transaction. Giving a claim *up* is never refused —
that is the one act a removed agent must still be able to perform. A claim whose
rows are live but whose owning process died is not reclaimed; reconcile records
it as `abandoned` for operators and nothing more, because process death is not
yet provable from a durable row.

**BREAKING** (`@makaio/contracts`):

- `storage:session.update` no longer accepts `currentAdapterSessionId` /
  `currentAdapterSessionIdState`. Provider-session currency has exactly one
  writer, the `storage:sessionOwnership` seam.
- `storage:session.set` no longer writes `leadAgentId` on conflict — the stored
  designation wins, so a caller holding a pre-designation snapshot cannot
  overwrite a newer one. Lead designation has exactly one writer: the reserving
  transaction, including the clear.
- `storage:agent.updateStatus` gains an optional `expectedStatus` and a
  `transitioned` response field, making a lifecycle transition refusable.
  Existing callers omit the field and are unaffected.
- `storage:session.update` gains an optional `expectedStatus`, making a status
  transition a compare-and-swap. A caller acting on an *observation* needs it: it
  read a row, decided the observation implies a transition, and by the time it
  writes a concurrent archive or delete may have made that decision wrong.
  Refused writes report `success: false`, which the caller tells apart from a
  missing row by re-reading. Existing callers omit the field and are unaffected.
- **`disposed` is terminal at the storage layer.** A row that carries it never
  transitions again: `storage:agent.updateStatus` refuses whatever `status` or
  `expectedStatus` is named (reporting `success: true, transitioned: false`, the
  row being present), and `storage:agent.set` keeps the stored `disposed` on
  conflict the way it already keeps the origin provider session — a whole-record
  write is a caller-held snapshot and must not revive a removal it predates.
  Creation is untouched, and any other stored status is still overwritten, so a
  start or rehydrate reporting its connector ready still writes `idle`. Without
  this, a removed agent's status could be written back to `idle` and every
  ownership predicate — which reads that column — would let it reserve and settle
  again, which is the last resurrection route into the `disposed`-absorbing
  guarantee.
- `storage:sessionOwnership.claim` is now the reservation operation:
  `providerSessionId` is nullable (the keyless reservation),
  `designateLead.expectedLeadAgentId` is required whenever a designation is
  requested, `designateLead.clear` is the only sanctioned way to unset a lead,
  `claimed` / `idempotent` carry a nullable `claim` plus `previousLeadAgentId`,
  and there is a new `agent-disposed` outcome. **A key held by a claim whose
  owning agent row is `disposed` is now taken over rather than reported as
  `already-claimed`.**
- `storage:sessionOwnership.settleMovement` and `releaseAgentClaims` are new.
  `settleMovement` carries `agent-disposed` and returns the *effective*
  generation — the claim it actually wrote through — which callers carry into any
  later release instead of the token they sent.
- `storage:sessionOwnership.settleCurrency` gains `agent-disposed`: the disposed
  guard lives in the predicate both settle operations share.
- `AgentStatusSchema` gains `'starting'` — "the row exists and its start is in
  flight; no connector is confirmed yet". `storage:agent.listByAdapter`'s status
  filter widens with it, and the dual-dialect parity assertions change.
- `session.ownership.reserveStart`, `settleMovement`, `release`, `reconcile` and
  `continuation` are new subjects. Each is exactly one durable ownership act, so
  no caller composes one out of a sequence of storage calls. `continuation`
  additionally reports `unresolved` for a compress child whose lineage names no
  row carrying provider identity, and `reconcile` reports `vanished` for a claim
  that was released, deleted or repointed between the assessment and the write —
  neither may be reported as an act that did not happen.
- `adapter.startAgent` accepts an optional request `agentId`, and its failure
  response carries a required `dispatch` disposition (`not-dispatched` |
  `dispatch-uncertain`) so a caller can tell a refusal from a dispatch of unknown
  extent. Any producer of a failed start — including test fixtures — must stamp
  it.

**BREAKING** (`@makaio/ai-adapters-core`): supplying `agentId` to
`adapter.startAgent` transfers ownership of the agent row to the caller — the
adapter emits its lifecycle events but performs no whole-record agent write, and
refuses outright when its registry already holds that identity. Without an
`agentId` the behavior is unchanged.

**BREAKING** (`@makaio/services-core`):

- `MakaioSessionService` takes an options object carrying `machineId` and
  `topology`. The machine identity is injected by the composition root, never
  resolved through the bus: an ownership decision must not depend on which
  handler happened to register first. A host that composes the service **without**
  a `machineId` now settles no movements — every identity-dependent operation
  declines with `machine-identity-unavailable` and writes nothing, where the
  previous currency handler wrote unconditionally.
- `registerAdapterSessionCurrencyHandler` is replaced by
  `registerAdapterSessionMovementObserver`. A movement is an observation settled
  through the authority and serialized per agent, so a member records its own
  movement on its own row instead of being dropped by a lead-only guard. The
  observer **acknowledges what it applied**: `agent.adapterSession.moved` stays
  pending until the settlement is durable and reports a refusal by rejecting, so
  a producer's "delivered" still means the currency write happened and an
  unrecorded movement stays retryable instead of being silently retired.
- `SessionOrchestrator.sendMessage` persists the lead agent's row itself and
  supplies the identity to `adapter.startAgent`. A failed start rejects with a
  `SessionStartError` carrying a typed code (`ownership-refused`,
  `agent-unavailable`, `settlement-unresolved`, `start-lost`, `start-unresolved`,
  `lead-conflict`, `start-failed`) instead of a message to match on.
- `resolveAgentResumeIdentity` requires the agent's currency fields: a settled
  agent answers for its own provider conversation, and the session row is
  consulted only as a legacy fallback for rows written before the agent row could
  carry currency.
- `recoverAgent` takes the resolved adapter instance as a fourth parameter and
  resolves nothing itself; `verifyAndRecoverAgents` resolves one per dead agent.
  The ownership key names an adapter instance, so reserving against a stale
  persisted ID would reserve in a namespace the dispatch never uses.
- `registerMockStorageHandlers` takes an optional `omit` so a test can serve
  selected rows from a real backend.
