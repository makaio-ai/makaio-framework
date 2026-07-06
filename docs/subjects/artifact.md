---
title: "artifact"
editUrl: false
prev: false
next: false
---

# `artifact`

| Field | Value |
|-------|-------|
| Prefix | `artifact` |
| Namespace constant | `ArtifactNamespace` |
| Subjects constant | `ArtifactSubjects` |
| Kind | bus |
| Schema record | `ArtifactSchemas` |
| Tier | framework |
| Package | `@makaio/contracts` |
| Defined in | [`core/contracts/src/artifact/namespace.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/artifact/namespace.ts) |

## Subjects

| Key | Wire | Type | Schema |
|-----|------|------|--------|
| `compare` | [`artifact.compare`](#artifact.compare) | rpc | — |
| `create` | [`artifact.create`](#artifact.create) | rpc | — |
| `created` | [`artifact.created`](#artifact.created) | event | — |
| `kind.changed` | [`artifact.kind.changed`](#artifact.kind.changed) | event | — |
| `kind.list` | [`artifact.kind.list`](#artifact.kind.list) | rpc | — |
| `kind.register` | [`artifact.kind.register`](#artifact.kind.register) | rpc | — |
| `observation.added` | [`artifact.observation.added`](#artifact.observation.added) | event | — |
| `query` | [`artifact.query`](#artifact.query) | rpc | — |
| `relation-type.list` | [`artifact.relation-type.list`](#artifact.relation-type.list) | rpc | — |
| `relation-type.register` | [`artifact.relation-type.register`](#artifact.relation-type.register) | rpc | — |
| `relation.added` | [`artifact.relation.added`](#artifact.relation.added) | event | — |
| `resolve` | [`artifact.resolve`](#artifact.resolve) | rpc | — |
| `resolveContext` | [`artifact.resolveContext`](#artifact.resolveContext) | rpc | — |
| `revise` | [`artifact.revise`](#artifact.revise) | rpc | — |
| `revised` | [`artifact.revised`](#artifact.revised) | event | — |
| `status.changed` | [`artifact.status.changed`](#artifact.status.changed) | event | — |

## Subject Details

### <a id="artifact.compare"></a>`artifact.compare` (rpc)

Compare two artifact revisions and return changed paths (RPC).

Subject: `artifact.compare`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `base` | `{ kind: string; id: string; revision: string; refClass?: "artifact" \| undefined; }` | yes |
| `target` | `{ kind: string; id: string; revision: string; refClass?: "artifact" \| undefined; }` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `base` | `{ kind: string; id: string; revision: string; scope: { level: string; ids?: Record<string, string> \| undefined; }; schemaVersion: string; data: Record<string, unknown>; relations: { type: string; target: { refClass: "artifact"; kind: string; id: string; revision: string; } \| { refClass: "local"; artifact: { refClass: "artifact"; kind: string; id: string; revision: string; }; localId: string; } \| { refClass: "evidence"; kind: string; id: string; revision?: string \| undefined; locator?: string \| undefined; }; }[]; actor: { kind: string; id: string; displayName?: string \| undefined; }; timestamp: number; confidence?: { level: "assumed" \| "inferred" \| "stated" \| "confirmed" \| "verified"; basis: { kind: string; actor: { kind: string; id: string; displayName?: string \| undefined; }; timestamp: number; detail?: string \| undefined; evidenceRef?: { refClass: "artifact"; kind: string; id: string; revision: string; } \| { refClass: "local"; artifact: { refClass: "artifact"; kind: string; id: string; revision: string; }; localId: string; } \| { refClass: "evidence"; kind: string; id: string; revision?: string \| undefined; locator?: string \| undefined; } \| undefined; }[]; } \| undefined; representations?: { markdown?: string \| undefined; summary?: string \| undefined; plaintext?: string \| undefined; } \| undefined; createdAt?: number \| undefined; }` | yes |
| `changedPaths` | `string[]` | yes |
| `target` | `{ kind: string; id: string; revision: string; scope: { level: string; ids?: Record<string, string> \| undefined; }; schemaVersion: string; data: Record<string, unknown>; relations: { type: string; target: { refClass: "artifact"; kind: string; id: string; revision: string; } \| { refClass: "local"; artifact: { refClass: "artifact"; kind: string; id: string; revision: string; }; localId: string; } \| { refClass: "evidence"; kind: string; id: string; revision?: string \| undefined; locator?: string \| undefined; }; }[]; actor: { kind: string; id: string; displayName?: string \| undefined; }; timestamp: number; confidence?: { level: "assumed" \| "inferred" \| "stated" \| "confirmed" \| "verified"; basis: { kind: string; actor: { kind: string; id: string; displayName?: string \| undefined; }; timestamp: number; detail?: string \| undefined; evidenceRef?: { refClass: "artifact"; kind: string; id: string; revision: string; } \| { refClass: "local"; artifact: { refClass: "artifact"; kind: string; id: string; revision: string; }; localId: string; } \| { refClass: "evidence"; kind: string; id: string; revision?: string \| undefined; locator?: string \| undefined; } \| undefined; }[]; } \| undefined; representations?: { markdown?: string \| undefined; summary?: string \| undefined; plaintext?: string \| undefined; } \| undefined; createdAt?: number \| undefined; }` | yes |

### <a id="artifact.create"></a>`artifact.create` (rpc)

Create a new artifact and its first revision (RPC).

Subject: `artifact.create`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `actor` | `{ kind: string; id: string; displayName?: string \| undefined; }` | yes |
| `confidence` | `{ level: "assumed" \| "inferred" \| "stated" \| "confirmed" \| "verified"; basis: { kind: string; actor: { kind: string; id: string; displayName?: string \| undefined; }; timestamp: number; detail?: string \| undefined; evidenceRef?: unknown; }[]; } \| undefined` | no |
| `createdAt` | `number \| undefined` | no |
| `data` | `Record<string, unknown>` | yes |
| `kind` | `string` | yes |
| `relations` | `{ type: string; target: unknown; }[]` | yes |
| `representations` | `{ markdown?: string \| undefined; summary?: string \| undefined; plaintext?: string \| undefined; } \| undefined` | no |
| `schemaVersion` | `string` | yes |
| `scope` | `{ level: string; ids?: Record<string, string> \| undefined; }` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `artifact` | `{ kind: string; id: string; revision: string; scope: { level: string; ids?: Record<string, string> \| undefined; }; schemaVersion: string; data: Record<string, unknown>; relations: { type: string; target: { refClass: "artifact"; kind: string; id: string; revision: string; } \| { refClass: "local"; artifact: { refClass: "artifact"; kind: string; id: string; revision: string; }; localId: string; } \| { refClass: "evidence"; kind: string; id: string; revision?: string \| undefined; locator?: string \| undefined; }; }[]; actor: { kind: string; id: string; displayName?: string \| undefined; }; timestamp: number; confidence?: { level: "assumed" \| "inferred" \| "stated" \| "confirmed" \| "verified"; basis: { kind: string; actor: { kind: string; id: string; displayName?: string \| undefined; }; timestamp: number; detail?: string \| undefined; evidenceRef?: { refClass: "artifact"; kind: string; id: string; revision: string; } \| { refClass: "local"; artifact: { refClass: "artifact"; kind: string; id: string; revision: string; }; localId: string; } \| { refClass: "evidence"; kind: string; id: string; revision?: string \| undefined; locator?: string \| undefined; } \| undefined; }[]; } \| undefined; representations?: { markdown?: string \| undefined; summary?: string \| undefined; plaintext?: string \| undefined; } \| undefined; createdAt?: number \| undefined; }` | yes |

### <a id="artifact.created"></a>`artifact.created` (event)

Emitted when a new artifact is created.

Subject: `artifact.created`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `artifact` | `{ kind: string; id: string; revision: string; scope: { level: string; ids?: Record<string, string> \| undefined; }; schemaVersion: string; data: Record<string, unknown>; relations: { type: string; target: unknown; }[]; actor: { kind: string; id: string; displayName?: string \| undefined; }; timestamp: number; confidence?: { level: "assumed" \| "inferred" \| "stated" \| "confirmed" \| "verified"; basis: { kind: string; actor: { kind: string; id: string; displayName?: string \| undefined; }; timestamp: number; detail?: string \| undefined; evidenceRef?: unknown; }[]; } \| undefined; representations?: { markdown?: string \| undefined; summary?: string \| undefined; plaintext?: string \| undefined; } \| undefined; createdAt?: number \| undefined; }` | yes |

### <a id="artifact.kind.changed"></a>`artifact.kind.changed` (event)

Emitted when an artifact kind registration is added or updated.

Subject: `artifact.kind.changed`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `kind` | `string` | yes |
| `schemaVersion` | `string` | yes |

### <a id="artifact.kind.list"></a>`artifact.kind.list` (rpc)

List registered artifact kinds, optionally filtered by kind string (RPC).

Subject: `artifact.kind.list`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `kind` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `kinds` | `{ kind: string; description: string; schemaVersion: string; dataSchema: Record<string, unknown>; conflictPolicy: "supersedes" \| "manual" \| "coexist"; scopeSchema?: Record<string, unknown> \| undefined; observationSchema?: Record<string, unknown> \| undefined; discriminator?: string \| string[] \| undefined; status?: { path: string; values?: string[] \| undefined; } \| undefined; lifecycle?: { defaultRelevance?: "active" \| "fading" \| "retired" \| "archived" \| undefined; decayPolicy?: string \| undefined; } \| undefined; indexedFields?: string[] \| undefined; searchableFields?: string[] \| undefined; projection?: { mode: "none" \| "surface" \| "comment"; defaultRole?: "workpiece" \| "artifact" \| undefined; semanticEvents?: ("created" \| "revised" \| "status-changed" \| "observation-added")[] \| undefined; projectedFields?: { path: string; semantic?: "status" \| "workflow" \| "priority" \| undefined; }[] \| undefined; } \| undefined; defaultContext?: Readonly<Record<string, ArtifactContextRelationSelector>> \| undefined; }[]` | yes |

### <a id="artifact.kind.register"></a>`artifact.kind.register` (rpc)

Register a new artifact kind with the artifact service (RPC).

Subject: `artifact.kind.register`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `conflictPolicy` | `"supersedes" \| "manual" \| "coexist"` | yes |
| `dataSchema` | `Record<string, unknown>` | yes |
| `defaultContext` | `Readonly<Record<string, ArtifactContextRelationSelector>> \| undefined` | no |
| `description` | `string` | yes |
| `discriminator` | `string \| string[] \| undefined` | no |
| `indexedFields` | `string[] \| undefined` | no |
| `kind` | `string` | yes |
| `lifecycle` | `{ defaultRelevance?: "active" \| "fading" \| "retired" \| "archived" \| undefined; decayPolicy?: string \| undefined; } \| undefined` | no |
| `observationSchema` | `Record<string, unknown> \| undefined` | no |
| `projection` | `{ mode: "none" \| "surface" \| "comment"; defaultRole?: "workpiece" \| "artifact" \| undefined; semanticEvents?: ("created" \| "revised" \| "status-changed" \| "observation-added")[] \| undefined; projectedFields?: { path: string; semantic?: "status" \| "workflow" \| "priority" \| undefined; }[] \| undefined; } \| undefined` | no |
| `schemaVersion` | `string` | yes |
| `scopeSchema` | `Record<string, unknown> \| undefined` | no |
| `searchableFields` | `string[] \| undefined` | no |
| `status` | `{ path: string; values?: string[] \| undefined; } \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `registered` | `boolean` | yes |

### <a id="artifact.observation.added"></a>`artifact.observation.added` (event)

Emitted when an observation is added to an artifact revision.

Subject: `artifact.observation.added`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `artifact` | `{ kind: string; id: string; revision: string; refClass?: "artifact" \| undefined; }` | yes |
| `observation` | `{ id: string; kind: string; summary: string; actor: { kind: string; id: string; displayName?: string \| undefined; }; timestamp: number; detail?: string \| undefined; severity?: "info" \| "warning" \| "blocker" \| undefined; tags?: string[] \| undefined; regarding?: { kind: string; id: string; revision: string; refClass?: "artifact" \| undefined; } \| { artifact: { kind: string; id: string; revision: string; refClass?: "artifact" \| undefined; }; localId: string; refClass?: "local" \| undefined; } \| undefined; evidence?: { kind: string; id: string; revision: string; refClass?: "artifact" \| undefined; } \| { kind: string; id: string; refClass?: "evidence" \| undefined; revision?: string \| undefined; locator?: string \| undefined; } \| undefined; }` | yes |

### <a id="artifact.query"></a>`artifact.query` (rpc)

Query artifact revisions using structured filter criteria (RPC).

Subject: `artifact.query`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `confidence` | `{ maxLevel?: "assumed" \| "inferred" \| "stated" \| "confirmed" \| "verified" \| undefined; minLevel?: "assumed" \| "inferred" \| "stated" \| "confirmed" \| "verified" \| undefined; } \| undefined` | no |
| `currentOnly` | `boolean \| undefined` | no |
| `ids` | `string[] \| undefined` | no |
| `indexed` | `Record<string, unknown> \| undefined` | no |
| `kind` | `string \| undefined` | no |
| `limit` | `number \| undefined` | no |
| `relation` | `{ type?: string \| undefined; target?: unknown; } \| undefined` | no |
| `scope` | `{ level: string; ids?: Record<string, string> \| undefined; } \| undefined` | no |
| `search` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `artifacts` | `{ kind: string; id: string; revision: string; scope: { level: string; ids?: Record<string, string> \| undefined; }; schemaVersion: string; data: Record<string, unknown>; relations: { type: string; target: { refClass: "artifact"; kind: string; id: string; revision: string; } \| { refClass: "local"; artifact: { refClass: "artifact"; kind: string; id: string; revision: string; }; localId: string; } \| { refClass: "evidence"; kind: string; id: string; revision?: string \| undefined; locator?: string \| undefined; }; }[]; actor: { kind: string; id: string; displayName?: string \| undefined; }; timestamp: number; confidence?: { level: "assumed" \| "inferred" \| "stated" \| "confirmed" \| "verified"; basis: { kind: string; actor: { kind: string; id: string; displayName?: string \| undefined; }; timestamp: number; detail?: string \| undefined; evidenceRef?: { refClass: "artifact"; kind: string; id: string; revision: string; } \| { refClass: "local"; artifact: { refClass: "artifact"; kind: string; id: string; revision: string; }; localId: string; } \| { refClass: "evidence"; kind: string; id: string; revision?: string \| undefined; locator?: string \| undefined; } \| undefined; }[]; } \| undefined; representations?: { markdown?: string \| undefined; summary?: string \| undefined; plaintext?: string \| undefined; } \| undefined; createdAt?: number \| undefined; }[]` | yes |

### <a id="artifact.relation-type.list"></a>`artifact.relation-type.list` (rpc)

List registered relation types, optionally filtered by type string (RPC).

Subject: `artifact.relation-type.list`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `type` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `relationTypes` | `{ type: string; symmetry: "asymmetric" \| "symmetric"; implication?: string \| undefined; sourceKinds?: string[] \| undefined; targetKinds?: string[] \| undefined; targetRefClasses?: ("artifact" \| "local" \| "evidence")[] \| undefined; }[]` | yes |

### <a id="artifact.relation-type.register"></a>`artifact.relation-type.register` (rpc)

Register a new relation type with the artifact service (RPC).

Subject: `artifact.relation-type.register`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `implication` | `string \| undefined` | no |
| `sourceKinds` | `string[] \| undefined` | no |
| `symmetry` | `"asymmetric" \| "symmetric"` | yes |
| `targetKinds` | `string[] \| undefined` | no |
| `targetRefClasses` | `("artifact" \| "local" \| "evidence")[] \| undefined` | no |
| `type` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `registered` | `boolean` | yes |

### <a id="artifact.relation.added"></a>`artifact.relation.added` (event)

Emitted when a relation is added to an artifact revision.

Subject: `artifact.relation.added`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `artifact` | `{ kind: string; id: string; revision: string; refClass?: "artifact" \| undefined; }` | yes |
| `relation` | `{ type: string; target: unknown; }` | yes |

### <a id="artifact.resolve"></a>`artifact.resolve` (rpc)

Resolve a specific artifact revision by reference (RPC).

Subject: `artifact.resolve`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `ref` | `{ kind: string; id: string; revision: string; refClass?: "artifact" \| undefined; }` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `artifact` | `{ kind: string; id: string; revision: string; scope: { level: string; ids?: Record<string, string> \| undefined; }; schemaVersion: string; data: Record<string, unknown>; relations: { type: string; target: { refClass: "artifact"; kind: string; id: string; revision: string; } \| { refClass: "local"; artifact: { refClass: "artifact"; kind: string; id: string; revision: string; }; localId: string; } \| { refClass: "evidence"; kind: string; id: string; revision?: string \| undefined; locator?: string \| undefined; }; }[]; actor: { kind: string; id: string; displayName?: string \| undefined; }; timestamp: number; confidence?: { level: "assumed" \| "inferred" \| "stated" \| "confirmed" \| "verified"; basis: { kind: string; actor: { kind: string; id: string; displayName?: string \| undefined; }; timestamp: number; detail?: string \| undefined; evidenceRef?: { refClass: "artifact"; kind: string; id: string; revision: string; } \| { refClass: "local"; artifact: { refClass: "artifact"; kind: string; id: string; revision: string; }; localId: string; } \| { refClass: "evidence"; kind: string; id: string; revision?: string \| undefined; locator?: string \| undefined; } \| undefined; }[]; } \| undefined; representations?: { markdown?: string \| undefined; summary?: string \| undefined; plaintext?: string \| undefined; } \| undefined; createdAt?: number \| undefined; } \| null` | yes |

### <a id="artifact.resolveContext"></a>`artifact.resolveContext` (rpc)

Resolve a selector-driven outbound artifact context graph (RPC).

Subject: `artifact.resolveContext`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `maxDepth` | `number \| undefined` | no |
| `ref` | `{ kind: string; id: string; revision: string; refClass?: "artifact" \| undefined; }` | yes |
| `selectors` | `Readonly<Record<string, ArtifactContextRelationSelector>> \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `context` | `{ rootRef: { refClass: "artifact"; kind: string; id: string; revision: string; }; refs: { target: { refClass: "artifact"; kind: string; id: string; revision: string; } \| { refClass: "local"; artifact: { refClass: "artifact"; kind: string; id: string; revision: string; }; localId: string; } \| { refClass: "evidence"; kind: string; id: string; revision?: string \| undefined; locator?: string \| undefined; }; sourceRef: { refClass: "artifact"; kind: string; id: string; revision: string; }; relationType: string; hint: string; status: "resolved" \| "unresolved"; reason?: "not-selected" \| "not-found" \| "depth-exceeded" \| "unsupported-ref-class" \| "cycle-detected" \| undefined; }[]; resolved: { kind: string; id: string; revision: string; scope: { level: string; ids?: Record<string, string> \| undefined; }; schemaVersion: string; data: Record<string, unknown>; relations: { type: string; target: { refClass: "artifact"; kind: string; id: string; revision: string; } \| { refClass: "local"; artifact: { refClass: "artifact"; kind: string; id: string; revision: string; }; localId: string; } \| { refClass: "evidence"; kind: string; id: string; revision?: string \| undefined; locator?: string \| undefined; }; }[]; actor: { kind: string; id: string; displayName?: string \| undefined; }; timestamp: number; confidence?: { level: "assumed" \| "inferred" \| "stated" \| "confirmed" \| "verified"; basis: { kind: string; actor: { kind: string; id: string; displayName?: string \| undefined; }; timestamp: number; detail?: string \| undefined; evidenceRef?: { refClass: "artifact"; kind: string; id: string; revision: string; } \| { refClass: "local"; artifact: { refClass: "artifact"; kind: string; id: string; revision: string; }; localId: string; } \| { refClass: "evidence"; kind: string; id: string; revision?: string \| undefined; locator?: string \| undefined; } \| undefined; }[]; } \| undefined; representations?: { markdown?: string \| undefined; summary?: string \| undefined; plaintext?: string \| undefined; } \| undefined; createdAt?: number \| undefined; }[]; }` | yes |

### <a id="artifact.revise"></a>`artifact.revise` (rpc)

Create a new revision of an existing artifact (RPC).

Subject: `artifact.revise`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `previous` | `{ kind: string; id: string; revision: string; refClass?: "artifact" \| undefined; }` | yes |
| `revision` | `{ kind: string; schemaVersion: string; scope: { level: string; ids?: Record<string, string> \| undefined; }; data: Record<string, unknown>; actor: { kind: string; id: string; displayName?: string \| undefined; }; relations: { type: string; target: unknown; }[]; confidence?: { level: "assumed" \| "inferred" \| "stated" \| "confirmed" \| "verified"; basis: { kind: string; actor: { kind: string; id: string; displayName?: string \| undefined; }; timestamp: number; detail?: string \| undefined; evidenceRef?: unknown; }[]; } \| undefined; representations?: { markdown?: string \| undefined; summary?: string \| undefined; plaintext?: string \| undefined; } \| undefined; createdAt?: number \| undefined; }` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `artifact` | `{ kind: string; id: string; revision: string; scope: { level: string; ids?: Record<string, string> \| undefined; }; schemaVersion: string; data: Record<string, unknown>; relations: { type: string; target: { refClass: "artifact"; kind: string; id: string; revision: string; } \| { refClass: "local"; artifact: { refClass: "artifact"; kind: string; id: string; revision: string; }; localId: string; } \| { refClass: "evidence"; kind: string; id: string; revision?: string \| undefined; locator?: string \| undefined; }; }[]; actor: { kind: string; id: string; displayName?: string \| undefined; }; timestamp: number; confidence?: { level: "assumed" \| "inferred" \| "stated" \| "confirmed" \| "verified"; basis: { kind: string; actor: { kind: string; id: string; displayName?: string \| undefined; }; timestamp: number; detail?: string \| undefined; evidenceRef?: { refClass: "artifact"; kind: string; id: string; revision: string; } \| { refClass: "local"; artifact: { refClass: "artifact"; kind: string; id: string; revision: string; }; localId: string; } \| { refClass: "evidence"; kind: string; id: string; revision?: string \| undefined; locator?: string \| undefined; } \| undefined; }[]; } \| undefined; representations?: { markdown?: string \| undefined; summary?: string \| undefined; plaintext?: string \| undefined; } \| undefined; createdAt?: number \| undefined; }` | yes |

### <a id="artifact.revised"></a>`artifact.revised` (event)

Emitted when an existing artifact receives a new revision.

Subject: `artifact.revised`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `artifact` | `{ kind: string; id: string; revision: string; scope: { level: string; ids?: Record<string, string> \| undefined; }; schemaVersion: string; data: Record<string, unknown>; relations: { type: string; target: unknown; }[]; actor: { kind: string; id: string; displayName?: string \| undefined; }; timestamp: number; confidence?: { level: "assumed" \| "inferred" \| "stated" \| "confirmed" \| "verified"; basis: { kind: string; actor: { kind: string; id: string; displayName?: string \| undefined; }; timestamp: number; detail?: string \| undefined; evidenceRef?: unknown; }[]; } \| undefined; representations?: { markdown?: string \| undefined; summary?: string \| undefined; plaintext?: string \| undefined; } \| undefined; createdAt?: number \| undefined; }` | yes |
| `previous` | `{ kind: string; id: string; revision: string; refClass?: "artifact" \| undefined; }` | yes |

### <a id="artifact.status.changed"></a>`artifact.status.changed` (event)

Emitted when a tracked status field changes on an artifact revision.

Subject: `artifact.status.changed`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `artifact` | `{ kind: string; id: string; revision: string; refClass?: "artifact" \| undefined; }` | yes |
| `current` | `unknown` | no |
| `path` | `string` | yes |
| `previous` | `unknown` | no |

---

*Auto-generated by `yarn docs:bus`. Do not edit manually.*
