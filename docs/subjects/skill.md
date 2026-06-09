---
title: "skill"
editUrl: false
prev: false
next: false
---

# `skill`

| Field | Value |
|-------|-------|
| Prefix | `skill` |
| Namespace constant | `SkillNamespace` |
| Subjects constant | `SkillSubjects` |
| Kind | bus |
| Schema record | `SkillSchemas` |
| Tier | framework |
| Package | `@makaio/contracts` |
| Defined in | [`core/contracts/src/skill/namespace.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/skill/namespace.ts) |

## Subjects

| Key | Wire | Type | Schema |
|-----|------|------|--------|
| `activate` | [`skill.activate`](#skill.activate) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/skill/schemas.ts) |
| `activated` | [`skill.activated`](#skill.activated) | event | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/skill/schemas.ts) |
| `catalog.built` | [`skill.catalog.built`](#skill.catalog.built) | event | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/skill/schemas.ts) |
| `deactivated` | [`skill.deactivated`](#skill.deactivated) | event | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/skill/schemas.ts) |
| `getActiveSkills` | [`skill.getActiveSkills`](#skill.getActiveSkills) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/skill/schemas.ts) |
| `getCatalog` | [`skill.getCatalog`](#skill.getCatalog) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/skill/schemas.ts) |

## Subject Details

### <a id="skill.activate"></a>`skill.activate` (rpc)

Subject: `skill.activate`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string \| undefined` | no |
| `agentId` | `string` | yes |
| `cwd` | `string \| undefined` | no |
| `projectId` | `string \| undefined` | no |
| `sessionId` | `string` | yes |
| `skillName` | `string` | yes |
| `trigger` | `"user" \| "model" \| "auto" \| "reinjection"` | yes |
| `turnNumber` | `number \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `alreadyActive` | `boolean` | yes |
| `baseDir` | `string \| undefined` | no |
| `content` | `string` | yes |
| `metadata` | `{ license?: string \| undefined; compatibility?: string \| undefined; allowedTools?: string \| undefined; metadata?: Record<string, string> \| undefined; } \| undefined` | no |
| `name` | `string` | yes |
| `resources` | `string[] \| undefined` | no |

### <a id="skill.activated"></a>`skill.activated` (event)

Subject: `skill.activated`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string \| undefined` | no |
| `agentId` | `string` | yes |
| `cwd` | `string` | yes |
| `sessionId` | `string` | yes |
| `skillName` | `string` | yes |
| `timestamp` | `number` | yes |
| `trigger` | `"user" \| "model" \| "auto" \| "reinjection"` | yes |
| `turnNumber` | `number \| undefined` | no |

### <a id="skill.catalog.built"></a>`skill.catalog.built` (event)

Subject: `skill.catalog.built`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string \| undefined` | no |
| `agentId` | `string` | yes |
| `cwd` | `string` | yes |
| `sessionId` | `string` | yes |
| `skillNames` | `string[]` | yes |
| `timestamp` | `number` | yes |

### <a id="skill.deactivated"></a>`skill.deactivated` (event)

Subject: `skill.deactivated`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `agentId` | `string` | yes |
| `reason` | `"user" \| "cwd_changed" \| "session_end" \| "replaced"` | yes |
| `sessionId` | `string` | yes |
| `skillName` | `string` | yes |
| `timestamp` | `number` | yes |

### <a id="skill.getActiveSkills"></a>`skill.getActiveSkills` (rpc)

Subject: `skill.getActiveSkills`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string \| undefined` | no |
| `agentId` | `string` | yes |
| `cwd` | `string \| undefined` | no |
| `projectId` | `string \| undefined` | no |
| `sessionId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `cwd` | `string \| undefined` | no |
| `skills` | `{ name: string; content: string; trigger: "user" \| "model" \| "auto" \| "reinjection"; activatedAt: number; metadata?: { license?: string \| undefined; compatibility?: string \| undefined; allowedTools?: string \| undefined; metadata?: Record<string, string> \| undefined; } \| undefined; baseDir?: string \| undefined; resources?: string[] \| undefined; activatedAtTurn?: number \| undefined; lastInjectedAtTurn?: number \| undefined; reinjection?: { maxTurns?: number \| undefined; } \| undefined; }[]` | yes |

### <a id="skill.getCatalog"></a>`skill.getCatalog` (rpc)

Subject: `skill.getCatalog`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string \| undefined` | no |
| `agentId` | `string` | yes |
| `cwd` | `string \| undefined` | no |
| `projectId` | `string \| undefined` | no |
| `sessionId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `cwd` | `string` | yes |
| `entries` | `{ name: string; description: string; activationMode: "manual" \| "auto"; source: "filesystem" \| "database"; scope: "session" \| "global" \| "project"; compatibility?: string \| undefined; category?: string \| undefined; tags?: string[] \| undefined; adapters?: string[] \| null \| undefined; location?: string \| undefined; baseDir?: string \| undefined; }[]` | yes |

---

*Auto-generated by `yarn docs:bus`. Do not edit manually.*
