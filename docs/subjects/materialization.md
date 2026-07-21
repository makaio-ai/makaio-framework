---
title: "materialization"
editUrl: false
prev: false
next: false
---

# `materialization`

| Field | Value |
|-------|-------|
| Prefix | `materialization` |
| Namespace constant | `MaterializationNamespace` |
| Subjects constant | `MaterializationSubjects` |
| Kind | bus |
| Schema record | `MaterializationSchemas` |
| Tier | framework |
| Package | `@makaio/contracts` |
| Defined in | [`core/contracts/src/materialization/namespace.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/materialization/namespace.ts) |

## Subjects

| Key | Wire | Type | Schema |
|-----|------|------|--------|
| `artifact.view.resolve` | [`materialization.artifact.view.resolve`](#materialization.artifact.view.resolve) | rpc | — |
| `capability.resolved` | [`materialization.capability.resolved`](#materialization.capability.resolved) | event | — |
| `ref.changed` | [`materialization.ref.changed`](#materialization.ref.changed) | event | — |
| `surfaceBinding.changed` | [`materialization.surfaceBinding.changed`](#materialization.surfaceBinding.changed) | event | — |
| `surfaceBinding.list` | [`materialization.surfaceBinding.list`](#materialization.surfaceBinding.list) | rpc | — |
| `surfaceBinding.register` | [`materialization.surfaceBinding.register`](#materialization.surfaceBinding.register) | rpc | — |

## Subject Details

### <a id="materialization.artifact.view.resolve"></a>`materialization.artifact.view.resolve` (rpc)

Resolve an artifact view through an affordance (RPC).

Returns one of three closed response shapes: `ok` with the rendered view,
its builder version, and exact source revision; `artifact-not-found`; or
`not-rendered`.

Subject: `materialization.artifact.view.resolve`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `affordance` | `{ kind: "own-view"; } \| { kind: "inline"; hostRelation: string; } \| { kind: "entry"; via?: string \| undefined; collection?: string \| undefined; }` | yes |
| `level` | `"link" \| "summary" \| "full"` | yes |
| `params` | `Record<string, unknown> \| undefined` | no |
| `ref` | `{ kind: string; id: string; revision: string; refClass?: "artifact" \| undefined; }` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `builderVersion` | `number \| undefined` | no |
| `sourceRevision` | `string \| undefined` | no |
| `status` | `"ok" \| "artifact-not-found" \| "not-rendered"` | yes |
| `view` | `{ title: string; artifact: { id: string; kind: string; revision: string; status?: string \| undefined; }; navigation: { breadcrumbs: { label: string; artifactId?: string \| undefined; url?: string \| undefined; }[]; related: { label: string; artifactId?: string \| undefined; url?: string \| undefined; }[]; }; sections: ({ type: "summary"; title: string; text: string; } \| { type: "properties"; title: string; rows: { label: string; value: string; }[]; } \| { type: "table"; title: string; columns: string[]; rows: { cells: string[]; link?: { label: string; artifactId?: string \| undefined; url?: string \| undefined; } \| undefined; }[]; } \| { type: "relations"; title: string; groups: { type: string; items: { label: string; artifactId?: string \| undefined; url?: string \| undefined; }[]; }[]; } \| { type: "evidence"; title: string; items: { kind: string; id: string; locator?: string \| undefined; }[]; } \| { type: "raw"; title: string; json: JsonValue; } \| { type: "code"; title: string; language: string; content: string; } \| { type: "diagram"; title: string; notation: "mermaid"; source: string; })[]; links: { dashboard?: string \| undefined; materialized?: string \| undefined; }; } \| null` | yes |

### <a id="materialization.capability.resolved"></a>`materialization.capability.resolved` (event)

Emitted when a provider surface capability set has been resolved.

Subject: `materialization.capability.resolved`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `capabilities` | `Record<string, boolean>` | yes |
| `degraded` | `boolean` | yes |
| `provider` | `string` | yes |
| `surface` | `string` | yes |

### <a id="materialization.ref.changed"></a>`materialization.ref.changed` (event)

Emitted when a provider materialization ref is upserted or deleted.

Subject: `materialization.ref.changed`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `artifactId` | `string` | yes |
| `externalId` | `string` | yes |
| `operation` | `"deleted" \| "upserted"` | yes |
| `origin` | `"external" \| "factory" \| undefined` | no |
| `provider` | `string` | yes |

### <a id="materialization.surfaceBinding.changed"></a>`materialization.surfaceBinding.changed` (event)

Emitted when a surface binding registration is added.

Subject: `materialization.surfaceBinding.changed`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `id` | `string` | yes |
| `provider` | `string` | yes |

### <a id="materialization.surfaceBinding.list"></a>`materialization.surfaceBinding.list` (rpc)

List registered surface bindings, optionally filtered by id, provider, or namespace (RPC).

Subject: `materialization.surfaceBinding.list`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `id` | `string \| undefined` | no |
| `namespace` | `string \| undefined` | no |
| `provider` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `bindings` | `{ id: string; provider: string; namespace: string; target: { kind: "label"; prefix?: string \| undefined; } \| { kind: "field"; name: string; fieldId?: string \| undefined; } \| { kind: "issue-type"; name: string; typeId?: string \| undefined; } \| { kind: "body-fragment"; slot: string; } \| { kind: "comment"; template: string; }; appliesTo: ("surface" \| "workpiece" \| "artifact")[]; valueMapping?: Record<string, string> \| undefined; description?: string \| undefined; params?: Record<string, unknown> \| undefined; }[]` | yes |

### <a id="materialization.surfaceBinding.register"></a>`materialization.surfaceBinding.register` (rpc)

Register a surface binding with the surface binding registry (RPC).
Returns `{ registered: true }` when successfully stored.

Subject: `materialization.surfaceBinding.register`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `appliesTo` | `("surface" \| "workpiece" \| "artifact")[]` | yes |
| `description` | `string \| undefined` | no |
| `id` | `string` | yes |
| `namespace` | `string` | yes |
| `params` | `Record<string, unknown> \| undefined` | no |
| `provider` | `string` | yes |
| `target` | `{ kind: "label"; prefix?: string \| undefined; } \| { kind: "field"; name: string; fieldId?: string \| undefined; } \| { kind: "issue-type"; name: string; typeId?: string \| undefined; } \| { kind: "body-fragment"; slot: string; } \| { kind: "comment"; template: string; }` | yes |
| `valueMapping` | `Record<string, string> \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `registered` | `boolean` | yes |

---

*Auto-generated by `yarn docs:bus`. Do not edit manually.*
