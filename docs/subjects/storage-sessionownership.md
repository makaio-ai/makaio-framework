---
title: "storage:sessionOwnership"
editUrl: false
prev: false
next: false
---

# `storage:sessionOwnership`

| Field | Value |
|-------|-------|
| Prefix | `storage:sessionOwnership` |
| Namespace constant | `SessionOwnershipStorageNamespace` |
| Subjects constant | `SessionOwnershipStorageSubjects` |
| Kind | storage |
| Schema record | `<inline>` |
| Tier | framework |
| Package | `@makaio/contracts` |
| Defined in | [`core/contracts/src/session/session-ownership-storage-namespace.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/session/session-ownership-storage-namespace.ts) |

## Subjects

| Key | Wire | Type | Schema |
|-----|------|------|--------|
| `claim` | [`storage:sessionOwnership.claim`](#storage:sessionOwnership.claim) | rpc | — |
| `finalizeRecovery` | [`storage:sessionOwnership.finalizeRecovery`](#storage:sessionOwnership.finalizeRecovery) | rpc | — |
| `getRuntimeInstance` | [`storage:sessionOwnership.getRuntimeInstance`](#storage:sessionOwnership.getRuntimeInstance) | rpc | — |
| `listClaims` | [`storage:sessionOwnership.listClaims`](#storage:sessionOwnership.listClaims) | rpc | — |
| `read` | [`storage:sessionOwnership.read`](#storage:sessionOwnership.read) | rpc | — |
| `release` | [`storage:sessionOwnership.release`](#storage:sessionOwnership.release) | rpc | — |
| `releaseAgentClaims` | [`storage:sessionOwnership.releaseAgentClaims`](#storage:sessionOwnership.releaseAgentClaims) | rpc | — |
| `retireInstance` | [`storage:sessionOwnership.retireInstance`](#storage:sessionOwnership.retireInstance) | rpc | — |
| `settleCurrency` | [`storage:sessionOwnership.settleCurrency`](#storage:sessionOwnership.settleCurrency) | rpc | — |
| `settleMovement` | [`storage:sessionOwnership.settleMovement`](#storage:sessionOwnership.settleMovement) | rpc | — |

## Subject Details

### <a id="storage:sessionOwnership.claim"></a>`storage:sessionOwnership.claim` (rpc)

Take or take over the ownership claim on a provider session, optionally
designating the claiming agent as the session's lead in the same
transaction.

With `providerSessionId: null` it is the **keyless reservation**: no claim
row at all, and the designation plus its currency mirror are the whole
effect. That is the fresh-start shape — there is no provider identity to
own yet, and the designation still has to be atomic and compare-and-swap.

Subject: `storage:sessionOwnership.claim`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `adapterName` | `string` | yes |
| `agentId` | `string` | yes |
| `claimToken` | `string` | yes |
| `designateLead` | `{ expectedLeadAgentId: string \| null; clear?: true \| undefined; restore?: true \| undefined; } \| undefined` | no |
| `machineId` | `string` | yes |
| `ownerInstance` | `{ instanceId: string; } \| undefined` | no |
| `providerSessionId` | `string \| null` | yes |
| `recoveryAttemptId` | `string \| undefined` | no |
| `recoveryGuard` | `{ expectedStatus: "active" \| "starting" \| "idle" \| "dead" \| "disposed"; expectedPreimage: { status: "active" \| "starting" \| "idle" \| "dead" \| "disposed"; adapterId: string; binding?: { adapterId: string; ownerMachineId: string; ownerInstanceId: string; } \| undefined; recoveryAttemptId?: string \| undefined; }; expectedRevision: number; expectedCurrencyFence: number; expectedCurrency: { adapterSessionId: string \| null; currentAdapterSessionId: string \| null; currentAdapterSessionIdState: "confirmed" \| "inherited" \| "moved"; }; ownerGeneration: { claimId: string; claimToken: string; fence: number; ownerInstanceId: string \| null; status: "held" \| "releasing" \| "abandoned"; } \| null; } \| undefined` | no |
| `sessionId` | `string` | yes |
| `supersedes` | `{ claimToken: string; } \| undefined` | no |
| `topology` | `"machine-exclusive" \| "shared-machine" \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `claim` | `{ machineId: string; adapterId: string; providerSessionId: string; claimId: string; adapterName: string; sessionId: string; agentId: string; ownerInstanceId: string \| null; claimToken: string; fence: number; status: "held" \| "releasing" \| "abandoned"; claimedAt: number; updatedAt: number; } \| null \| undefined` | no |
| `currency` | `{ adapterSessionId: string \| null; currentAdapterSessionId: string \| null; currentAdapterSessionIdState: "confirmed" \| "inherited" \| "moved"; } \| undefined` | no |
| `currencyFence` | `number \| undefined` | no |
| `currentLeadAgentId` | `string \| null \| undefined` | no |
| `holder` | `{ machineId: string; adapterId: string; providerSessionId: string; claimId: string; adapterName: string; sessionId: string; agentId: string; ownerInstanceId: string \| null; claimToken: string; fence: number; status: "held" \| "releasing" \| "abandoned"; claimedAt: number; updatedAt: number; } \| undefined` | no |
| `leadDesignated` | `boolean \| undefined` | no |
| `missing` | `"session" \| "agent" \| undefined` | no |
| `outcome` | `"claimed" \| "idempotent" \| "already-claimed" \| "agent-disposed" \| "session-not-active" \| "lead-conflict" \| "not-found" \| "currency-changed" \| "recovery-conflict"` | yes |
| `ownerGeneration` | `{ claimId: string; claimToken: string; fence: number; ownerInstanceId: string \| null; status: "held" \| "releasing" \| "abandoned"; } \| null \| undefined` | no |
| `previousLeadAgentId` | `string \| null \| undefined` | no |
| `recovery` | `{ attemptId: string; preimage: { status: "active" \| "starting" \| "idle" \| "dead" \| "disposed"; adapterId: string; binding?: { adapterId: string; ownerMachineId: string; ownerInstanceId: string; } \| undefined; recoveryAttemptId?: string \| undefined; }; } \| undefined` | no |
| `revision` | `number \| undefined` | no |
| `status` | `"archived" \| "closed" \| "discovered" \| "active" \| "starting" \| "idle" \| "dead" \| "disposed" \| undefined` | no |

### <a id="storage:sessionOwnership.finalizeRecovery"></a>`storage:sessionOwnership.finalizeRecovery` (rpc)

Terminalize a recovery attempt under its opaque attempt fence.

Subject: `storage:sessionOwnership.finalizeRecovery`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `action` | `{ kind: "rollback"; preimage: { status: "active" \| "starting" \| "idle" \| "dead" \| "disposed"; adapterId: string; binding?: { adapterId: string; ownerMachineId: string; ownerInstanceId: string; } \| undefined; recoveryAttemptId?: string \| undefined; }; } \| { kind: "succeeded"; } \| { kind: "failed"; }` | yes |
| `agentId` | `string` | yes |
| `attemptId` | `string` | yes |
| `binding` | `{ adapterId: string; ownerMachineId: string; ownerInstanceId: string; }` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `applied` | `boolean` | yes |

### <a id="storage:sessionOwnership.getRuntimeInstance"></a>`storage:sessionOwnership.getRuntimeInstance` (rpc)

Read one runtime-instance row for diagnostics only.

Subject: `storage:sessionOwnership.getRuntimeInstance`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `instanceId` | `string` | yes |
| `machineId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `instance` | `{ instanceId: string; machineId: string; incarnation: number; startedAt: number; retiredAt: number \| null; } \| null` | yes |

### <a id="storage:sessionOwnership.listClaims"></a>`storage:sessionOwnership.listClaims` (rpc)

List the claims recorded for a machine — the read reconciliation and
ownership diagnostics run on.

Subject: `storage:sessionOwnership.listClaims`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string \| undefined` | no |
| `machineId` | `string` | yes |
| `providerSessionId` | `string \| undefined` | no |
| `statuses` | `("held" \| "releasing" \| "abandoned")[] \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `claims` | `{ machineId: string; adapterId: string; providerSessionId: string; claimId: string; adapterName: string; sessionId: string; agentId: string; ownerInstanceId: string \| null; claimToken: string; fence: number; status: "held" \| "releasing" \| "abandoned"; claimedAt: number; updatedAt: number; }[]` | yes |

### <a id="storage:sessionOwnership.read"></a>`storage:sessionOwnership.read` (rpc)

Read one agent's durable ownership state.

**Not a consistent snapshot**, in either direction: the agent row and its
claims are read as two statements, so a concurrent claim or release can
show up in one and not the other. A reader may therefore observe a claim
whose fence the agent's `currencyFence` does not yet account for, or a
`currencyFence` whose authoring claim has already been released. Both are
legitimate instants of the aggregate; a reader that needs authority must
ask for it (`settleCurrency`) rather than infer it from this read.

Subject: `storage:sessionOwnership.read`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `agentId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `ownership` | `{ agentId: string; sessionId: string; currency: { adapterSessionId: string \| null; currentAdapterSessionId: string \| null; currentAdapterSessionIdState: "confirmed" \| "inherited" \| "moved"; }; revision: number; currencyFence: number; claims: { machineId: string; adapterId: string; providerSessionId: string; claimId: string; adapterName: string; sessionId: string; agentId: string; ownerInstanceId: string \| null; claimToken: string; fence: number; status: "held" \| "releasing" \| "abandoned"; claimedAt: number; updatedAt: number; }[]; } \| null` | yes |

### <a id="storage:sessionOwnership.release"></a>`storage:sessionOwnership.release` (rpc)

Give up a claim — freeing the ownership key only on a clean release.

Subject: `storage:sessionOwnership.release`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `agentId` | `string` | yes |
| `claimToken` | `string` | yes |
| `disposition` | `"releasing" \| "abandoned" \| "released"` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `claim` | `{ machineId: string; adapterId: string; providerSessionId: string; claimId: string; adapterName: string; sessionId: string; agentId: string; ownerInstanceId: string \| null; claimToken: string; fence: number; status: "held" \| "releasing" \| "abandoned"; claimedAt: number; updatedAt: number; } \| undefined` | no |
| `holder` | `{ machineId: string; adapterId: string; providerSessionId: string; claimId: string; adapterName: string; sessionId: string; agentId: string; ownerInstanceId: string \| null; claimToken: string; fence: number; status: "held" \| "releasing" \| "abandoned"; claimedAt: number; updatedAt: number; } \| undefined` | no |
| `outcome` | `"released" \| "marked" \| "not-owner" \| "not-found"` | yes |

### <a id="storage:sessionOwnership.releaseAgentClaims"></a>`storage:sessionOwnership.releaseAgentClaims` (rpc)

Give up every claim an agent holds, or exactly one of them, in a single
statement — the teardown fan-out and the reservation rollback.

Subject: `storage:sessionOwnership.releaseAgentClaims`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `agentId` | `string` | yes |
| `claimToken` | `string \| undefined` | no |
| `disposition` | `"releasing" \| "abandoned" \| "released"` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `claimTokenNotFound` | `boolean` | yes |
| `markedClaims` | `{ machineId: string; adapterId: string; providerSessionId: string; claimId: string; adapterName: string; sessionId: string; agentId: string; ownerInstanceId: string \| null; claimToken: string; fence: number; status: "held" \| "releasing" \| "abandoned"; claimedAt: number; updatedAt: number; }[]` | yes |
| `releasedProviderSessionIds` | `string[]` | yes |

### <a id="storage:sessionOwnership.retireInstance"></a>`storage:sessionOwnership.retireInstance` (rpc)

Stamp every row for a runtime process as retired without releasing its
claims. Repeating the operation is idempotent.

Subject: `storage:sessionOwnership.retireInstance`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `instanceId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `retiredMachines` | `number` | yes |

### <a id="storage:sessionOwnership.settleCurrency"></a>`storage:sessionOwnership.settleCurrency` (rpc)

Write an agent's adapter-session currency under a claim generation, and
mirror it onto the session row when the agent is the designated lead.

What is settled here is what a restart resumes: the resume-identity path
resolves an agent's currency from this row whenever it has been settled,
and falls back to the session row only for rows written before the agent
row could carry currency at all.

Subject: `storage:sessionOwnership.settleCurrency`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `agentId` | `string` | yes |
| `claimToken` | `string` | yes |
| `expectedRevision` | `number` | yes |
| `fence` | `number` | yes |
| `target` | `{ currentAdapterSessionId: string \| null; currentAdapterSessionIdState: "confirmed" \| "inherited" \| "moved"; }` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `currency` | `{ adapterSessionId: string \| null; currentAdapterSessionId: string \| null; currentAdapterSessionIdState: "confirmed" \| "inherited" \| "moved"; } \| undefined` | no |
| `currentFence` | `number \| undefined` | no |
| `outcome` | `"settled" \| "idempotent" \| "superseded" \| "currency-changed" \| "not-owner" \| "agent-disposed" \| "not-found"` | yes |
| `revision` | `number \| undefined` | no |
| `sessionSnapshotUpdated` | `boolean \| false \| undefined` | no |

### <a id="storage:sessionOwnership.settleMovement"></a>`storage:sessionOwnership.settleMovement` (rpc)

Record a provider-session movement in full: acquire or recognize the
successor generation, settle the agent's currency under it, retire the
predecessors it replaces, and mirror the result onto the session row —
all in one transaction.

The composite `settleCurrency` exists inside. Callers use this one;
`settleCurrency` remains the single-step primitive the claim/settle
interleavings are exercised through.

Subject: `storage:sessionOwnership.settleMovement`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `adapterName` | `string` | yes |
| `agentId` | `string` | yes |
| `expectedRevision` | `number` | yes |
| `machineId` | `string` | yes |
| `movement` | `{ kind: "confirmed"; providerSessionId: string; claimToken: string; } \| { kind: "demote"; claimToken: string; }` | yes |
| `ownerInstance` | `{ instanceId: string; } \| undefined` | no |
| `sessionId` | `string` | yes |
| `topology` | `"machine-exclusive" \| "shared-machine" \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `claim` | `{ machineId: string; adapterId: string; providerSessionId: string; claimId: string; adapterName: string; sessionId: string; agentId: string; ownerInstanceId: string \| null; claimToken: string; fence: number; status: "held" \| "releasing" \| "abandoned"; claimedAt: number; updatedAt: number; } \| null \| undefined` | no |
| `currency` | `{ adapterSessionId: string \| null; currentAdapterSessionId: string \| null; currentAdapterSessionIdState: "confirmed" \| "inherited" \| "moved"; } \| undefined` | no |
| `currentFence` | `number \| undefined` | no |
| `holder` | `{ machineId: string; adapterId: string; providerSessionId: string; claimId: string; adapterName: string; sessionId: string; agentId: string; ownerInstanceId: string \| null; claimToken: string; fence: number; status: "held" \| "releasing" \| "abandoned"; claimedAt: number; updatedAt: number; } \| undefined` | no |
| `outcome` | `"settled" \| "idempotent" \| "already-claimed" \| "superseded" \| "currency-changed" \| "not-owner" \| "agent-disposed" \| "not-found"` | yes |
| `releasedProviderSessionIds` | `string[] \| undefined` | no |
| `revision` | `number \| undefined` | no |
| `sessionSnapshotUpdated` | `boolean \| false \| undefined` | no |

---

*Auto-generated by `yarn docs:bus`. Do not edit manually.*
