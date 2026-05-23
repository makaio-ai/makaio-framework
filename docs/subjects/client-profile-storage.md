---
title: "client-profile:storage"
editUrl: false
prev: false
next: false
---

# `client-profile:storage`

| Field | Value |
|-------|-------|
| Prefix | `client-profile:storage` |
| Namespace constant | `ClientProfileStorageNamespace` |
| Subjects constant | `ClientProfileStorageSubjects` |
| Kind | bus |
| Schema record | `<inline>` |
| Tier | framework |
| Package | `@makaio/subsystem-client` |
| Defined in | [`subsystems/client/src/storage/profile-storage-namespace.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/subsystems/client/src/storage/profile-storage-namespace.ts) |

## Subjects

| Key | Wire | Type | Schema |
|-----|------|------|--------|
| `clearDefault` | [`client-profile:storage.clearDefault`](#client-profile:storage.clearDefault) | rpc | — |
| `delete` | [`client-profile:storage.delete`](#client-profile:storage.delete) | rpc | — |
| `get` | [`client-profile:storage.get`](#client-profile:storage.get) | rpc | — |
| `getById` | [`client-profile:storage.getById`](#client-profile:storage.getById) | rpc | — |
| `list` | [`client-profile:storage.list`](#client-profile:storage.list) | rpc | — |
| `set` | [`client-profile:storage.set`](#client-profile:storage.set) | rpc | — |
| `setDefault` | [`client-profile:storage.setDefault`](#client-profile:storage.setDefault) | rpc | — |

## Subject Details

### <a id="client-profile:storage.clearDefault"></a>`client-profile:storage.clearDefault` (rpc)

Clear the `isDefault` flag on all profiles for a given client.

Low-level maintenance operation. Normal default promotion must use
`setDefault` so clearing and promotion share one storage transaction.

Subject: `client-profile:storage.clearDefault`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `clientId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `success` | `boolean` | yes |

### <a id="client-profile:storage.delete"></a>`client-profile:storage.delete` (rpc)

Delete the profile record identified by `(clientId, name)`.

Returns `{ success: true }` when a row was deleted and
`{ success: false }` when no matching row was found.

Subject: `client-profile:storage.delete`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `clientId` | `string` | yes |
| `name` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `success` | `boolean` | yes |

### <a id="client-profile:storage.get"></a>`client-profile:storage.get` (rpc)

Return a single profile record identified by `(clientId, name)`, or `null` when not found.

Subject: `client-profile:storage.get`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `clientId` | `string` | yes |
| `name` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `record` | `{ id: string; clientId: string; name: string; description: string \| null; configDir: string; isDefault: boolean; createdAt: number; updatedAt: number; } \| null` | yes |

### <a id="client-profile:storage.getById"></a>`client-profile:storage.getById` (rpc)

Return a single profile record by its stable row ID, or `null` when not found.

Subject: `client-profile:storage.getById`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `id` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `record` | `{ id: string; clientId: string; name: string; description: string \| null; configDir: string; isDefault: boolean; createdAt: number; updatedAt: number; } \| null` | yes |

### <a id="client-profile:storage.list"></a>`client-profile:storage.list` (rpc)

Return all profile records for a given client.

Subject: `client-profile:storage.list`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `clientId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `records` | `{ id: string; clientId: string; name: string; description: string \| null; configDir: string; isDefault: boolean; createdAt: number; updatedAt: number; }[]` | yes |

### <a id="client-profile:storage.set"></a>`client-profile:storage.set` (rpc)

Insert or update a profile record identified by its stable row ID.

On conflict, all mutable fields (`name`, `description`, `configDir`,
`isDefault`, `updatedAt`) are overwritten. `createdAt` is preserved on
subsequent upserts.

Subject: `client-profile:storage.set`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `clientId` | `string` | yes |
| `configDir` | `string` | yes |
| `createdAt` | `number` | yes |
| `description` | `string \| null` | yes |
| `id` | `string` | yes |
| `isDefault` | `boolean` | yes |
| `name` | `string` | yes |
| `updatedAt` | `number` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `success` | `boolean` | yes |

### <a id="client-profile:storage.setDefault"></a>`client-profile:storage.setDefault` (rpc)

Atomically promote one profile to default and clear the previous default.

Subject: `client-profile:storage.setDefault`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `clientId` | `string` | yes |
| `name` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `record` | `{ id: string; clientId: string; name: string; description: string \| null; configDir: string; isDefault: boolean; createdAt: number; updatedAt: number; } \| null` | yes |

---

*Auto-generated by `yarn docs:bus`. Do not edit manually.*
