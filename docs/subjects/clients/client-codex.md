---
title: "client:codex"
editUrl: false
prev: false
next: false
---

# `client:codex`

| Field | Value |
|-------|-------|
| Prefix | `client:codex` |
| Namespace constant | `codex` |
| Kind | client |
| Schema record | `<inline>` |
| Tier | framework |
| Package | `@makaio/client-codex` |
| Defined in | [`clients/codex/src/runtime/namespace.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/clients/codex/src/runtime/namespace.ts) |

## Subjects

| Key | Wire | Type | Schema |
|-----|------|------|--------|
| `config.hooks.add` | [`client:codex.config.hooks.add`](#client:codex.config.hooks.add) | rpc | [`config.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/clients/codex/src/schemas/config.ts) |
| `config.hooks.list` | [`client:codex.config.hooks.list`](#client:codex.config.hooks.list) | rpc | [`config.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/clients/codex/src/schemas/config.ts) |
| `config.hooks.remove` | [`client:codex.config.hooks.remove`](#client:codex.config.hooks.remove) | rpc | [`config.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/clients/codex/src/schemas/config.ts) |
| `config.prime` | [`client:codex.config.prime`](#client:codex.config.prime) | rpc | [`profile.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/client/profile.ts) |
| `sessionConfig.setup` | [`client:codex.sessionConfig.setup`](#client:codex.sessionConfig.setup) | rpc | — |
| `wiring.apply` | [`client:codex.wiring.apply`](#client:codex.wiring.apply) | rpc | [`wiring.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/clients/codex/src/schemas/wiring.ts) |
| `wiring.list` | [`client:codex.wiring.list`](#client:codex.wiring.list) | rpc | [`wiring.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/clients/codex/src/schemas/wiring.ts) |
| `wiring.remove` | [`client:codex.wiring.remove`](#client:codex.wiring.remove) | rpc | [`wiring.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/clients/codex/src/schemas/wiring.ts) |

## Subject Details

### <a id="client:codex.config.hooks.add"></a>`client:codex.config.hooks.add` (rpc)

Add a new hook entry to a config scope.

Subject: `client:codex.config.hooks.add`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `command` | `string` | yes |
| `event` | `string` | yes |
| `matcher` | `string \| undefined` | no |
| `projectDir` | `string \| undefined` | no |
| `scope` | `"global" \| "project"` | yes |
| `timeout` | `number \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `added` | `boolean` | yes |

### <a id="client:codex.config.hooks.list"></a>`client:codex.config.hooks.list` (rpc)

List effective hook configuration for a project directory.

Merges global and project-scoped hooks and returns both the effective list
and the per-scope breakdown.

Subject: `client:codex.config.hooks.list`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `eventName` | `string \| undefined` | no |
| `projectDir` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `effective` | `{ event: string; command: string; matcher?: string \| undefined; timeout?: number \| undefined; }[]` | yes |
| `perScope` | `{ scope: "global" \| "project"; path: string; writable: boolean; hooks: { event: string; command: string; matcher?: string \| undefined; timeout?: number \| undefined; }[]; }[]` | yes |

### <a id="client:codex.config.hooks.remove"></a>`client:codex.config.hooks.remove` (rpc)

Remove hook entries matching an event and command substring from a scope.

Subject: `client:codex.config.hooks.remove`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `event` | `string` | yes |
| `match` | `{ commandContains: string; }` | yes |
| `projectDir` | `string \| undefined` | no |
| `scope` | `"global" \| "project"` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `removed` | `number` | yes |

### <a id="client:codex.config.prime"></a>`client:codex.config.prime` (rpc)

Request and response schemas for `client.config.prime`.

The generic `client.config.prime` handler delegates to the per-client
`client:<clientId>.config.prime` subject via `requestOptional`.  If no
client-specific handler is registered the call is a no-op.

This allows client packages to perform one-time or per-session config
initialisation (e.g. writing settings templates, injecting MCP server
entries) at well-defined lifecycle points without the framework needing to
know the client's config file format.

Subject: `client:codex.config.prime`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterName` | `string \| undefined` | no |
| `binaryVersion` | `string \| undefined` | no |
| `clientId` | `string` | yes |
| `configDir` | `string` | yes |
| `phase` | `"managed-install" \| "profile-create" \| "session-create"` | yes |
| `projectDir` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `primed` | `boolean` | yes |

### <a id="client:codex.sessionConfig.setup"></a>`client:codex.sessionConfig.setup` (rpc)

Subject: `client:codex.sessionConfig.setup`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `baseConfigDir` | `string` | yes |
| `configInheritance` | `"auth-only" \| "full" \| "empty"` | yes |
| `platform` | `"darwin" \| "linux" \| "win32"` | yes |
| `projectDir` | `string \| undefined` | no |
| `sessionDir` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `env` | `Record<string, string> \| undefined` | no |

### <a id="client:codex.wiring.apply"></a>`client:codex.wiring.apply` (rpc)

Install all wiring entries into the specified scope.

Entries already present are skipped (idempotent). The `makaioCommand`
string is written verbatim as the shell command for hook entries.

Subject: `client:codex.wiring.apply`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `makaioCommand` | `string` | yes |
| `projectDir` | `string \| undefined` | no |
| `scope` | `"global" \| "project"` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `applied` | `number` | yes |
| `skipped` | `number` | yes |

### <a id="client:codex.wiring.list"></a>`client:codex.wiring.list` (rpc)

List all known wiring entries for the target scope, indicating which are
currently installed in the Codex native config.

When `projectDir` is absent, only the `global` scope entries are reported.
Callers that need project-scope entries must supply the absolute path to
the project root.

Subject: `client:codex.wiring.list`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `makaioCommand` | `string` | yes |
| `projectDir` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `entries` | `{ group: string; name: string; installed: boolean; command: string; }[]` | yes |

### <a id="client:codex.wiring.remove"></a>`client:codex.wiring.remove` (rpc)

Uninstall all wiring entries from the specified scope.

Entries that are not present are silently ignored (idempotent). The
`removed` count in the response reflects only entries that were actually
deleted from the config file.

Subject: `client:codex.wiring.remove`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `projectDir` | `string \| undefined` | no |
| `scope` | `"global" \| "project"` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `removed` | `number` | yes |

---

*Auto-generated by `yarn docs:bus`. Do not edit manually.*
