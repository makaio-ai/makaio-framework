---
title: "execution-attempt"
editUrl: false
prev: false
next: false
---

# `execution-attempt`

| Field | Value |
|-------|-------|
| Prefix | `execution-attempt` |
| Namespace constant | `ExecutionAttemptNamespace` |
| Subjects constant | `ExecutionAttemptSubjects` |
| Kind | bus |
| Schema record | `ExecutionAttemptSchemas` |
| Tier | framework |
| Package | `@makaio/contracts` |
| Defined in | [`core/contracts/src/execution-attempt/namespace.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/execution-attempt/namespace.ts) |

## Subjects

| Key | Wire | Type | Schema |
|-----|------|------|--------|
| `operation.admit` | [`execution-attempt.operation.admit`](#execution-attempt.operation.admit) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/execution-attempt/schemas.ts) |
| `operation.admitted` | [`execution-attempt.operation.admitted`](#execution-attempt.operation.admitted) | event | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/execution-attempt/schemas.ts) |
| `operation.deliver` | [`execution-attempt.operation.deliver`](#execution-attempt.operation.deliver) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/execution-attempt/schemas.ts) |
| `runtime.ready` | [`execution-attempt.runtime.ready`](#execution-attempt.runtime.ready) | event | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/execution-attempt/schemas.ts) |
| `runtime.register` | [`execution-attempt.runtime.register`](#execution-attempt.runtime.register) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/execution-attempt/schemas.ts) |

## Subject Details

### <a id="execution-attempt.operation.admit"></a>`execution-attempt.operation.admit` (rpc)

A caller asks the authority to admit one operation through the attempt's
start gate.

Emitter: Worker Runtime in this slice; the durable owner in later slices.
Handler: exactly one authority gate (`operation-admission.ts`), which refuses
on peer mismatch.
Effect: admits at most one operation at a time, keyed by `admissionKey` so a
retry is answered `duplicate` rather than admitted twice, and replies with the
decision.

Subject: `execution-attempt.operation.admit`
Type: Request (RPC) — command → decision

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `admissionKey` | `string` | yes |
| `executionAttemptId` | `string` | yes |
| `operationKind` | `"runtime-probe" \| "workflow-run"` | yes |
| `runtimeGeneration` | `number` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `decision` | `"duplicate" \| "refused" \| "admitted"` | yes |
| `operationId` | `string \| undefined` | no |
| `refusalReason` | `"resolved" \| "not-found" \| "fenced" \| "not-allocated" \| "operation-active" \| "gate-closed" \| "not-ready" \| "stale-generation" \| undefined` | no |

### <a id="execution-attempt.operation.admitted"></a>`execution-attempt.operation.admitted` (event)

The authority announces that a non-probe operation passed the start gate.

Emitter: attempt authority (`operation-admission.ts`), for non-probe kinds only —
the bounded runtime probe never reaches the pool.
Handler: per-instance listener filtered on its own `executionAttemptId` — the
worker pool observer. A filter miss returns; it is not an error.
Effect: the pool projects `worker.lifecycle.busy`.

Subject: `execution-attempt.operation.admitted`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `admittedAt` | `string` | yes |
| `executionAttemptId` | `string` | yes |
| `operationId` | `string` | yes |
| `operationKind` | `"workflow-run"` | yes |
| `runtimeGeneration` | `number` | yes |

### <a id="execution-attempt.operation.deliver"></a>`execution-attempt.operation.deliver` (rpc)

The authority hands one admitted operation to the runtime that owns the attempt.

This is the only subject in the namespace on which the authority is the
requester and the runtime the responder.

Emitter: attempt authority (`runtime-registration.ts`).
Handlers: every live Worker Runtime, each subscribing through
`bus.withFilter({ executionAttemptId, runtimeIncarnationId })` rather than
owning the subject globally. A filter miss returns undefined and
auto-advances the dispatch chain to the next responder, so only the
addressed incarnation answers — never a stale one of the same attempt.
Effect: the addressed runtime executes the delivered operation and returns its
receipt.

Subject: `execution-attempt.operation.deliver`
Type: Request (RPC) — delivery → receipt

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `executionAttemptId` | `string` | yes |
| `operationId` | `string` | yes |
| `operationKind` | `"runtime-probe" \| "workflow-run"` | yes |
| `runtimeGeneration` | `number` | yes |
| `runtimeIncarnationId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `receipt` | `"completed" \| "duplicate" \| "refused"` | yes |
| `refusalReason` | `"stale-generation" \| "unknown-kind" \| undefined` | no |

### <a id="execution-attempt.runtime.ready"></a>`execution-attempt.runtime.ready` (event)

The authority announces that an ExecutionAttempt has a proven runtime endpoint.

Emitter: attempt authority (`runtime-registration.ts`).
Handlers: per-instance listeners filtered on their own `executionAttemptId` —
the worker pool observer and the Fly machine tracker. A filter miss returns; it
is not an error.
Effect: the pool projects `worker.lifecycle.ready`; the provider settles its
boot supervision.

Subject: `execution-attempt.runtime.ready`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `acceptedAt` | `string` | yes |
| `executionAttemptId` | `string` | yes |
| `runtimeGeneration` | `number` | yes |

### <a id="execution-attempt.runtime.register"></a>`execution-attempt.runtime.register` (rpc)

The Worker Runtime reports that its incarnation is alive and asks to be
registered as the endpoint of its ExecutionAttempt.

Emitter: Worker Runtime (headless worker, Piscina thread).
Handler: exactly one authority gate (`runtime-registration.ts`), which refuses
on peer mismatch.
Effect: allocates the runtime generation, proves the endpoint by admitting and
delivering the bounded runtime probe, persists readiness, publishes
`execution-attempt.runtime.ready`, and replies with the decision.

Subject: `execution-attempt.runtime.register`
Type: Request (RPC) — report → decision

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `executionAttemptId` | `string` | yes |
| `runtimeIncarnationId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `decision` | `"ready" \| "duplicate" \| "refused"` | yes |
| `refusalReason` | `"resolved" \| "not-found" \| "fenced" \| "not-allocated" \| "operation-active" \| "probe-failed" \| undefined` | no |
| `runtimeGeneration` | `number \| 0` | yes |

---

*Auto-generated by `yarn docs:bus`. Do not edit manually.*
