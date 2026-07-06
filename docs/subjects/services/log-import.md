---
title: "log-import"
editUrl: false
prev: false
next: false
---

# `log-import`

| Field | Value |
|-------|-------|
| Prefix | `log-import` |
| Namespace constant | `LogImportNamespace` |
| Subjects constant | `LogImportSubjects` |
| Kind | bus |
| Schema record | `LogImportSchemas` |
| Tier | framework |
| Package | `@makaio/services-log-import` |
| Defined in | [`services/log-import/src/namespace.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/log-import/src/namespace.ts) |

## Subjects

| Key | Wire | Type | Schema |
|-----|------|------|--------|
| `confirmation.request` | [`log-import.confirmation.request`](#log-import.confirmation.request) | rpc | [`confirmation.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/log-import/src/schemas/confirmation.ts) |
| `confirmation.response` | [`log-import.confirmation.response`](#log-import.confirmation.response) | rpc | [`confirmation.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/log-import/src/schemas/confirmation.ts) |
| `getMode` | [`log-import.getMode`](#log-import.getMode) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/log-import/src/schemas.ts) |
| `getStats` | [`log-import.getStats`](#log-import.getStats) | rpc | [`stats.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/log-import/src/schemas/stats.ts) |
| `importAll` | [`log-import.importAll`](#log-import.importAll) | rpc | [`stats.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/log-import/src/schemas/stats.ts) |
| `importFile` | [`log-import.importFile`](#log-import.importFile) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/log-import/src/schemas.ts) |
| `importSession` | [`log-import.importSession`](#log-import.importSession) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/log-import/src/schemas.ts) |
| `listImporters` | [`log-import.listImporters`](#log-import.listImporters) | rpc | [`list-importers.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/log-import/src/schemas/list-importers.ts) |
| `listSettings` | [`log-import.listSettings`](#log-import.listSettings) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/log-import/src/schemas.ts) |
| `progress` | [`log-import.progress`](#log-import.progress) | rpc | [`stats.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/log-import/src/schemas/stats.ts) |
| `scan` | [`log-import.scan`](#log-import.scan) | rpc | [`stats.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/log-import/src/schemas/stats.ts) |
| `setMode` | [`log-import.setMode`](#log-import.setMode) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/log-import/src/schemas.ts) |
| `uploadFiles` | [`log-import.uploadFiles`](#log-import.uploadFiles) | rpc | [`upload.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/log-import/src/schemas/upload.ts) |

## Subject Details

### <a id="log-import.confirmation.request"></a>`log-import.confirmation.request` (rpc)

Request user confirmation via UI.
UI renders a modal, user clicks option, response is sent back.

Subject: `log-import.confirmation.request`
Type: Request (RPC)
Purpose: Requests user confirmation for actions like conflict resolution.

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `confirmationId` | `string` | yes |
| `message` | `string` | yes |
| `options` | `{ id: string; label: string; variant?: "primary" \| "secondary" \| "danger" \| undefined; }[]` | yes |
| `title` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `confirmationId` | `string` | yes |
| `received` | `boolean` | yes |

### <a id="log-import.confirmation.response"></a>`log-import.confirmation.response` (rpc)

User response to a log import confirmation dialog.

Subject: `log-import.confirmation.response`
Type: Request (RPC)
Purpose: Sends the user's selection back to the requester.

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `confirmationId` | `string` | yes |
| `selectedOptionId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `acknowledged` | `boolean` | yes |

### <a id="log-import.getMode"></a>`log-import.getMode` (rpc)

Resolve the effective global import mode for a given adapter.

Subject: `log-import.getMode`
Type: Request (RPC)
Purpose: Returns the effective global import mode for the requested adapter.

Hosts that need scoped resolution can register a higher-priority handler
that falls through to this global default with `ctx.next()`.

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterName` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `mode` | `"disabled" \| "discover" \| "import"` | yes |

### <a id="log-import.getStats"></a>`log-import.getStats` (rpc)

Request log import stats from an adapter.

Subject: `log-import.getStats`
Type: Request (RPC)
Purpose: Returns import statistics for a specific adapter including
         session counts and last scan timestamp.

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterName` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `adapterName` | `string` | yes |
| `lastScanAt` | `string \| null` | yes |
| `sessionsFound` | `number` | yes |
| `sessionsImported` | `number` | yes |
| `supportsImport` | `boolean` | yes |

### <a id="log-import.importAll"></a>`log-import.importAll` (rpc)

Import all unimported sessions from an adapter.

Subject: `log-import.importAll`
Type: Request (RPC)
Purpose: Imports all sessions that haven't been imported yet.

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterName` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `adapterName` | `string` | yes |
| `errors` | `number` | yes |
| `imported` | `number` | yes |
| `skipped` | `number` | yes |

### <a id="log-import.importFile"></a>`log-import.importFile` (rpc)

Import a transcript file by path, addressable without prior discovery.

Subject: `log-import.importFile`
Type: Request (RPC)
Purpose: Parses the given transcript file with the named importer and
persists the resulting segment tree (messages + turns).

**Graceful-absence contract:** unlike `importSession`, this subject NEVER
throws for a missing importer registration — framework-only hosts (no
product importers contributed) receive a `skipped` status with reason
`no-importer`. It is addressable by file path directly (no prior
discovery stub required) and performs a full re-parse from byte 0,
relying on message/turn idempotency (import cursors do not persist parser
state across restarts). Concurrent calls for the same `filePath` are
serialized by the handler.

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterName` | `string` | yes |
| `filePath` | `string` | yes |
| `ingestionMarker` | `"live" \| "backfill" \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `messageCount` | `number \| undefined` | no |
| `reason` | `string \| undefined` | no |
| `sessionId` | `string \| undefined` | no |
| `status` | `"imported" \| "skipped"` | yes |
| `turnCount` | `number \| undefined` | no |

### <a id="log-import.importSession"></a>`log-import.importSession` (rpc)

Lazy-load a single discovered session — fetch its full message history on demand.

Subject: `log-import.importSession`
Type: Request (RPC)
Purpose: Imports one discovered adapter session into Makaio on demand.

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterName` | `string` | yes |
| `adapterSessionId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `messageCount` | `number` | yes |
| `sessionId` | `string` | yes |

### <a id="log-import.listImporters"></a>`log-import.listImporters` (rpc)

List all registered log importers.

Subject: `log-import.listImporters`
Type: Request (RPC)
Purpose: Returns information about all registered importers (adapters + extensions).

**Request:**

_Empty object._

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `importers` | `{ id: string; adapterName: string; displayName: string; source: "adapter" \| "extension"; logFilePattern: string; isRunning: boolean; supportsManualImport: boolean; clientId?: string \| undefined; }[]` | yes |

### <a id="log-import.listSettings"></a>`log-import.listSettings` (rpc)

List all persisted import settings rows.

Subject: `log-import.listSettings`
Type: Request (RPC)
Purpose: Returns every persisted global log-import settings row.

**Request:**

_Empty object._

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `settings` | `{ adapterName: string; mode: "disabled" \| "discover" \| "import"; createdAt: number; updatedAt: number; }[]` | yes |

### <a id="log-import.progress"></a>`log-import.progress` (rpc)

Log import progress event (emitted during long imports).

Subject: `log-import.progress`
Type: Request (RPC - for acknowledgment pattern)
Purpose: Notifies UI about import progress.

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterName` | `string` | yes |
| `current` | `number` | yes |
| `currentFile` | `string \| undefined` | no |
| `total` | `number` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `received` | `boolean` | yes |

### <a id="log-import.scan"></a>`log-import.scan` (rpc)

Trigger a scan of adapter's log directory.

Subject: `log-import.scan`
Type: Request (RPC)
Purpose: Scans the adapter's log directory for new sessions.

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterName` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `adapterName` | `string` | yes |
| `newSessions` | `number` | yes |
| `sessionsFound` | `number` | yes |

### <a id="log-import.setMode"></a>`log-import.setMode` (rpc)

Set the global import mode for an adapter.

Subject: `log-import.setMode`
Type: Request (RPC)
Purpose: Persists the global import mode for the requested adapter.

Hosts that need scoped writes can register a higher-priority handler
that falls through to this global default with `ctx.next()`.

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterName` | `string` | yes |
| `mode` | `"disabled" \| "discover" \| "import"` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `success` | `boolean` | yes |

### <a id="log-import.uploadFiles"></a>`log-import.uploadFiles` (rpc)

Upload session files for log import.
Files are base64-encoded for bus transport.

Subject: `log-import.uploadFiles`
Type: Request (RPC)
Purpose: Allows users to upload session files directly for import.

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterName` | `string` | yes |
| `files` | `{ filename: string; contentBase64: string; }[]` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `adapterName` | `string` | yes |
| `errors` | `{ filename: string; error: string; }[]` | yes |
| `filesProcessed` | `number` | yes |
| `sessionsImported` | `number` | yes |

---

*Auto-generated by `yarn docs:bus`. Do not edit manually.*
