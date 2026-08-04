---
title: "storage:agent"
editUrl: false
prev: false
next: false
---

# `storage:agent`

| Field | Value |
|-------|-------|
| Prefix | `storage:agent` |
| Namespace constant | `AgentStorageNamespace` |
| Subjects constant | `AgentStorageSubjects` |
| Kind | storage |
| Schema record | `<inline>` |
| Tier | framework |
| Package | `@makaio/services-core` |
| Defined in | [`services/core/src/session/storage/agent-namespace.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/session/storage/agent-namespace.ts) |

## Subjects

| Key | Wire | Type | Schema |
|-----|------|------|--------|
| `delete` | [`storage:agent.delete`](#storage:agent.delete) | rpc | — |
| `get` | [`storage:agent.get`](#storage:agent.get) | rpc | — |
| `listByAdapter` | [`storage:agent.listByAdapter`](#storage:agent.listByAdapter) | rpc | — |
| `listBySession` | [`storage:agent.listBySession`](#storage:agent.listBySession) | rpc | — |
| `set` | [`storage:agent.set`](#storage:agent.set) | rpc | — |
| `updateActivity` | [`storage:agent.updateActivity`](#storage:agent.updateActivity) | rpc | — |
| `updateRuntime` | [`storage:agent.updateRuntime`](#storage:agent.updateRuntime) | rpc | — |
| `updateStatus` | [`storage:agent.updateStatus`](#storage:agent.updateStatus) | rpc | — |

## Subject Details

### <a id="storage:agent.delete"></a>`storage:agent.delete` (rpc)

Delete an agent by ID.

Subject: `storage:agent.delete`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `agentId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `success` | `boolean` | yes |

### <a id="storage:agent.get"></a>`storage:agent.get` (rpc)

Get an agent by ID.

Subject: `storage:agent.get`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `agentId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `agent` | `{ agentId: string; adapterId: string; adapterName: string; sessionId: string; role: "lead" \| "member"; status: "active" \| "starting" \| "idle" \| "dead" \| "disposed"; createdAt: number; lastActivityAt: number; adapterSessionId?: string \| undefined; currentAdapterSessionId?: string \| undefined; currentAdapterSessionIdState?: "confirmed" \| "inherited" \| "moved" \| undefined; revision?: number \| undefined; currencyFence?: number \| undefined; model?: string \| undefined; cwd?: string \| undefined; allowedDirectories?: string[] \| undefined; providerConfigId?: string \| undefined; personaId?: string \| undefined; profileId?: string \| undefined; harnessId?: string \| undefined; clientId?: string \| undefined; compressionMode?: "manual" \| "auto" \| "off" \| undefined; } \| null` | yes |

### <a id="storage:agent.listByAdapter"></a>`storage:agent.listByAdapter` (rpc)

List agents by adapter name with optional status filter.

Subject: `storage:agent.listByAdapter`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterName` | `string` | yes |
| `status` | `"all" \| "active" \| "starting" \| "idle" \| "dead" \| "disposed" \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `agents` | `{ agentId: string; adapterId: string; adapterName: string; sessionId: string; role: "lead" \| "member"; status: "active" \| "starting" \| "idle" \| "dead" \| "disposed"; createdAt: number; lastActivityAt: number; adapterSessionId?: string \| undefined; currentAdapterSessionId?: string \| undefined; currentAdapterSessionIdState?: "confirmed" \| "inherited" \| "moved" \| undefined; revision?: number \| undefined; currencyFence?: number \| undefined; model?: string \| undefined; cwd?: string \| undefined; allowedDirectories?: string[] \| undefined; providerConfigId?: string \| undefined; personaId?: string \| undefined; profileId?: string \| undefined; harnessId?: string \| undefined; clientId?: string \| undefined; compressionMode?: "manual" \| "auto" \| "off" \| undefined; }[]` | yes |

### <a id="storage:agent.listBySession"></a>`storage:agent.listBySession` (rpc)

List agents by session ID.

Subject: `storage:agent.listBySession`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `sessionId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `agents` | `{ agentId: string; adapterId: string; adapterName: string; sessionId: string; role: "lead" \| "member"; status: "active" \| "starting" \| "idle" \| "dead" \| "disposed"; createdAt: number; lastActivityAt: number; adapterSessionId?: string \| undefined; currentAdapterSessionId?: string \| undefined; currentAdapterSessionIdState?: "confirmed" \| "inherited" \| "moved" \| undefined; revision?: number \| undefined; currencyFence?: number \| undefined; model?: string \| undefined; cwd?: string \| undefined; allowedDirectories?: string[] \| undefined; providerConfigId?: string \| undefined; personaId?: string \| undefined; profileId?: string \| undefined; harnessId?: string \| undefined; clientId?: string \| undefined; compressionMode?: "manual" \| "auto" \| "off" \| undefined; }[]` | yes |

### <a id="storage:agent.set"></a>`storage:agent.set` (rpc)

Store or update an agent.

A whole-record write of a caller-held snapshot, so on an *existing* row it
may not carry every column: the ownership columns and the origin provider
session stay with the stored row, and a stored `disposed` status wins over
the snapshot's. Disposal is the agent's removal and is terminal (see
`updateStatus`); a snapshot read before it must not revive the row. On a
fresh row there is nothing to protect and the caller's record is stored
verbatim.

Subject: `storage:agent.set`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `agent` | `{ agentId: string; adapterId: string; adapterName: string; sessionId: string; role: "lead" \| "member"; status: "active" \| "starting" \| "idle" \| "dead" \| "disposed"; createdAt: number; lastActivityAt: number; adapterSessionId?: string \| undefined; currentAdapterSessionId?: string \| undefined; currentAdapterSessionIdState?: "confirmed" \| "inherited" \| "moved" \| undefined; revision?: number \| undefined; currencyFence?: number \| undefined; model?: string \| undefined; cwd?: string \| undefined; allowedDirectories?: string[] \| undefined; providerConfigId?: string \| undefined; personaId?: string \| undefined; profileId?: string \| undefined; harnessId?: string \| undefined; clientId?: string \| undefined; compressionMode?: "manual" \| "auto" \| "off" \| undefined; }` | yes |
| `agentId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `success` | `boolean` | yes |

### <a id="storage:agent.updateActivity"></a>`storage:agent.updateActivity` (rpc)

Update agent last activity timestamp.

Subject: `storage:agent.updateActivity`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `agentId` | `string` | yes |
| `lastActivityAt` | `number` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `success` | `boolean` | yes |

### <a id="storage:agent.updateRuntime"></a>`storage:agent.updateRuntime` (rpc)

Update runtime-mutable agent fields without full record overwrite.

The agent's ownership columns (currency pair, revision, fence) are
deliberately not expressible here: they may only be written under a claim
generation, through the `storage:sessionOwnership` seam. `adapterSessionId`
below is the immutable *origin* identity, not the currency.

Subject: `storage:agent.updateRuntime`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string \| undefined` | no |
| `adapterSessionId` | `string \| undefined` | no |
| `agentId` | `string` | yes |
| `allowedDirectories` | `string[] \| undefined` | no |
| `cwd` | `string \| undefined` | no |
| `model` | `string \| undefined` | no |
| `providerConfigId` | `string \| null \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `success` | `boolean` | yes |

### <a id="storage:agent.updateStatus"></a>`storage:agent.updateStatus` (rpc)

Update agent status, optionally as a compare-and-swap.

**`disposed` is terminal.** A row that already carries it never transitions
again, whatever `status` or `expectedStatus` the call names. Disposal is
the agent's removal, and ownership authority is a predicate over the agent
row: a status revived to `idle` would let a removed agent reserve and
settle again. Enforcing it here — rather than asking every lifecycle writer
to check first — is what makes the guarantee hold against a removal that
lands mid-start or mid-rehydrate.

Subject: `storage:agent.updateStatus`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `agentId` | `string` | yes |
| `expectedStatus` | `("active" \| "starting" \| "idle" \| "dead" \| "disposed")[] \| undefined` | no |
| `status` | `"active" \| "starting" \| "idle" \| "dead" \| "disposed"` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `success` | `boolean` | yes |
| `transitioned` | `boolean` | yes |

---

*Auto-generated by `yarn docs:bus`. Do not edit manually.*
