---
'@makaio/ai-adapters-core': major
'@makaio/contracts': major
'@makaio/framework': minor
'@makaio/services-core': major
'@makaio/subsystem-adapter': major
---

Reserve provider-session ownership at every start seam: the adapter, the rehydrate, and the attach.

The previous release made the session service the authority on who owns a
provider session, but only two callers asked it: the fresh lead start and the
restart. Every other path that can end up talking to a provider — an
adapter-owned `mode: 'resume'` start, the three rehydrate consumers, and attach —
still dispatched first and reconciled afterwards, which is the same window the
authority exists to close, just moved one layer down. This release brings all of
them under it. **A start that has not reserved does not dispatch.**

**The authority is no longer optional.** The adapter subsystem declares the
session package as a dependency, and every reservation is a hard `bus.request`.
A host that composes an adapter without the session service now fails to boot
rather than starting unreserved — there is no modeled "authority absent, proceed"
outcome anywhere, by design: a degrade in the result union is exactly what the
per-path refusal matrix was written to remove. Two undeclared boot requirements
became explicit along the way (the canonical-model package and every discovered
adapter contributor must order after the adapter subsystem), which is also what
made the previously latent ordering bug in the isolated workflow runtime visible.

**The adapter reserves the session it is about to resume.** An adapter-owned
resume start now claims the provider session, then writes its agent row, then
dispatches — and a refusal comes back as `dispatch: 'not-dispatched'` where the
call previously went through. The reservation is leak-proof by construction: one
outer classification splits pre-registration failure (release the token, delete
the row) from post-registration failure (release the token, CAS the row
`starting → dead`, evict the connector without writing `disposed`, which would
contradict the row), so no path can leave a claim behind. A reserved start whose
agent-row persistence fails now fails the start instead of logging and
continuing — the row is the only thing that makes the claim reconcilable.

**Rehydrate answers instead of throwing.** `adapter.rehydrateAgent` returns a
disposition union rather than `{}`: its three pre-provider refusals — a disposed
agent, a denied cold-path claim, a denied warm-path claim — are modeled as
`not-dispatched` so a reserved caller can give its reservation back cleanly,
while anything that may have reached the provider still throws and is
`dispatch-uncertain` by construction. A single-flight joiner now receives the
real result instead of a fabricated success. The request also accepts
`callerOwnsAgentRow`, which hands the `starting → idle` transition to the service
that reserved.

**One reserved rehydrate, three consumers.** `restartAgents`, the in-flight start
join and `recoverAgent` all run through `runReservedRehydrate`, and the raw
dispatch primitive is exported from no barrel — an unreserved rehydrate is
unreachable from outside the package, with an ESLint pair narrowing the surface
inside it. Its outcome distinguishes **`deferred`** from failure: a provider
session a live generation elsewhere owns is not an error, it is an agent this
runtime may not drive right now. Deferral propagates end to end — the recovery
result names the deferred agents, they re-enter target resolution *before*
admission and routing so nothing routes to them, `sendMessage`'s response reports
them, and a send whose only targets were deferred fails honestly with
`agent-unavailable` instead of silently delivering to nobody.

**Attach stops probing and starts claiming.** Attach mints its own agent
identity, writes the row before dispatch, and lets storage decide the conflict:
a losing insert degrades to `agent-already-started` where a read-then-write probe
previously guessed. The reservation is taken above the history seeding so a
refusal costs nothing, and a lead conflict is a full pre-dispatch rollback rather
than a half-built session. Attach is the one keyed start on the send path, so
unlike the framework send path its occupied-degrade is reachable in production
and is tested live.

**Release is by token, not by fan-out.** A failed start gives back the
generations *it* took, named by claim token, and no longer sweeps up claims the
attempt never made. A caller may also name the claim token its own settlement
will create, so a reserved start whose settlement response is lost can still
recognize its own generation. Exactly one production caller keeps the keyless
agent-wide release: the `session.agent.removed` handler, where agent-wide
teardown is the point.

## Breaking

1. **`AdapterSubjects.rehydrateAgent`**: the request gains optional
   `callerOwnsAgentRow`; **the response is no longer `{}`** but a `success` union
   carrying `dispatch: 'not-dispatched'` and a message on failure, and the
   *confirmed* `adapterSessionId` on success. Three refusals (disposed,
   cold-path claim denial, warm-path claim denial) no longer throw, and a
   single-flight joiner now receives the real result. The response type is
   derived via `ExtractSubjectResponse<typeof AdapterSubjects.rehydrateAgent>`;
   it is deliberately not re-exported from the contracts root.
2. `rehydrateAgent` no longer writes `agents.status` for caller-owned rows; the
   service owns the `starting → idle` transition and classifies a refusal:
   removal ⇒ lost start, anything else ⇒ silent no-op.
3. `recoverAgent` / `verifyAndRecoverAgents` reserve before dispatching and
   dispatch with `callerOwnsAgentRow`. `verifyAndRecoverAgents` returns
   `VerifiedAgents` — `{ usable, recoveredAgentIds, deferredAgentIds }` —
   instead of `{ verifiedAgents, recoveredAgentIds }`; **every caller must
   handle `deferredAgentIds`**. `dispatchAgentRehydrate` is no longer exported
   from `@makaio/services-core`.
4. `AdapterSubjects.startAgent` gains no field, but an **adapter-owned
   `mode: 'resume'` start now reserves provider-session ownership before
   dispatching** and can refuse with `dispatch: 'not-dispatched'` where it
   previously dispatched.
5. A reserved adapter-owned start **fails** when its agent-row persistence fails
   — including when the storage subject is unhandled or answers
   `success: false` — where an unreserved start still logs and continues.
6. `session.agent.attach` mints and owns the agent row, writes it before
   dispatch, and degrades with `agent-already-started` on a storage-decided
   conflict instead of probing. `persistAgentIdentity`,
   `persistIdentityOrRollback` and `rollbackPersistedIdentity` are removed
   (`persistAttachAgentRow` remains); `launchAttachAgent` throws
   `AttachStartError` carrying the disposition. **A post-dispatch attach failure
   now leaves a `dead` agent row where it previously left none** — including a
   failed *initial turn*, because the start commits (`starting → idle`)
   immediately after its settlement rather than after the first turn: a row still
   `starting` while a turn runs misinforms every consumer of it.
7. **Failed starts release by token, not by fan-out**: `abandonDispatchedStart`
   and the post-dispatch refusal rows are scoped to the attempt's own claim
   tokens. A cleanup no longer destroys generations the attempt did not take.
8. `runReservedRehydrate` returns `deferred` distinctly from
   `rehydrated { native }` and **never dispatches on `occupied`**. A send whose
   only targets are deferred fails with `agent-unavailable`.
9. **The ownership authority is required**: `sendMessage`'s fresh start,
   `restartAgents`, attach and adapter-owned resume starts fail rather than
   proceeding unreserved when it is absent. `@makaio/subsystem-adapter` declares
   the session package as a dependency.
10. `ActiveAgentRegistry` gains `claimAgentIdentity` / `releaseAgentIdentityClaim`
    — a caller-owned start reserves its agent identity in the registry
    synchronously, so two starts cannot race one identity.
11. `session.agent.removed` gains a documented producer duty: the emitter must
    have stopped the agent's connector, because the handler releases the claims
    that anchor it. **This release does not enforce it and claims no guarantee.**
12. `SessionSubjects.sendMessage`'s response gains optional `deferredAgentIds`.
    Additive; a caller that ignores it sees today's shape, but a caller that
    needs to know its send was narrower than asked now can.
13. `session.ownership.settleMovement`'s service request gains optional
    `claimToken`, so a reserved caller can name the generation its own settlement
    creates even when the response is lost. No storage change.
14. `SessionStartError` gains a readonly `deferredAgentIds`; `AttachStartError`
    gains a readonly `code` (`lead-conflict` | `reservation-refused` |
    `start-failed`) and **every** pre-dispatch refusal carries
    `dispatch: 'not-dispatched'` explicitly.
15. `rehydrateAgent`'s failure `dispatch` is narrowed to the literal
    `'not-dispatched'` — a modeled refusal is by construction pre-dispatch, and
    everything that may have reached the provider throws.
16. `StartCleanupPolicy` gains an optional `reservation`, so the shared cleanup
    can clear a lead designation its caller made on a post-dispatch failure.
    Absent, the previous designation-retained behaviour is unchanged.
17. `verifyAndRecoverAgents`' deferrals re-enter target resolution before
    admission and routing; a caller that only records them routes to agents it
    may not drive.
18. **Composition ordering is now declared, not assumed.** New exports
    `ADAPTER_SUBSYSTEM_PACKAGE_NAME`, `contributesToAdapterSubsystem` and
    `orderAfterAdapterSubsystem`; the canonical-model package and every
    discovered adapter contributor are ordered after the adapter subsystem in
    both the node boot path and the isolated workflow runtime. Without the
    latter, discovered adapter extensions failed to start once the session
    dependency became hard.
19. **`SessionStartFailureCode` loses `start-lost`.** Every caller-owned commit —
    the fresh lead start, attach and the reserved rehydrate — now applies one
    three-way rule to a refused `starting → idle`: a *removed* row is a lost
    start surfacing `agent-unavailable`, and a competing status write is a silent
    no-op. A peer that compare-and-swaps `starting → dead` to claim a recovery no
    longer costs a healthy start its live connector, so the code had no producer
    left. Callers matching on it must match `agent-unavailable`.
20. **The per-turn activity stamp is a compare-and-swap.** `active`/`idle` are
    written only over `idle`/`active`, so a fire-and-forget stamp that lands
    after its start was retired can no longer revive a `dead` or `starting` row.
    A host that relied on a turn resurrecting a row out of the start/teardown
    states no longer gets that.
21. **A joined recovery is classified by the agent row, not by the absence of a
    rejection.** A consumer that joins an in-flight recovery for an agent — the
    send path's lazy recovery and `recoverAgent` — now re-reads the row the
    joined attempt left: usable is usable, a `dead` row buys exactly one
    re-entry through the exclusive path so this caller gets its own answer
    (including `deferred`), and a gone or `disposed` row is reported as
    unavailable. A joiner previously reported success for an attempt that had
    built nothing.
22. **`session.restartAgents` recovers through the shared run-or-join seam.** The
    restart handler no longer runs the reserved rehydrate and rebuilds the join
    tail beside it, so item 21's rule now covers it too: a restart that joins an
    in-flight attempt which built no connector re-enters the seam once and
    reports its **own** outcome, where it previously failed with "a concurrent
    start for this agent ended without a usable runtime". The failure texts for a
    joined attempt that rejected and for a gone or `disposed` row change with it.
23. **A post-dispatch failure names a removal.** All three caller-owned paths
    share one teardown: a step that throws after the dispatch abandons the
    attempt's generations, stops the connector and then re-reads the row. A start
    or attach whose completion failed because the agent was removed now surfaces
    `agent-unavailable` instead of `settlement-unresolved` — the classification
    the reserved rehydrate already made. The teardown itself is unchanged.
24. **`refuseTotalDeferral(caller, sessionId, deferredAgentIds)` is exported**
    from `@makaio/services-core/session`, for a product send pipeline that
    decides for itself *whether* a total deferral refuses but should raise the
    same failure when it does. The wording of the product orchestrator's own
    total-deferral message changes to the framework's; its code
    (`agent-unavailable`) and `deferredAgentIds` do not.
