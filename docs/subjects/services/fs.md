---
title: "fs"
editUrl: false
prev: false
next: false
---

# `fs`

| Field | Value |
|-------|-------|
| Prefix | `fs` |
| Namespace constant | `FsNamespace` |
| Subjects constant | `FsSubjects` |
| Kind | bus |
| Schema record | `FsSchemas` |
| Tier | framework |
| Package | `@makaio/services-core` |
| Defined in | [`services/core/src/filesystem/namespace.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/filesystem/namespace.ts) |

## Subjects

| Key | Wire | Type | Schema |
|-----|------|------|--------|
| `batch` | [`fs.batch`](#fs.batch) | event | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/filesystem/schemas.ts) |
| `changed` | [`fs.changed`](#fs.changed) | event | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/filesystem/schemas.ts) |
| `getHomeDir` | [`fs.getHomeDir`](#fs.getHomeDir) | rpc | — |
| `glob` | [`fs.glob`](#fs.glob) | rpc | — |
| `listDirectory` | [`fs.listDirectory`](#fs.listDirectory) | rpc | — |
| `listSources` | [`fs.listSources`](#fs.listSources) | rpc | — |
| `readFile` | [`fs.readFile`](#fs.readFile) | rpc | — |
| `unwatch` | [`fs.unwatch`](#fs.unwatch) | rpc | — |
| `watch` | [`fs.watch`](#fs.watch) | rpc | — |
| `writeFile` | [`fs.writeFile`](#fs.writeFile) | rpc | — |

## Subject Details

### <a id="fs.batch"></a>`fs.batch` (event)

Batch file change event payload.

Subject: `fs.batch`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `changes` | `{ path: string; kind: "create" \| "delete" \| "change"; }[]` | yes |

### <a id="fs.changed"></a>`fs.changed` (event)

Single file change event payload.

Subject: `fs.changed`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `kind` | `"create" \| "delete" \| "change"` | yes |
| `path` | `string` | yes |

### <a id="fs.getHomeDir"></a>`fs.getHomeDir` (rpc)

Subject: `fs.getHomeDir`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `machineId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `path` | `string` | yes |

### <a id="fs.glob"></a>`fs.glob` (rpc)

Subject: `fs.glob`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `cwd` | `string` | yes |
| `ignore` | `string[] \| undefined` | no |
| `limit` | `number \| undefined` | no |
| `machineId` | `string \| undefined` | no |
| `offset` | `number \| undefined` | no |
| `pattern` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `files` | `{ path: string; relativePath: string; type: "file" \| "directory"; size?: number \| undefined; }[]` | yes |
| `total` | `number` | yes |
| `truncated` | `boolean` | yes |

### <a id="fs.listDirectory"></a>`fs.listDirectory` (rpc)

Subject: `fs.listDirectory`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `machineId` | `string` | yes |
| `options` | `{ includeHidden?: boolean \| undefined; excludeNames?: string[] \| undefined; } \| undefined` | no |
| `path` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `breadcrumbs` | `{ name: string; path: string; }[]` | yes |
| `entries` | `{ name: string; path: string; type: "file" \| "directory"; relativePath?: string \| undefined; isGitRepo?: boolean \| undefined; size?: number \| undefined; modified?: number \| undefined; }[]` | yes |
| `errors` | `{ name: string; code: string; message: string; }[] \| undefined` | no |
| `isGitRepo` | `boolean` | yes |
| `parentPath` | `string \| null` | yes |
| `path` | `string` | yes |
| `segments` | `string[]` | yes |

### <a id="fs.listSources"></a>`fs.listSources` (rpc)

Subject: `fs.listSources`
Type: Request (RPC)

**Request:**

_Empty object._

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `sources` | `{ machineId: string; label: string; }[]` | yes |

### <a id="fs.readFile"></a>`fs.readFile` (rpc)

Subject: `fs.readFile`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `encoding` | `string \| undefined` | no |
| `machineId` | `string \| undefined` | no |
| `path` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `content` | `string` | yes |

### <a id="fs.unwatch"></a>`fs.unwatch` (rpc)

Subject: `fs.unwatch`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `id` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `success` | `boolean` | yes |

### <a id="fs.watch"></a>`fs.watch` (rpc)

Subject: `fs.watch`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `excludeFromDefaults` | `string[] \| undefined` | no |
| `extensions` | `string[] \| undefined` | no |
| `id` | `string` | yes |
| `paths` | `string[]` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `success` | `boolean` | yes |
| `watchId` | `string` | yes |

### <a id="fs.writeFile"></a>`fs.writeFile` (rpc)

Subject: `fs.writeFile`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `content` | `string` | yes |
| `encoding` | `string \| undefined` | no |
| `machineId` | `string \| undefined` | no |
| `path` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `success` | `boolean` | yes |

---

*Auto-generated by `yarn docs:bus`. Do not edit manually.*
