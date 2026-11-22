---
title: "makaio:journal"
editUrl: false
prev: false
next: false
---

# `makaio:journal`

| Field | Value |
|-------|-------|
| Prefix | `makaio:journal` |
| Namespace constant | `JournalNamespace` |
| Subjects constant | `JournalSubjects` |
| Kind | bus |
| Schema record | `JournalSchemas` |
| Tier | framework |
| Package | `@makaio/contracts` |
| Defined in | [`core/contracts/src/journal/namespace.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/journal/namespace.ts) |

## Subjects

| Key | Wire | Type | Schema |
|-----|------|------|--------|
| `entries` | [`makaio:journal.entries`](#makaio:journal.entries) | rpc | — |
| `reader-states` | [`makaio:journal.reader-states`](#makaio:journal.reader-states) | rpc | — |
| `reprocess` | [`makaio:journal.reprocess`](#makaio:journal.reprocess) | rpc | — |
| `resolve-write` | [`makaio:journal.resolve-write`](#makaio:journal.resolve-write) | rpc | — |
| `writes` | [`makaio:journal.writes`](#makaio:journal.writes) | rpc | — |

## Subject Details

### <a id="makaio:journal.entries"></a>`makaio:journal.entries` (rpc)

Subject: `makaio:journal.entries`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `cursor` | `string \| undefined` | no |
| `entryId` | `string \| undefined` | no |
| `from` | `number \| undefined` | no |
| `limit` | `number \| undefined` | no |
| `subject` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `entries` | `{ entryId: string; position: number; subject: string; payload: JsonValue; schemaVersion: string; key: string; origin: { caller: { kind: string; id: string; claims?: Record<string, CallClaim> \| undefined; }; principal: { kind: string; id: string; claims?: Record<string, CallClaim> \| undefined; }; extension: string; attestedBy?: { kind: string; id: string; claims?: Record<string, CallClaim> \| undefined; } \| undefined; edge?: string \| undefined; witnessed?: { extension: string; site: string; accountId: string; display?: string \| undefined; } \| undefined; }; recordedAt: string; orderKey?: string \| undefined; }[]` | yes |
| `nextCursor` | `string \| undefined` | no |

### <a id="makaio:journal.reader-states"></a>`makaio:journal.reader-states` (rpc)

Subject: `makaio:journal.reader-states`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `cursor` | `string \| undefined` | no |
| `entryId` | `string \| undefined` | no |
| `limit` | `number \| undefined` | no |
| `reader` | `string` | yes |
| `since` | `number \| undefined` | no |
| `state` | `"open" \| "failed" \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `nextCursor` | `string \| undefined` | no |
| `states` | `{ entryId: string; position: number; state: "open" \| "failed" \| "done"; retries: number; reason?: string \| undefined; notBefore?: string \| undefined; }[]` | yes |

### <a id="makaio:journal.reprocess"></a>`makaio:journal.reprocess` (rpc)

Subject: `makaio:journal.reprocess`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `entryId` | `string` | yes |
| `reader` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `code` | `"not-found" \| "not-failed" \| undefined` | no |
| `status` | `"requeued" \| undefined` | no |
| `success` | `true \| false` | yes |

### <a id="makaio:journal.resolve-write"></a>`makaio:journal.resolve-write` (rpc)

Subject: `makaio:journal.resolve-write`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `resolution` | `{ found: ExternalObjectRef; } \| { notWritten: true; }` | yes |
| `writeRecordId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `code` | `"not-found" \| "not-unresolved" \| "participant-unavailable" \| undefined` | no |
| `record` | `{ writeRecordId: string; key: string; writer: string; state: "resolved" \| "unresolved" \| "released" \| "intended" \| "written" \| "not-written"; object: ExternalObjectRef \| null; parent: ExternalObjectRef \| null; intentId: string \| null; checksum: string \| null; appliedOrder: number \| null; intendedSince: string \| null; ctx: { caller: { kind: string; id: string; claims?: Record<string, CallClaim> \| undefined; }; principal: { kind: string; id: string; claims?: Record<string, CallClaim> \| undefined; }; attestedBy?: { kind: string; id: string; claims?: Record<string, CallClaim> \| undefined; } \| undefined; }; } \| undefined` | no |
| `success` | `true \| false` | yes |

### <a id="makaio:journal.writes"></a>`makaio:journal.writes` (rpc)

Subject: `makaio:journal.writes`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `byKey` | `{ writer: string; key: string; } \| undefined` | no |
| `byObject` | `ExternalObjectRef \| undefined` | no |
| `cursor` | `string \| undefined` | no |
| `limit` | `number \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `nextCursor` | `string \| undefined` | no |
| `writes` | `{ writeRecordId: string; key: string; writer: string; state: "resolved" \| "unresolved" \| "released" \| "intended" \| "written" \| "not-written"; object: ExternalObjectRef \| null; parent: ExternalObjectRef \| null; intentId: string \| null; checksum: string \| null; appliedOrder: number \| null; intendedSince: string \| null; ctx: { caller: { kind: string; id: string; claims?: Record<string, CallClaim> \| undefined; }; principal: { kind: string; id: string; claims?: Record<string, CallClaim> \| undefined; }; attestedBy?: { kind: string; id: string; claims?: Record<string, CallClaim> \| undefined; } \| undefined; }; }[]` | yes |

---

*Auto-generated by `yarn docs:bus`. Do not edit manually.*
