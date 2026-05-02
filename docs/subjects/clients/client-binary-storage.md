---
title: "client-binary:storage"
editUrl: false
prev: false
next: false
---

# `client-binary:storage`

| Field | Value |
|-------|-------|
| Prefix | `client-binary:storage` |
| Namespace constant | `ClientBinaryStorageNamespace` |
| Subjects constant | `ClientBinaryStorageSubjects` |
| Kind | bus |
| Schema record | `<inline>` |
| Tier | framework |
| Package | `@makaio/clients-core` |
| Defined in | [`packages/clients-core/src/storage/client-binary-storage-namespace.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/clients-core/src/storage/client-binary-storage-namespace.ts) |

## Subjects

| Key | Wire | Type | Schema |
|-----|------|------|--------|
| `getSnapshot` | [`client-binary:storage.getSnapshot`](#client-binary:storage.getSnapshot) | rpc | — |
| `getState` | [`client-binary:storage.getState`](#client-binary:storage.getState) | rpc | — |
| `insertVersion` | [`client-binary:storage.insertVersion`](#client-binary:storage.insertVersion) | rpc | — |
| `listVersions` | [`client-binary:storage.listVersions`](#client-binary:storage.listVersions) | rpc | — |
| `loadAllState` | [`client-binary:storage.loadAllState`](#client-binary:storage.loadAllState) | rpc | — |
| `loadAllVersions` | [`client-binary:storage.loadAllVersions`](#client-binary:storage.loadAllVersions) | rpc | — |
| `loadSnapshot` | [`client-binary:storage.loadSnapshot`](#client-binary:storage.loadSnapshot) | rpc | — |
| `recordInstalledVersion` | [`client-binary:storage.recordInstalledVersion`](#client-binary:storage.recordInstalledVersion) | rpc | — |
| `removeVersionAndClearActive` | [`client-binary:storage.removeVersionAndClearActive`](#client-binary:storage.removeVersionAndClearActive) | rpc | — |
| `setActiveVersion` | [`client-binary:storage.setActiveVersion`](#client-binary:storage.setActiveVersion) | rpc | — |
| `updateFeedCache` | [`client-binary:storage.updateFeedCache`](#client-binary:storage.updateFeedCache) | rpc | — |
| `upsertState` | [`client-binary:storage.upsertState`](#client-binary:storage.upsertState) | rpc | — |

## Subject Details

### <a id="client-binary:storage.getSnapshot"></a>`client-binary:storage.getSnapshot` (rpc)

Return a single-client state + installed-version snapshot from one storage
read boundary.

Subject: `client-binary:storage.getSnapshot`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `clientId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `state` | `{ clientId: string; activeVersion: string \| null; latestAvailableVersion: string \| null; latestVersionLastCheckedAt: number \| null; latestVersionSourceStatus: "error" \| "fresh" \| "cached"; updatedAt: number; } \| null` | yes |
| `versions` | `{ id: string; clientId: string; version: string; installPath: string; installedAt: number; createdAt: number; }[]` | yes |

### <a id="client-binary:storage.getState"></a>`client-binary:storage.getState` (rpc)

Return the per-client binary state row, or `null` when it does not exist.

Subject: `client-binary:storage.getState`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `clientId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `state` | `{ clientId: string; activeVersion: string \| null; latestAvailableVersion: string \| null; latestVersionLastCheckedAt: number \| null; latestVersionSourceStatus: "error" \| "fresh" \| "cached"; updatedAt: number; } \| null` | yes |

### <a id="client-binary:storage.insertVersion"></a>`client-binary:storage.insertVersion` (rpc)

Insert a new installed-version row.

Subject: `client-binary:storage.insertVersion`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `clientId` | `string` | yes |
| `createdAt` | `number` | yes |
| `id` | `string` | yes |
| `installedAt` | `number` | yes |
| `installPath` | `string` | yes |
| `version` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `success` | `boolean` | yes |

### <a id="client-binary:storage.listVersions"></a>`client-binary:storage.listVersions` (rpc)

Return all installed-version rows for a given client.

Subject: `client-binary:storage.listVersions`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `clientId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `versions` | `{ id: string; clientId: string; version: string; installPath: string; installedAt: number; createdAt: number; }[]` | yes |

### <a id="client-binary:storage.loadAllState"></a>`client-binary:storage.loadAllState` (rpc)

Return the state rows for all clients (used for boot hydration).

Subject: `client-binary:storage.loadAllState`
Type: Request (RPC)

**Request:**

_Empty object._

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `states` | `{ clientId: string; activeVersion: string \| null; latestAvailableVersion: string \| null; latestVersionLastCheckedAt: number \| null; latestVersionSourceStatus: "error" \| "fresh" \| "cached"; updatedAt: number; }[]` | yes |

### <a id="client-binary:storage.loadAllVersions"></a>`client-binary:storage.loadAllVersions` (rpc)

Return all installed-version rows across every client (used for boot hydration).

Subject: `client-binary:storage.loadAllVersions`
Type: Request (RPC)

**Request:**

_Empty object._

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `versions` | `{ id: string; clientId: string; version: string; installPath: string; installedAt: number; createdAt: number; }[]` | yes |

### <a id="client-binary:storage.loadSnapshot"></a>`client-binary:storage.loadSnapshot` (rpc)

Return all state and installed-version rows from one storage read boundary.

Subject: `client-binary:storage.loadSnapshot`
Type: Request (RPC)

**Request:**

_Empty object._

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `states` | `{ clientId: string; activeVersion: string \| null; latestAvailableVersion: string \| null; latestVersionLastCheckedAt: number \| null; latestVersionSourceStatus: "error" \| "fresh" \| "cached"; updatedAt: number; }[]` | yes |
| `versions` | `{ id: string; clientId: string; version: string; installPath: string; installedAt: number; createdAt: number; }[]` | yes |

### <a id="client-binary:storage.recordInstalledVersion"></a>`client-binary:storage.recordInstalledVersion` (rpc)

Atomically record an installed version and optionally mark it active.

Used by successful install/update jobs so storage never commits a version
row without the requested active pointer update.

Subject: `client-binary:storage.recordInstalledVersion`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `makeActive` | `boolean` | yes |
| `updatedAt` | `number` | yes |
| `versionRecord` | `{ id: string; clientId: string; version: string; installPath: string; installedAt: number; createdAt: number; }` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `activeVersion` | `string \| null` | yes |
| `previousActiveVersion` | `string \| null` | yes |

### <a id="client-binary:storage.removeVersionAndClearActive"></a>`client-binary:storage.removeVersionAndClearActive` (rpc)

Atomically remove an installed-version row and clear the active-version
pointer when it currently points to the deleted version.

Both operations are executed inside a single SQLite transaction so that
concurrent reads never observe a state where the version row is absent but
the active pointer still references it.

Subject: `client-binary:storage.removeVersionAndClearActive`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `clientId` | `string` | yes |
| `updatedAt` | `number` | yes |
| `version` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `activeVersion` | `string \| null` | yes |
| `previousActiveVersion` | `string \| null` | yes |
| `removedVersion` | `string \| null` | yes |

### <a id="client-binary:storage.setActiveVersion"></a>`client-binary:storage.setActiveVersion` (rpc)

Set the active version without touching feed-cache fields.

Creates a minimal state row when one does not exist yet.

Subject: `client-binary:storage.setActiveVersion`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `activeVersion` | `string \| null` | yes |
| `clientId` | `string` | yes |
| `updatedAt` | `number` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `activeVersion` | `string \| null` | yes |
| `previousActiveVersion` | `string \| null` | yes |

### <a id="client-binary:storage.updateFeedCache"></a>`client-binary:storage.updateFeedCache` (rpc)

Persist an updated feed-cache entry for a client.

This is a subset of `upsertState` — the handler merges the feed fields
into the existing row (or creates a minimal row) without touching
`activeVersion`.

Subject: `client-binary:storage.updateFeedCache`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `clientId` | `string` | yes |
| `latestAvailableVersion` | `string \| null` | yes |
| `latestVersionLastCheckedAt` | `number \| null` | yes |
| `latestVersionSourceStatus` | `"error" \| "fresh" \| "cached"` | yes |
| `updatedAt` | `number` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `success` | `boolean` | yes |

### <a id="client-binary:storage.upsertState"></a>`client-binary:storage.upsertState` (rpc)

Upsert the per-client binary state row (active version + feed cache).

Subject: `client-binary:storage.upsertState`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `activeVersion` | `string \| null` | yes |
| `clientId` | `string` | yes |
| `latestAvailableVersion` | `string \| null` | yes |
| `latestVersionLastCheckedAt` | `number \| null` | yes |
| `latestVersionSourceStatus` | `"error" \| "fresh" \| "cached"` | yes |
| `updatedAt` | `number` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `success` | `boolean` | yes |

---

*Auto-generated by `yarn docs:bus`. Do not edit manually.*
