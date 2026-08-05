---
'@makaio/contracts': patch
'@makaio/framework': major
'@makaio/services-core': major
---

Only the default send may bootstrap a session: a send that states its targets is refused before anything is started for it.

`session.sendMessage` starts a lead agent when the session has none. That branch
exists to give a session its *first* agent, and only one send form asks for *an*
agent: the default send, which carries no `agentIds`. Every other form states a
target, and a stated target is a claim about what the session already has —
`agentIds: ['a-1']` names agents an empty session provably does not have, and
`agentIds: 'all'` asks for all of nothing. Named ids could only ever fail — and
failed *after* bootstrapping, so the failed send left an agent row, a lead
designation and a reserved provider session behind it. A broadcast "succeeded":
the bootstrap invented the very agent the send then claimed to have reached all
of, which is a delivery in the same sense that an answer to a question nobody
asked is an answer.

**Stated targets are now admitted before the fresh-start branch.** Such a send
against a session with no agents is refused with the same
`SessionStartError('agent-unavailable', …)` the post-recovery target validation
raises. The code is reused rather than invented: it means "this runtime may not
act for these agents", and an agent that does not exist is the strongest form of
that, not a different fact. The named form carries its ids in `deferredAgentIds`
and in the message; a broadcast named none, so it carries no id payload rather
than an invented one.

This is an ordering change, not a replacement: targets that survive the new
admission are still validated after the liveness-and-recovery pass, because
existing is not the same as drivable.

**The admission is exported, because it is a contract and not an
implementation.** `admitFreshStartTargets` is available from
`@makaio/framework/services/session` (and `…/services/session/handlers`) for the
send pipelines a host composes itself. It is exported for the same reason
`resolveInFlightStarts` and `refuseTotalDeferral` are: a composed pipeline that
omits it starts a lead for a send that was already decided, and one that rebuilds
it answers "what did this send fail with" a second way.

**Breaking:** a send carrying `agentIds` — named ids *or* `'all'` — no longer
creates a lead agent or reserves a provider session against a session that has
none, neither as a success nor as a side effect of failing. Callers that relied
on `agentIds` bootstrapping a session (naming an id they expected the send to
create, or broadcasting into an empty session) must use the default send. For the
named-ids case the rejection also changes shape, from a plain `Error` ("No valid
target agents found") to a `SessionStartError` with code `agent-unavailable`;
`'all'` against an empty session previously succeeded by starting a lead and now
rejects the same way.
