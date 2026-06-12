---
title: "storage:skill"
editUrl: false
prev: false
next: false
---

# `storage:skill`

| Field | Value |
|-------|-------|
| Prefix | `storage:skill` |
| Namespace constant | `SkillStorageNamespace` |
| Subjects constant | `SkillStorageSubjects` |
| Kind | storage |
| Schema record | `<inline>` |
| Tier | framework |
| Package | `@makaio/contracts` |
| Defined in | [`core/contracts/src/skill/storage-namespace.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/skill/storage-namespace.ts) |

## Subjects

| Key | Wire | Type | Schema |
|-----|------|------|--------|
| `delete` | [`storage:skill.delete`](#storage:skill.delete) | rpc | — |
| `get` | [`storage:skill.get`](#storage:skill.get) | rpc | — |
| `getEffective` | [`storage:skill.getEffective`](#storage:skill.getEffective) | rpc | — |
| `list` | [`storage:skill.list`](#storage:skill.list) | rpc | — |
| `set` | [`storage:skill.set`](#storage:skill.set) | rpc | — |

## Subject Details

### <a id="storage:skill.delete"></a>`storage:skill.delete` (rpc)

Subject: `storage:skill.delete`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `id` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `deleted` | `boolean` | yes |

### <a id="storage:skill.get"></a>`storage:skill.get` (rpc)

Subject: `storage:skill.get`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `id` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `skill` | `{ name: string; description: string; activationMode: "manual" \| "auto"; enabled: boolean; id: string; source: "filesystem" \| "database"; scope: "session" \| "global" \| "project"; content: string; createdAt: number; updatedAt: number; license?: string \| undefined; compatibility?: string \| undefined; metadata?: Record<string, string> \| undefined; allowedTools?: string \| undefined; category?: string \| undefined; tags?: string[] \| undefined; adapters?: string[] \| null \| undefined; reinjection?: { maxTurns?: number \| undefined; } \| undefined; projectId?: string \| undefined; sessionId?: string \| undefined; location?: string \| undefined; baseDir?: string \| undefined; } \| null` | yes |

### <a id="storage:skill.getEffective"></a>`storage:skill.getEffective` (rpc)

Subject: `storage:skill.getEffective`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string \| undefined` | no |
| `category` | `string \| undefined` | no |
| `enabledOnly` | `boolean \| undefined` | no |
| `projectId` | `string \| undefined` | no |
| `sessionId` | `string \| undefined` | no |
| `tags` | `string[] \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `skills` | `{ name: string; description: string; activationMode: "manual" \| "auto"; enabled: boolean; id: string; source: "filesystem" \| "database"; scope: "session" \| "global" \| "project"; content: string; createdAt: number; updatedAt: number; license?: string \| undefined; compatibility?: string \| undefined; metadata?: Record<string, string> \| undefined; allowedTools?: string \| undefined; category?: string \| undefined; tags?: string[] \| undefined; adapters?: string[] \| null \| undefined; reinjection?: { maxTurns?: number \| undefined; } \| undefined; projectId?: string \| undefined; sessionId?: string \| undefined; location?: string \| undefined; baseDir?: string \| undefined; }[]` | yes |

### <a id="storage:skill.list"></a>`storage:skill.list` (rpc)

Subject: `storage:skill.list`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string \| undefined` | no |
| `category` | `string \| undefined` | no |
| `enabledOnly` | `boolean \| undefined` | no |
| `projectId` | `string \| undefined` | no |
| `sessionId` | `string \| undefined` | no |
| `tags` | `string[] \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `skills` | `{ name: string; description: string; activationMode: "manual" \| "auto"; enabled: boolean; id: string; source: "filesystem" \| "database"; scope: "session" \| "global" \| "project"; content: string; createdAt: number; updatedAt: number; license?: string \| undefined; compatibility?: string \| undefined; metadata?: Record<string, string> \| undefined; allowedTools?: string \| undefined; category?: string \| undefined; tags?: string[] \| undefined; adapters?: string[] \| null \| undefined; reinjection?: { maxTurns?: number \| undefined; } \| undefined; projectId?: string \| undefined; sessionId?: string \| undefined; location?: string \| undefined; baseDir?: string \| undefined; }[]` | yes |

### <a id="storage:skill.set"></a>`storage:skill.set` (rpc)

Subject: `storage:skill.set`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `skill` | `{ name: string; description: string; id: string; scope: "session" \| "global" \| "project"; content: string; license?: string \| undefined; compatibility?: string \| undefined; metadata?: Record<string, string> \| undefined; allowedTools?: string \| undefined; category?: string \| undefined; tags?: string[] \| undefined; adapters?: string[] \| null \| undefined; activationMode?: "manual" \| "auto" \| undefined; reinjection?: { maxTurns?: number \| undefined; } \| undefined; enabled?: boolean \| undefined; projectId?: string \| undefined; sessionId?: string \| undefined; source?: "database" \| undefined; }` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `id` | `string` | yes |

---

*Auto-generated by `yarn docs:bus`. Do not edit manually.*
