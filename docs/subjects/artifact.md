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
| `evidence.resolve` | [`artifact.evidence.resolve`](#artifact.evidence.resolve) | rpc | — |
| `kind.changed` | [`artifact.kind.changed`](#artifact.kind.changed) | event | — |
| `kind.list` | [`artifact.kind.list`](#artifact.kind.list) | rpc | — |
| `kind.register` | [`artifact.kind.register`](#artifact.kind.register) | rpc | — |
| `lifecycle.committed` | [`artifact.lifecycle.committed`](#artifact.lifecycle.committed) | event | [`lifecycle-namespace.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/artifact/lifecycle-namespace.ts) |
| `lifecycle.get` | [`artifact.lifecycle.get`](#artifact.lifecycle.get) | rpc | [`lifecycle-namespace.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/artifact/lifecycle-namespace.ts) |
| `lifecycle.history` | [`artifact.lifecycle.history`](#artifact.lifecycle.history) | rpc | [`lifecycle-namespace.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/artifact/lifecycle-namespace.ts) |
| `lifecycle.rejected` | [`artifact.lifecycle.rejected`](#artifact.lifecycle.rejected) | event | [`lifecycle-namespace.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/artifact/lifecycle-namespace.ts) |
| `lifecycle.transition` | [`artifact.lifecycle.transition`](#artifact.lifecycle.transition) | rpc | [`lifecycle-namespace.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/artifact/lifecycle-namespace.ts) |
| `observation.added` | [`artifact.observation.added`](#artifact.observation.added) | event | — |
| `patch` | [`artifact.patch`](#artifact.patch) | rpc | — |
| `query` | [`artifact.query`](#artifact.query) | rpc | — |
| `relation-type.list` | [`artifact.relation-type.list`](#artifact.relation-type.list) | rpc | — |
| `relation-type.register` | [`artifact.relation-type.register`](#artifact.relation-type.register) | rpc | — |
| `relation.added` | [`artifact.relation.added`](#artifact.relation.added) | event | — |
| `resolve` | [`artifact.resolve`](#artifact.resolve) | rpc | — |
| `resolveContext` | [`artifact.resolveContext`](#artifact.resolveContext) | rpc | — |
| `resolvePart` | [`artifact.resolvePart`](#artifact.resolvePart) | rpc | — |
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
| `base` | `{ refClass: "artifact"; kind: string; id: string; revision: string; }` | yes |
| `target` | `{ refClass: "artifact"; kind: string; id: string; revision: string; }` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `base` | `{ kind: string; id: string; revision: string; scope: { level: string; ids?: Record<string, string> \| undefined; }; schemaVersion: number; data: Record<string, unknown>; relations: { type: string; target: { refClass: "artifact"; kind: string; id: string; revision: string; } \| { refClass: "local"; artifact: { refClass: "artifact"; kind: string; id: string; revision: string; }; localId: string; } \| { refClass: "evidence"; kind: string; id: string; revision?: string \| undefined; locator?: string \| undefined; } \| { refClass: "entity"; entityType: string; id: string; }; sourceLocalId?: string \| undefined; }[]; actor: { kind: string; id: string; displayName?: string \| undefined; }; timestamp: number; evidence?: ({ source: { kind: "git-file"; repository: { kind: string; path: string; }; path: string; commit: string; }; location: { kind: "whole-source"; } \| { kind: "lines"; startLine: number; lineCount: number; }; excerpt?: string \| undefined; } \| { source: { kind: "confluence-page"; site: string; pageId: string; version: number; }; location: { kind: "whole-source"; }; excerpt?: string \| undefined; } \| { source: { kind: "artifact"; reference: { refClass: "artifact"; kind: string; id: string; revision: string; }; }; location: { kind: "whole-source"; } \| { kind: "data-path"; path: string; }; excerpt?: string \| undefined; })[] \| undefined; confidence?: { level: "assumed" \| "inferred" \| "stated" \| "confirmed" \| "verified"; basis: { kind: string; actor: { kind: string; id: string; displayName?: string \| undefined; }; timestamp: number; detail?: string \| undefined; evidenceRef?: { refClass: "artifact"; kind: string; id: string; revision: string; } \| { refClass: "local"; artifact: { refClass: "artifact"; kind: string; id: string; revision: string; }; localId: string; } \| { refClass: "evidence"; kind: string; id: string; revision?: string \| undefined; locator?: string \| undefined; } \| { refClass: "entity"; entityType: string; id: string; } \| undefined; }[]; } \| undefined; representations?: { markdown?: string \| undefined; summary?: string \| undefined; plaintext?: string \| undefined; } \| undefined; createdAt?: number \| undefined; }` | yes |
| `changedPaths` | `string[]` | yes |
| `target` | `{ kind: string; id: string; revision: string; scope: { level: string; ids?: Record<string, string> \| undefined; }; schemaVersion: number; data: Record<string, unknown>; relations: { type: string; target: { refClass: "artifact"; kind: string; id: string; revision: string; } \| { refClass: "local"; artifact: { refClass: "artifact"; kind: string; id: string; revision: string; }; localId: string; } \| { refClass: "evidence"; kind: string; id: string; revision?: string \| undefined; locator?: string \| undefined; } \| { refClass: "entity"; entityType: string; id: string; }; sourceLocalId?: string \| undefined; }[]; actor: { kind: string; id: string; displayName?: string \| undefined; }; timestamp: number; evidence?: ({ source: { kind: "git-file"; repository: { kind: string; path: string; }; path: string; commit: string; }; location: { kind: "whole-source"; } \| { kind: "lines"; startLine: number; lineCount: number; }; excerpt?: string \| undefined; } \| { source: { kind: "confluence-page"; site: string; pageId: string; version: number; }; location: { kind: "whole-source"; }; excerpt?: string \| undefined; } \| { source: { kind: "artifact"; reference: { refClass: "artifact"; kind: string; id: string; revision: string; }; }; location: { kind: "whole-source"; } \| { kind: "data-path"; path: string; }; excerpt?: string \| undefined; })[] \| undefined; confidence?: { level: "assumed" \| "inferred" \| "stated" \| "confirmed" \| "verified"; basis: { kind: string; actor: { kind: string; id: string; displayName?: string \| undefined; }; timestamp: number; detail?: string \| undefined; evidenceRef?: { refClass: "artifact"; kind: string; id: string; revision: string; } \| { refClass: "local"; artifact: { refClass: "artifact"; kind: string; id: string; revision: string; }; localId: string; } \| { refClass: "evidence"; kind: string; id: string; revision?: string \| undefined; locator?: string \| undefined; } \| { refClass: "entity"; entityType: string; id: string; } \| undefined; }[]; } \| undefined; representations?: { markdown?: string \| undefined; summary?: string \| undefined; plaintext?: string \| undefined; } \| undefined; createdAt?: number \| undefined; }` | yes |

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
| `evidence` | `({ source: { kind: "git-file"; repository: { kind: string; path: string; }; path: string; commit: string; }; location: { kind: "whole-source"; } \| { kind: "lines"; startLine: number; lineCount: number; }; excerpt?: string \| undefined; } \| { source: { kind: "confluence-page"; site: string; pageId: string; version: number; }; location: { kind: "whole-source"; }; excerpt?: string \| undefined; } \| { source: { kind: "artifact"; reference: { refClass: "artifact"; kind: string; id: string; revision: string; }; }; location: { kind: "whole-source"; } \| { kind: "data-path"; path: string; }; excerpt?: string \| undefined; })[] \| undefined` | no |
| `id` | `string \| undefined` | no |
| `kind` | `string` | yes |
| `relations` | `{ type: string; target: unknown; sourceLocalId?: string \| undefined; }[]` | yes |
| `representations` | `{ markdown?: string \| undefined; summary?: string \| undefined; plaintext?: string \| undefined; } \| undefined` | no |
| `schemaVersion` | `number` | yes |
| `scope` | `{ level: string; ids?: Record<string, string> \| undefined; }` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `artifact` | `{ kind: string; id: string; revision: string; scope: { level: string; ids?: Record<string, string> \| undefined; }; schemaVersion: number; data: Record<string, unknown>; relations: { type: string; target: { refClass: "artifact"; kind: string; id: string; revision: string; } \| { refClass: "local"; artifact: { refClass: "artifact"; kind: string; id: string; revision: string; }; localId: string; } \| { refClass: "evidence"; kind: string; id: string; revision?: string \| undefined; locator?: string \| undefined; } \| { refClass: "entity"; entityType: string; id: string; }; sourceLocalId?: string \| undefined; }[]; actor: { kind: string; id: string; displayName?: string \| undefined; }; timestamp: number; evidence?: ({ source: { kind: "git-file"; repository: { kind: string; path: string; }; path: string; commit: string; }; location: { kind: "whole-source"; } \| { kind: "lines"; startLine: number; lineCount: number; }; excerpt?: string \| undefined; } \| { source: { kind: "confluence-page"; site: string; pageId: string; version: number; }; location: { kind: "whole-source"; }; excerpt?: string \| undefined; } \| { source: { kind: "artifact"; reference: { refClass: "artifact"; kind: string; id: string; revision: string; }; }; location: { kind: "whole-source"; } \| { kind: "data-path"; path: string; }; excerpt?: string \| undefined; })[] \| undefined; confidence?: { level: "assumed" \| "inferred" \| "stated" \| "confirmed" \| "verified"; basis: { kind: string; actor: { kind: string; id: string; displayName?: string \| undefined; }; timestamp: number; detail?: string \| undefined; evidenceRef?: { refClass: "artifact"; kind: string; id: string; revision: string; } \| { refClass: "local"; artifact: { refClass: "artifact"; kind: string; id: string; revision: string; }; localId: string; } \| { refClass: "evidence"; kind: string; id: string; revision?: string \| undefined; locator?: string \| undefined; } \| { refClass: "entity"; entityType: string; id: string; } \| undefined; }[]; } \| undefined; representations?: { markdown?: string \| undefined; summary?: string \| undefined; plaintext?: string \| undefined; } \| undefined; createdAt?: number \| undefined; }` | yes |

### <a id="artifact.created"></a>`artifact.created` (event)

Emitted when a new artifact is created.

Subject: `artifact.created`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `artifact` | `{ kind: string; id: string; revision: string; scope: { level: string; ids?: Record<string, string> \| undefined; }; schemaVersion: number; data: Record<string, unknown>; relations: { type: string; target: unknown; sourceLocalId?: string \| undefined; }[]; actor: { kind: string; id: string; displayName?: string \| undefined; }; timestamp: number; evidence?: ({ source: { kind: "git-file"; repository: { kind: string; path: string; }; path: string; commit: string; }; location: { kind: "whole-source"; } \| { kind: "lines"; startLine: number; lineCount: number; }; excerpt?: string \| undefined; } \| { source: { kind: "confluence-page"; site: string; pageId: string; version: number; }; location: { kind: "whole-source"; }; excerpt?: string \| undefined; } \| { source: { kind: "artifact"; reference: { refClass: "artifact"; kind: string; id: string; revision: string; }; }; location: { kind: "whole-source"; } \| { kind: "data-path"; path: string; }; excerpt?: string \| undefined; })[] \| undefined; confidence?: { level: "assumed" \| "inferred" \| "stated" \| "confirmed" \| "verified"; basis: { kind: string; actor: { kind: string; id: string; displayName?: string \| undefined; }; timestamp: number; detail?: string \| undefined; evidenceRef?: unknown; }[]; } \| undefined; representations?: { markdown?: string \| undefined; summary?: string \| undefined; plaintext?: string \| undefined; } \| undefined; createdAt?: number \| undefined; }` | yes |

### <a id="artifact.evidence.resolve"></a>`artifact.evidence.resolve` (rpc)

Resolve one immutable evidence pointer to its complete content (RPC).

Subject: `artifact.evidence.resolve`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `evidence` | `{ source: { kind: "git-file"; repository: { kind: string; path: string; }; path: string; commit: string; }; location: { kind: "whole-source"; } \| { kind: "lines"; startLine: number; lineCount: number; }; excerpt?: string \| undefined; } \| { source: { kind: "confluence-page"; site: string; pageId: string; version: number; }; location: { kind: "whole-source"; }; excerpt?: string \| undefined; } \| { source: { kind: "artifact"; reference: { refClass: "artifact"; kind: string; id: string; revision: string; }; }; location: { kind: "whole-source"; } \| { kind: "data-path"; path: string; }; excerpt?: string \| undefined; }` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `content` | `{ kind: "text"; text: string; }` | yes |
| `location` | `{ kind: "whole-source"; } \| { kind: "lines"; startLine: number; lineCount: number; } \| { kind: "data-path"; path: string; }` | yes |
| `source` | `{ kind: "git-file"; repository: { kind: string; path: string; }; path: string; commit: string; } \| { kind: "confluence-page"; site: string; pageId: string; version: number; } \| { kind: "artifact"; reference: { refClass: "artifact"; kind: string; id: string; revision: string; }; }` | yes |

### <a id="artifact.kind.changed"></a>`artifact.kind.changed` (event)

Emitted when an artifact kind registration is added or updated.

Subject: `artifact.kind.changed`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `kind` | `string` | yes |
| `schemaVersion` | `number` | yes |

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
| `kinds` | `{ kind: string; description: string; schemaVersion: number; category: "record" \| "knowledge" \| "commitment" \| "interaction"; dataSchema: Record<string, unknown>; titlePath: string; relations?: { relationType: string; minItems: number; targetKinds?: string[] \| undefined; maxItems?: number \| undefined; }[] \| undefined; uniqueness?: { by: ({ kind: "data"; path: string; } \| { kind: "relation-target"; relationType: string; })[]; lifecycleStates?: ("valid" \| "retired" \| "proposed" \| "decided" \| "fulfilled" \| "revoked" \| "open" \| "resolved" \| "closed-without-resolution")[] \| undefined; }[] \| undefined; evidenceRequirements?: { minItems: number; } \| undefined; indexedFields?: string[] \| undefined; searchableFields?: string[] \| undefined; addressableParts?: { path: string; idPath: string; }[] \| undefined; views?: Record<string, { fields: string[]; }> \| undefined; }[]` | yes |

### <a id="artifact.kind.register"></a>`artifact.kind.register` (rpc)

Register a new artifact kind with the artifact service (RPC).

Subject: `artifact.kind.register`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `addressableParts` | `{ path: string; idPath: string; }[] \| undefined` | no |
| `category` | `"record" \| "knowledge" \| "commitment" \| "interaction"` | yes |
| `dataSchema` | `Record<string, unknown>` | yes |
| `description` | `string` | yes |
| `evidenceRequirements` | `{ minItems: number; } \| undefined` | no |
| `indexedFields` | `string[] \| undefined` | no |
| `kind` | `string` | yes |
| `relations` | `{ relationType: string; minItems: number; targetKinds?: string[] \| undefined; maxItems?: number \| undefined; }[] \| undefined` | no |
| `schemaVersion` | `number` | yes |
| `searchableFields` | `string[] \| undefined` | no |
| `titlePath` | `string` | yes |
| `uniqueness` | `{ by: ({ kind: "data"; path: string; } \| { kind: "relation-target"; relationType: string; })[]; lifecycleStates?: ("valid" \| "retired" \| "proposed" \| "decided" \| "fulfilled" \| "revoked" \| "open" \| "resolved" \| "closed-without-resolution")[] \| undefined; }[] \| undefined` | no |
| `views` | `Record<string, { fields: string[]; }> \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `registered` | `boolean` | yes |

### <a id="artifact.lifecycle.committed"></a>`artifact.lifecycle.committed` (event)

Committed events are emitted after persistence; creation uses the existing created event.
The immutable entry is the authoritative result, so the event does not duplicate intent.

Subject: `artifact.lifecycle.committed`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `entry` | `{ operation: "transitioned"; previousState: "valid" \| "retired" \| "proposed" \| "decided" \| "fulfilled" \| "revoked" \| "open" \| "resolved" \| "closed-without-resolution"; situation: { kind: "revision-assessment"; assessedRevision: string; source?: { kind: string; ref: string; } \| undefined; } \| { kind: "handover"; source: { kind: string; ref: string; }; }; artifact: { kind: string; id: string; }; lifecycle: { category: "knowledge"; state: "valid" \| "retired"; version: number; } \| { category: "commitment"; state: "proposed" \| "decided" \| "fulfilled" \| "revoked"; version: number; } \| { category: "interaction"; state: "open" \| "resolved" \| "closed-without-resolution"; version: number; }; actor: { kind: string; id: string; displayName?: string \| undefined; }; timestamp: number; observedRevision: string; reason?: string \| undefined; }` | yes |

### <a id="artifact.lifecycle.get"></a>`artifact.lifecycle.get` (rpc)

Subject: `artifact.lifecycle.get`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `artifact` | `{ kind: string; id: string; }` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `lifecycle` | `{ category: "knowledge"; state: "valid" \| "retired"; version: number; } \| { category: "commitment"; state: "proposed" \| "decided" \| "fulfilled" \| "revoked"; version: number; } \| { category: "interaction"; state: "open" \| "resolved" \| "closed-without-resolution"; version: number; } \| { category: "record"; }` | yes |

### <a id="artifact.lifecycle.history"></a>`artifact.lifecycle.history` (rpc)

Subject: `artifact.lifecycle.history`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `afterVersion` | `number \| undefined` | no |
| `artifact` | `{ kind: string; id: string; }` | yes |
| `limit` | `number \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `entries` | `({ operation: "initialized"; artifact: { kind: string; id: string; }; lifecycle: { category: "knowledge"; state: "valid" \| "retired"; version: number; } \| { category: "commitment"; state: "proposed" \| "decided" \| "fulfilled" \| "revoked"; version: number; } \| { category: "interaction"; state: "open" \| "resolved" \| "closed-without-resolution"; version: number; }; actor: { kind: string; id: string; displayName?: string \| undefined; }; timestamp: number; observedRevision: string; } \| { operation: "transitioned"; previousState: "valid" \| "retired" \| "proposed" \| "decided" \| "fulfilled" \| "revoked" \| "open" \| "resolved" \| "closed-without-resolution"; situation: { kind: "revision-assessment"; assessedRevision: string; source?: { kind: string; ref: string; } \| undefined; } \| { kind: "handover"; source: { kind: string; ref: string; }; }; artifact: { kind: string; id: string; }; lifecycle: { category: "knowledge"; state: "valid" \| "retired"; version: number; } \| { category: "commitment"; state: "proposed" \| "decided" \| "fulfilled" \| "revoked"; version: number; } \| { category: "interaction"; state: "open" \| "resolved" \| "closed-without-resolution"; version: number; }; actor: { kind: string; id: string; displayName?: string \| undefined; }; timestamp: number; observedRevision: string; reason?: string \| undefined; })[]` | yes |
| `nextCursor` | `number \| undefined` | no |

### <a id="artifact.lifecycle.rejected"></a>`artifact.lifecycle.rejected` (event)

Supplemental event for a rejected valid transition request. It does not replace
immediate RPC failure. Hosts add trusted repository/correlation context through
subject extensions; domain-specific messages and reactions remain host-owned.

Subject: `artifact.lifecycle.rejected`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `error` | `{ code: "artifact-lifecycle-rejected"; message: string; data: { reason: "lifecycle-version-conflict"; expectedVersion: number; current: { category: "knowledge"; state: "valid" \| "retired"; version: number; } \| { category: "commitment"; state: "proposed" \| "decided" \| "fulfilled" \| "revoked"; version: number; } \| { category: "interaction"; state: "open" \| "resolved" \| "closed-without-resolution"; version: number; }; requestedState: "valid" \| "retired" \| "proposed" \| "decided" \| "fulfilled" \| "revoked" \| "open" \| "resolved" \| "closed-without-resolution"; } \| { reason: "content-basis-conflict"; assessedRevision: string; currentRevision: string; } \| { reason: "invalid-transition"; current: { category: "knowledge"; state: "valid" \| "retired"; version: number; } \| { category: "commitment"; state: "proposed" \| "decided" \| "fulfilled" \| "revoked"; version: number; } \| { category: "interaction"; state: "open" \| "resolved" \| "closed-without-resolution"; version: number; } \| { category: "record"; }; requestedState: "valid" \| "retired" \| "proposed" \| "decided" \| "fulfilled" \| "revoked" \| "open" \| "resolved" \| "closed-without-resolution"; } \| { reason: "precondition-failed"; current: { category: "knowledge"; state: "valid" \| "retired"; version: number; } \| { category: "commitment"; state: "proposed" \| "decided" \| "fulfilled" \| "revoked"; version: number; } \| { category: "interaction"; state: "open" \| "resolved" \| "closed-without-resolution"; version: number; }; requestedState: "valid" \| "retired" \| "proposed" \| "decided" \| "fulfilled" \| "revoked" \| "open" \| "resolved" \| "closed-without-resolution"; }; }` | yes |
| `transition` | `{ artifact: { kind: string; id: string; }; expectedVersion: number; state: "valid" \| "retired" \| "proposed" \| "decided" \| "fulfilled" \| "revoked" \| "open" \| "resolved" \| "closed-without-resolution"; situation: { kind: "revision-assessment"; assessedRevision: string; source?: { kind: string; ref: string; } \| undefined; } \| { kind: "handover"; source: { kind: string; ref: string; }; }; reason?: string \| undefined; }` | yes |

### <a id="artifact.lifecycle.transition"></a>`artifact.lifecycle.transition` (rpc)

Subject: `artifact.lifecycle.transition`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `artifact` | `{ kind: string; id: string; }` | yes |
| `expectedVersion` | `number` | yes |
| `reason` | `string \| undefined` | no |
| `situation` | `{ kind: "revision-assessment"; assessedRevision: string; source?: { kind: string; ref: string; } \| undefined; } \| { kind: "handover"; source: { kind: string; ref: string; }; }` | yes |
| `state` | `"valid" \| "retired" \| "proposed" \| "decided" \| "fulfilled" \| "revoked" \| "open" \| "resolved" \| "closed-without-resolution"` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `entry` | `{ operation: "transitioned"; previousState: "valid" \| "retired" \| "proposed" \| "decided" \| "fulfilled" \| "revoked" \| "open" \| "resolved" \| "closed-without-resolution"; situation: { kind: "revision-assessment"; assessedRevision: string; source?: { kind: string; ref: string; } \| undefined; } \| { kind: "handover"; source: { kind: string; ref: string; }; }; artifact: { kind: string; id: string; }; lifecycle: { category: "knowledge"; state: "valid" \| "retired"; version: number; } \| { category: "commitment"; state: "proposed" \| "decided" \| "fulfilled" \| "revoked"; version: number; } \| { category: "interaction"; state: "open" \| "resolved" \| "closed-without-resolution"; version: number; }; actor: { kind: string; id: string; displayName?: string \| undefined; }; timestamp: number; observedRevision: string; reason?: string \| undefined; }` | yes |

### <a id="artifact.observation.added"></a>`artifact.observation.added` (event)

Emitted when an observation is added to an artifact revision.

Subject: `artifact.observation.added`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `artifact` | `{ refClass: "artifact"; kind: string; id: string; revision: string; }` | yes |
| `observation` | `{ id: string; kind: string; summary: string; actor: { kind: string; id: string; displayName?: string \| undefined; }; timestamp: number; detail?: string \| undefined; severity?: "info" \| "warning" \| "blocker" \| undefined; tags?: string[] \| undefined; regarding?: { refClass: "artifact"; kind: string; id: string; revision: string; } \| { artifact: { refClass: "artifact"; kind: string; id: string; revision: string; }; localId: string; refClass?: "local" \| undefined; } \| undefined; evidence?: { refClass: "artifact"; kind: string; id: string; revision: string; } \| { kind: string; id: string; refClass?: "evidence" \| undefined; revision?: string \| undefined; locator?: string \| undefined; } \| undefined; }` | yes |

### <a id="artifact.patch"></a>`artifact.patch` (rpc)

Revise an existing artifact by patching the revision named by `baseRevision` (RPC).

The request carries the change rather than the payload, so its cost follows
the size of the change. Rejections are returned in band with the failing
path and a repair hint; a stale `baseRevision` reports the current revision
along with the repair the caller must follow — only an append at a fixed
path can be resent without re-reading the payload.

Subject: `artifact.patch`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `baseRevision` | `string` | yes |
| `dryRun` | `boolean \| undefined` | no |
| `patch` | `{ $set?: Record<string, JsonValue> \| undefined; $unset?: Record<string, true> \| undefined; $push?: Record<string, JsonValue> \| undefined; $pull?: Record<string, JsonValue> \| undefined; arrayFilters?: Record<string, JsonValue>[] \| undefined; }` | yes |
| `ref` | `{ kind: string; id: string; }` | yes |
| `representations` | `{ markdown?: string \| undefined; summary?: string \| undefined; plaintext?: string \| undefined; } \| null \| undefined` | no |
| `schemaVersion` | `number \| undefined` | no |
| `statusPath` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `artifact` | `{ refClass: "artifact"; kind: string; id: string; revision: string; } \| undefined` | no |
| `base` | `{ refClass: "artifact"; kind: string; id: string; revision: string; } \| undefined` | no |
| `dryRun` | `true \| false \| undefined` | no |
| `error` | `{ code: "ARTIFACT_NOT_FOUND" \| "BASE_REVISION_CONFLICT" \| "KIND_NOT_REGISTERED" \| "SCHEMA_VERSION_MISMATCH" \| "PATH_NOT_DECLARED" \| "PATH_NOT_RESOLVABLE" \| "TARGET_NOT_A_COLLECTION" \| "UNSUPPORTED_TARGET" \| "NO_MATCH" \| "SCHEMA_VALIDATION_FAILED" \| "PAYLOAD_INVARIANT_FAILED" \| "NO_CHANGE" \| "STORE_REJECTED" \| "HOST_FAILED"; message: string; repair: string; operator?: "$set" \| "$unset" \| "$push" \| "$pull" \| undefined; path?: string \| undefined; currentRevision?: string \| undefined; issues?: { path: string; reason: string; expectedType?: string \| undefined; allowedValues?: JsonValue[] \| undefined; }[] \| undefined; } \| undefined` | no |
| `migration` | `{ from: number; to: number; } \| undefined` | no |
| `ok` | `true \| false` | yes |
| `operations` | `{ operator: "$set" \| "$unset" \| "$push" \| "$pull"; path: string; matched: number; }[] \| undefined` | no |

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
| `indexed` | `Record<string, JsonValue> \| undefined` | no |
| `kind` | `string \| undefined` | no |
| `limit` | `number \| undefined` | no |
| `relation` | `{ type?: string \| undefined; target?: unknown; } \| undefined` | no |
| `scope` | `{ level: string; ids?: Record<string, string> \| undefined; } \| undefined` | no |
| `search` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `artifacts` | `{ kind: string; id: string; revision: string; scope: { level: string; ids?: Record<string, string> \| undefined; }; schemaVersion: number; data: Record<string, unknown>; relations: { type: string; target: { refClass: "artifact"; kind: string; id: string; revision: string; } \| { refClass: "local"; artifact: { refClass: "artifact"; kind: string; id: string; revision: string; }; localId: string; } \| { refClass: "evidence"; kind: string; id: string; revision?: string \| undefined; locator?: string \| undefined; } \| { refClass: "entity"; entityType: string; id: string; }; sourceLocalId?: string \| undefined; }[]; actor: { kind: string; id: string; displayName?: string \| undefined; }; timestamp: number; evidence?: ({ source: { kind: "git-file"; repository: { kind: string; path: string; }; path: string; commit: string; }; location: { kind: "whole-source"; } \| { kind: "lines"; startLine: number; lineCount: number; }; excerpt?: string \| undefined; } \| { source: { kind: "confluence-page"; site: string; pageId: string; version: number; }; location: { kind: "whole-source"; }; excerpt?: string \| undefined; } \| { source: { kind: "artifact"; reference: { refClass: "artifact"; kind: string; id: string; revision: string; }; }; location: { kind: "whole-source"; } \| { kind: "data-path"; path: string; }; excerpt?: string \| undefined; })[] \| undefined; confidence?: { level: "assumed" \| "inferred" \| "stated" \| "confirmed" \| "verified"; basis: { kind: string; actor: { kind: string; id: string; displayName?: string \| undefined; }; timestamp: number; detail?: string \| undefined; evidenceRef?: { refClass: "artifact"; kind: string; id: string; revision: string; } \| { refClass: "local"; artifact: { refClass: "artifact"; kind: string; id: string; revision: string; }; localId: string; } \| { refClass: "evidence"; kind: string; id: string; revision?: string \| undefined; locator?: string \| undefined; } \| { refClass: "entity"; entityType: string; id: string; } \| undefined; }[]; } \| undefined; representations?: { markdown?: string \| undefined; summary?: string \| undefined; plaintext?: string \| undefined; } \| undefined; createdAt?: number \| undefined; }[]` | yes |

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
| `relationTypes` | `{ type: string; symmetry: "asymmetric" \| "symmetric"; implication?: string \| undefined; sourceKinds?: string[] \| undefined; targetKinds?: string[] \| undefined; targetRefClasses?: ("artifact" \| "local" \| "evidence" \| "entity")[] \| undefined; }[]` | yes |

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
| `targetRefClasses` | `("artifact" \| "local" \| "evidence" \| "entity")[] \| undefined` | no |
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
| `artifact` | `{ refClass: "artifact"; kind: string; id: string; revision: string; }` | yes |
| `relation` | `{ type: string; target: unknown; sourceLocalId?: string \| undefined; }` | yes |

### <a id="artifact.resolve"></a>`artifact.resolve` (rpc)

Resolve a specific artifact revision by reference (RPC).

Subject: `artifact.resolve`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `ref` | `{ refClass: "artifact"; kind: string; id: string; revision: string; }` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `artifact` | `{ kind: string; id: string; revision: string; scope: { level: string; ids?: Record<string, string> \| undefined; }; schemaVersion: number; data: Record<string, unknown>; relations: { type: string; target: { refClass: "artifact"; kind: string; id: string; revision: string; } \| { refClass: "local"; artifact: { refClass: "artifact"; kind: string; id: string; revision: string; }; localId: string; } \| { refClass: "evidence"; kind: string; id: string; revision?: string \| undefined; locator?: string \| undefined; } \| { refClass: "entity"; entityType: string; id: string; }; sourceLocalId?: string \| undefined; }[]; actor: { kind: string; id: string; displayName?: string \| undefined; }; timestamp: number; evidence?: ({ source: { kind: "git-file"; repository: { kind: string; path: string; }; path: string; commit: string; }; location: { kind: "whole-source"; } \| { kind: "lines"; startLine: number; lineCount: number; }; excerpt?: string \| undefined; } \| { source: { kind: "confluence-page"; site: string; pageId: string; version: number; }; location: { kind: "whole-source"; }; excerpt?: string \| undefined; } \| { source: { kind: "artifact"; reference: { refClass: "artifact"; kind: string; id: string; revision: string; }; }; location: { kind: "whole-source"; } \| { kind: "data-path"; path: string; }; excerpt?: string \| undefined; })[] \| undefined; confidence?: { level: "assumed" \| "inferred" \| "stated" \| "confirmed" \| "verified"; basis: { kind: string; actor: { kind: string; id: string; displayName?: string \| undefined; }; timestamp: number; detail?: string \| undefined; evidenceRef?: { refClass: "artifact"; kind: string; id: string; revision: string; } \| { refClass: "local"; artifact: { refClass: "artifact"; kind: string; id: string; revision: string; }; localId: string; } \| { refClass: "evidence"; kind: string; id: string; revision?: string \| undefined; locator?: string \| undefined; } \| { refClass: "entity"; entityType: string; id: string; } \| undefined; }[]; } \| undefined; representations?: { markdown?: string \| undefined; summary?: string \| undefined; plaintext?: string \| undefined; } \| undefined; createdAt?: number \| undefined; } \| null` | yes |

### <a id="artifact.resolveContext"></a>`artifact.resolveContext` (rpc)

Resolve a selector-driven outbound artifact context graph (RPC).

Subject: `artifact.resolveContext`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `maxDepth` | `number \| undefined` | no |
| `ref` | `{ refClass: "artifact"; kind: string; id: string; revision: string; }` | yes |
| `selectors` | `Readonly<Record<string, ArtifactContextRelationSelector>> \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `context` | `{ rootRef: { refClass: "artifact"; kind: string; id: string; revision: string; }; refs: { target: { refClass: "artifact"; kind: string; id: string; revision: string; } \| { refClass: "local"; artifact: { refClass: "artifact"; kind: string; id: string; revision: string; }; localId: string; } \| { refClass: "evidence"; kind: string; id: string; revision?: string \| undefined; locator?: string \| undefined; } \| { refClass: "entity"; entityType: string; id: string; }; sourceRef: { refClass: "artifact"; kind: string; id: string; revision: string; }; relationType: string; hint: string; status: "resolved" \| "unresolved"; sourceLocalId?: string \| undefined; reason?: "not-selected" \| "not-found" \| "depth-exceeded" \| "unsupported-ref-class" \| "cycle-detected" \| undefined; }[]; resolved: { kind: string; id: string; revision: string; scope: { level: string; ids?: Record<string, string> \| undefined; }; schemaVersion: number; data: Record<string, unknown>; relations: { type: string; target: { refClass: "artifact"; kind: string; id: string; revision: string; } \| { refClass: "local"; artifact: { refClass: "artifact"; kind: string; id: string; revision: string; }; localId: string; } \| { refClass: "evidence"; kind: string; id: string; revision?: string \| undefined; locator?: string \| undefined; } \| { refClass: "entity"; entityType: string; id: string; }; sourceLocalId?: string \| undefined; }[]; actor: { kind: string; id: string; displayName?: string \| undefined; }; timestamp: number; evidence?: ({ source: { kind: "git-file"; repository: { kind: string; path: string; }; path: string; commit: string; }; location: { kind: "whole-source"; } \| { kind: "lines"; startLine: number; lineCount: number; }; excerpt?: string \| undefined; } \| { source: { kind: "confluence-page"; site: string; pageId: string; version: number; }; location: { kind: "whole-source"; }; excerpt?: string \| undefined; } \| { source: { kind: "artifact"; reference: { refClass: "artifact"; kind: string; id: string; revision: string; }; }; location: { kind: "whole-source"; } \| { kind: "data-path"; path: string; }; excerpt?: string \| undefined; })[] \| undefined; confidence?: { level: "assumed" \| "inferred" \| "stated" \| "confirmed" \| "verified"; basis: { kind: string; actor: { kind: string; id: string; displayName?: string \| undefined; }; timestamp: number; detail?: string \| undefined; evidenceRef?: { refClass: "artifact"; kind: string; id: string; revision: string; } \| { refClass: "local"; artifact: { refClass: "artifact"; kind: string; id: string; revision: string; }; localId: string; } \| { refClass: "evidence"; kind: string; id: string; revision?: string \| undefined; locator?: string \| undefined; } \| { refClass: "entity"; entityType: string; id: string; } \| undefined; }[]; } \| undefined; representations?: { markdown?: string \| undefined; summary?: string \| undefined; plaintext?: string \| undefined; } \| undefined; createdAt?: number \| undefined; }[]; }` | yes |

### <a id="artifact.resolvePart"></a>`artifact.resolvePart` (rpc)

Resolve one addressable part from exactly the pinned artifact revision (RPC).

The request names the part through the existing local reference; the handler
reads the pinned revision and the kind declaration effective on its bus
context. Outcomes are returned in band so the repair hint survives facades.

Subject: `artifact.resolvePart`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `ref` | `{ artifact: { refClass: "artifact"; kind: string; id: string; revision: string; }; localId: string; refClass?: "local" \| undefined; }` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `areaPath` | `string \| undefined` | no |
| `error` | `{ code: "ARTIFACT_NOT_FOUND" \| "KIND_NOT_REGISTERED" \| "NO_PARTS_DECLARED" \| "PART_NOT_FOUND" \| "DUPLICATE_LOCAL_ID"; message: string; repair: string; } \| undefined` | no |
| `ok` | `true \| false` | yes |
| `part` | `Record<string, unknown> \| undefined` | no |
| `ref` | `{ refClass: "local"; artifact: { refClass: "artifact"; kind: string; id: string; revision: string; }; localId: string; } \| undefined` | no |

### <a id="artifact.revise"></a>`artifact.revise` (rpc)

Create a new revision of an existing artifact (RPC).

Subject: `artifact.revise`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `previous` | `{ refClass: "artifact"; kind: string; id: string; revision: string; }` | yes |
| `revision` | `{ kind: string; actor: { kind: string; id: string; displayName?: string \| undefined; }; data: Record<string, unknown>; schemaVersion: number; relations: { type: string; target: unknown; sourceLocalId?: string \| undefined; }[]; scope: { level: string; ids?: Record<string, string> \| undefined; }; evidence?: ({ source: { kind: "git-file"; repository: { kind: string; path: string; }; path: string; commit: string; }; location: { kind: "whole-source"; } \| { kind: "lines"; startLine: number; lineCount: number; }; excerpt?: string \| undefined; } \| { source: { kind: "confluence-page"; site: string; pageId: string; version: number; }; location: { kind: "whole-source"; }; excerpt?: string \| undefined; } \| { source: { kind: "artifact"; reference: { refClass: "artifact"; kind: string; id: string; revision: string; }; }; location: { kind: "whole-source"; } \| { kind: "data-path"; path: string; }; excerpt?: string \| undefined; })[] \| undefined; confidence?: { level: "assumed" \| "inferred" \| "stated" \| "confirmed" \| "verified"; basis: { kind: string; actor: { kind: string; id: string; displayName?: string \| undefined; }; timestamp: number; detail?: string \| undefined; evidenceRef?: unknown; }[]; } \| undefined; representations?: { markdown?: string \| undefined; summary?: string \| undefined; plaintext?: string \| undefined; } \| undefined; createdAt?: number \| undefined; }` | yes |
| `statusPath` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `artifact` | `{ kind: string; id: string; revision: string; scope: { level: string; ids?: Record<string, string> \| undefined; }; schemaVersion: number; data: Record<string, unknown>; relations: { type: string; target: { refClass: "artifact"; kind: string; id: string; revision: string; } \| { refClass: "local"; artifact: { refClass: "artifact"; kind: string; id: string; revision: string; }; localId: string; } \| { refClass: "evidence"; kind: string; id: string; revision?: string \| undefined; locator?: string \| undefined; } \| { refClass: "entity"; entityType: string; id: string; }; sourceLocalId?: string \| undefined; }[]; actor: { kind: string; id: string; displayName?: string \| undefined; }; timestamp: number; evidence?: ({ source: { kind: "git-file"; repository: { kind: string; path: string; }; path: string; commit: string; }; location: { kind: "whole-source"; } \| { kind: "lines"; startLine: number; lineCount: number; }; excerpt?: string \| undefined; } \| { source: { kind: "confluence-page"; site: string; pageId: string; version: number; }; location: { kind: "whole-source"; }; excerpt?: string \| undefined; } \| { source: { kind: "artifact"; reference: { refClass: "artifact"; kind: string; id: string; revision: string; }; }; location: { kind: "whole-source"; } \| { kind: "data-path"; path: string; }; excerpt?: string \| undefined; })[] \| undefined; confidence?: { level: "assumed" \| "inferred" \| "stated" \| "confirmed" \| "verified"; basis: { kind: string; actor: { kind: string; id: string; displayName?: string \| undefined; }; timestamp: number; detail?: string \| undefined; evidenceRef?: { refClass: "artifact"; kind: string; id: string; revision: string; } \| { refClass: "local"; artifact: { refClass: "artifact"; kind: string; id: string; revision: string; }; localId: string; } \| { refClass: "evidence"; kind: string; id: string; revision?: string \| undefined; locator?: string \| undefined; } \| { refClass: "entity"; entityType: string; id: string; } \| undefined; }[]; } \| undefined; representations?: { markdown?: string \| undefined; summary?: string \| undefined; plaintext?: string \| undefined; } \| undefined; createdAt?: number \| undefined; }` | yes |

### <a id="artifact.revised"></a>`artifact.revised` (event)

Emitted when an existing artifact receives a new revision.

Subject: `artifact.revised`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `artifact` | `{ kind: string; id: string; revision: string; scope: { level: string; ids?: Record<string, string> \| undefined; }; schemaVersion: number; data: Record<string, unknown>; relations: { type: string; target: unknown; sourceLocalId?: string \| undefined; }[]; actor: { kind: string; id: string; displayName?: string \| undefined; }; timestamp: number; evidence?: ({ source: { kind: "git-file"; repository: { kind: string; path: string; }; path: string; commit: string; }; location: { kind: "whole-source"; } \| { kind: "lines"; startLine: number; lineCount: number; }; excerpt?: string \| undefined; } \| { source: { kind: "confluence-page"; site: string; pageId: string; version: number; }; location: { kind: "whole-source"; }; excerpt?: string \| undefined; } \| { source: { kind: "artifact"; reference: { refClass: "artifact"; kind: string; id: string; revision: string; }; }; location: { kind: "whole-source"; } \| { kind: "data-path"; path: string; }; excerpt?: string \| undefined; })[] \| undefined; confidence?: { level: "assumed" \| "inferred" \| "stated" \| "confirmed" \| "verified"; basis: { kind: string; actor: { kind: string; id: string; displayName?: string \| undefined; }; timestamp: number; detail?: string \| undefined; evidenceRef?: unknown; }[]; } \| undefined; representations?: { markdown?: string \| undefined; summary?: string \| undefined; plaintext?: string \| undefined; } \| undefined; createdAt?: number \| undefined; }` | yes |
| `previous` | `{ refClass: "artifact"; kind: string; id: string; revision: string; }` | yes |

### <a id="artifact.status.changed"></a>`artifact.status.changed` (event)

Emitted when a tracked status field changes on an artifact revision.

Subject: `artifact.status.changed`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `artifact` | `{ refClass: "artifact"; kind: string; id: string; revision: string; }` | yes |
| `current` | `unknown` | no |
| `path` | `string` | yes |
| `previous` | `unknown` | no |

---

*Auto-generated by `yarn docs:bus`. Do not edit manually.*
