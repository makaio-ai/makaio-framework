---
'@makaio/contracts': major
'@makaio/framework': major
'@makaio/ai-adapters-core': major
'@makaio/services-core': major
'@makaio/subsystem-adapter': major
'@makaio/subsystem-native-session-supervisor': minor
'@makaio/ai-adapters-acp-client': minor
'@makaio/ai-adapters-stream-session': minor
'@makaio/adapter-claude-code-cli': minor
'@makaio/adapter-claude-code-tmux': minor
'@makaio/adapter-codex-app-server': minor
'@makaio/adapter-qwen-acp': minor
'@makaio/adapter-claude-agent-sdk': minor
'@makaio/adapter-cursor-sdk': minor
'@makaio/adapter-github-copilot-sdk': minor
'@makaio/adapter-gemini-sdk': minor
'@makaio/adapter-pi-sdk': minor
'@makaio/runtime-node': patch
'@makaio/cli': patch
'@makaio/subsystem-workflow-engine': patch
---

Closing a connector now reports what closure meant, and an adapter instance can no longer be named without its machine.

Five paths closed a connector and none of them said what they had observed;
`shutdownAdapterInstances` could not tell a timed-out instance from a clean one at
all. Ownership rested on that silence: a release said "this provider session is
free" on the strength of a call having returned. This release gives closure a
vocabulary, makes the underlying evidence *awaitable* before anything is allowed
to claim it, routes every teardown through one door, and finishes the one-identity
rule the previous ownership releases left split.

**Exit evidence became observable before it became reportable.** The
`claude-code-cli` and `codex-app-server` transports expose a settled `exited`
promise, so a caller can await the observation instead of accepting the return of
the close call. The tmux backend stops writing an exit it never saw: an exit is
published only when a tmux server established the session's absence, or — after a
successful kill — when a bounded confirming read or the pane PID it captured at
creation proves no process holds it. Every other answer is `unknown`, and a dead
tmux server proves nothing about a pane's process. Init paths that a teardown
queues behind are bounded: `waitForSpawn` takes a timeout and an `AbortSignal`,
qwen finally honours its declared `initialization` budget, and every tmux
invocation carries the executor's own timeout.

**BREAKING — `AIAgentConnector.close()` returns `ConnectorTeardownResult`.** The
`void` arm is gone from the abstract signature, so every implementation answers for
itself. `TeardownEvidenceSchema` ranks five classes from `exited` to `unknown`,
`teardownWasObserved` is the one boundary consumers branch on, and aggregation
takes the weakest class in the set. Each of the eleven connectors reports the class
its own local evidence supports and says so in one sentence of TSDoc; the four
connectors that swallowed their own kill failures now report `unknown` and name the
stage instead of returning a class from under a `catch`. A connector that replaces
a process *inside itself* books the superseded generation as unproven at the moment
it is superseded, and caps its reported class at `detached` while any generation is
unretired — because the window in which nobody is watching is exactly the window a
teardown arrives in.

**BREAKING — `adapter.stopAgent` gains a required `evidence` field**, and
`shutdownAdapterInstances` returns per-instance and aggregate results instead of
swallowing. `success: true` no longer means "the connector is gone"; it means "it
was there". A hook that never returned is `unknown`, a hook that threw is `unknown`
with a different detail, a hook that returned is `detached`, and an instance with no
hook is `released` — so a timeout is never a clean close. Every instance is still
attempted and the registry is still cleared.

**One arbitrated door.** A new `AgentTeardownArbiter` — one per adapter instance,
a required dependency of the registry and of every agent's replacement coordinator
— owns the teardown and replacement maps. The four agent teardowns share one
flight, entry removal happens behind it, and a reentrant eviction triggered by the
very `agent.session.closed` that close emitted joins the flight that emitted it. A
connector *replacement* is a different act and arbitrates against that flight
rather than joining it: replacements refuse when they find a teardown, teardowns
wait when they find a replacement, so a same-agent cycle is unrepresentable rather
than merely avoided. The replacement settlement never rejects and carries every
handle it could not prove closed **plus the report of every close it performed
itself** — a superseded close that reports `detached` fails nothing and proves
nothing, so a waiting teardown aggregates it rather than answering for the agent
more strongly than the runtime it inherited allowed.
**`AgentConnectorLifecycleManager` leaves the
public barrel**, which is what makes "one door" a property of the module instead of
a convention.

**BREAKING — `AdapterSelection.adapterId` now requires `machineId`.** An instance
ID is a one-way hash of `(machineId, adapterName)`, so an instance cannot name its
own machine; every ownership act keyed on a caller-named instance under the
*resolving* runtime's machine built a key unique to that mistake, colliding with
nothing and protecting nothing while the runtime that really owns the instance
claimed the same provider session beside it. The refinement lives on
`AdapterSelectionSchema` and `agent.attach` now validates its selection through the
same union `sendMessage` uses instead of the open base, so the rule is stated once
and `agent.attachResolved` inherits it. **That swap also widens the refusal: a
selection carrying neither an adapter name nor an instance ID is now refused at the
wire instead of thrown by the handler** — strictly better, since a schema refusal
precedes every side effect, but a behaviour change beyond `machineId`. **The rule
is symmetric: a `machineId` without an `adapterId` is refused as well.** Resolution
reads the field only on the branch a named instance takes, so that shape was
accepted and silently ignored — and a caller left believing its machine was
honoured is one step from the mis-key above. **Both halves are refused by the
handlers too, not only by the schema**, because payload validation returns early in
production builds and an in-process caller reaches them unparsed: a
selection naming a machine and no instance now fails the start instead of quietly
starting the agent on the resolving runtime's own machine. **The rule is stated once
and applied on every path that reads the pair** — the fresh-start resolver, the
attach handler's name-only resolution (which derived for this runtime and read the
caller's machine nowhere), and the product start *before* it chooses between a local
and a container dispatch, since the container branch returned ahead of the resolver
and so started container agents from selections every other path refuses. Attach keeps
its one documented asymmetry: a named instance without its machine is answered with a
locality degrade rather than a refusal, because a fresh-with-history conversation is
an honest answer where a start on an unchosen host is not.

**One ownership resolver.** `resolveOwnedAdapterInstance` replaces
`resolveLiveAdapterId` and `resolveLiveAdapterIdForMachine`, returning
`{ adapterId, machineId }` or `undefined` — *this runtime may not act for that
machine* — and the four hand-built reservation payloads collapse onto one builder
that takes the pair as a single value. Both halves of the key now come from one
call, so "instance and namespace come from one identity" is structural rather than
a rule each call site remembers.

**`storage:session.update` gains the adapter identity behind a predicate.** The
establishing lead used to publish the identity triplet as a whole-record write,
narrowed only by a re-read and a re-check immediately before it — so a peer that
established the identity inside that gap was overwritten by a record already
assembled. The triplet is now a nested `identity` value, both-or-neither by
construction, admitted onto the partial-update surface only together with
`expectIdentityOpenForLead`: both identity columns still unpopulated **and** the
row still naming the expected designation, checked by the same statement that
writes. A refused write reports `success: false` and withholds every field it
carried. Both backends implement it, and the predicate is asserted on both
dialects.

**The in-memory agent store stops handing out live rows.** It was the only store
that did — sessions and ownership already clone on read, and every SQL read is
materialised — so a caller could mutate a stored agent in place and bypass both the
terminal-`disposed` guard and the ownership-column preservation that exist to keep
those columns writable only through the subjects that own them. The three agent
reads now return detached copies, and the whole-record write compares against a
detached previous row. Nothing was relying on the aliasing; what it cost was that a
test written against this backend could pass vacuously, which is the divergence
this closes.
