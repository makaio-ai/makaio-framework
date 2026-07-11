---
title: "client:claude-code"
editUrl: false
prev: false
next: false
---

# `client:claude-code`

| Field | Value |
|-------|-------|
| Prefix | `client:claude-code` |
| Namespace constant | `claudeCodeNamespace` |
| Subjects constant | `ClaudeCodeClientSubjects` |
| Kind | client |
| Schema record | `<inline>` |
| Tier | framework |
| Package | `@makaio/client-claude-code` |
| Defined in | [`clients/claude-code/src/runtime/namespace.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/clients/claude-code/src/runtime/namespace.ts) |

## Subjects

| Key | Wire | Type | Schema |
|-----|------|------|--------|
| `config.hooks.add` | [`client:claude-code.config.hooks.add`](#client:claude-code.config.hooks.add) | rpc | [`config.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/clients/claude-code/src/schemas/config.ts) |
| `config.hooks.list` | [`client:claude-code.config.hooks.list`](#client:claude-code.config.hooks.list) | rpc | [`config.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/clients/claude-code/src/schemas/config.ts) |
| `config.hooks.remove` | [`client:claude-code.config.hooks.remove`](#client:claude-code.config.hooks.remove) | rpc | [`config.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/clients/claude-code/src/schemas/config.ts) |
| `config.mcpServers.add` | [`client:claude-code.config.mcpServers.add`](#client:claude-code.config.mcpServers.add) | rpc | [`config.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/clients/claude-code/src/schemas/config.ts) |
| `config.mcpServers.list` | [`client:claude-code.config.mcpServers.list`](#client:claude-code.config.mcpServers.list) | rpc | [`config.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/clients/claude-code/src/schemas/config.ts) |
| `config.mcpServers.remove` | [`client:claude-code.config.mcpServers.remove`](#client:claude-code.config.mcpServers.remove) | rpc | [`config.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/clients/claude-code/src/schemas/config.ts) |
| `config.plugins.list` | [`client:claude-code.config.plugins.list`](#client:claude-code.config.plugins.list) | rpc | [`config.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/clients/claude-code/src/schemas/config.ts) |
| `config.prime` | [`client:claude-code.config.prime`](#client:claude-code.config.prime) | rpc | [`config-prime.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/clients/claude-code/src/schemas/config-prime.ts) |
| `config.statusline.list` | [`client:claude-code.config.statusline.list`](#client:claude-code.config.statusline.list) | rpc | [`config.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/clients/claude-code/src/schemas/config.ts) |
| `config.statusline.set` | [`client:claude-code.config.statusline.set`](#client:claude-code.config.statusline.set) | rpc | [`config.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/clients/claude-code/src/schemas/config.ts) |
| `sessionConfig.destroy` | [`client:claude-code.sessionConfig.destroy`](#client:claude-code.sessionConfig.destroy) | rpc | [`session-config.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/clients/claude-code/src/schemas/session-config.ts) |
| `sessionConfig.setup` | [`client:claude-code.sessionConfig.setup`](#client:claude-code.sessionConfig.setup) | rpc | [`session-config.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/clients/claude-code/src/schemas/session-config.ts) |
| `statusline.received` | [`client:claude-code.statusline.received`](#client:claude-code.statusline.received) | event | [`statusline.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/clients/claude-code/src/schemas/statusline.ts) |
| `wiring.apply` | [`client:claude-code.wiring.apply`](#client:claude-code.wiring.apply) | rpc | [`wiring.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/clients/claude-code/src/schemas/wiring.ts) |
| `wiring.list` | [`client:claude-code.wiring.list`](#client:claude-code.wiring.list) | rpc | [`wiring.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/clients/claude-code/src/schemas/wiring.ts) |
| `wiring.remove` | [`client:claude-code.wiring.remove`](#client:claude-code.wiring.remove) | rpc | [`wiring.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/clients/claude-code/src/schemas/wiring.ts) |

## Subject Details

### <a id="client:claude-code.config.hooks.add"></a>`client:claude-code.config.hooks.add` (rpc)

Append a hook to a given scope, event, and optional matcher.

Creates or extends the matcher group at the target scope. If a group with
the same `matcher` already exists the hook is appended to it; otherwise a
new group is created.

Subject: `client:claude-code.config.hooks.add`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `eventName` | `string` | yes |
| `hook` | `{ type: "command"; command: string; timeout?: number \| undefined; }` | yes |
| `matcher` | `string \| undefined` | no |
| `projectDir` | `string \| undefined` | no |
| `scope` | `"local" \| "user" \| "project"` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `added` | `boolean` | yes |

### <a id="client:claude-code.config.hooks.list"></a>`client:claude-code.config.hooks.list` (rpc)

Read the effective hook configuration plus each scope's raw hook map.

When `eventName` is supplied only hooks for that event are returned;
otherwise all events are included.

Subject: `client:claude-code.config.hooks.list`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `eventName` | `string \| undefined` | no |
| `projectDir` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `effective` | `Record<string, { hooks: { type: "command"; command: string; timeout?: number \| undefined; }[]; matcher?: string \| undefined; }[]>` | yes |
| `perScope` | `{ scope: "local" \| "user" \| "project"; path: string; events: Record<string, { hooks: { type: "command"; command: string; timeout?: number \| undefined; }[]; matcher?: string \| undefined; }[]>; }[]` | yes |

### <a id="client:claude-code.config.hooks.remove"></a>`client:claude-code.config.hooks.remove` (rpc)

Remove hooks whose command string contains the given substring.

Removes every hook definition in the specified scope and event whose
`command` field contains `match.commandContains`. Matcher groups that
become empty after removal are also pruned.

Subject: `client:claude-code.config.hooks.remove`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `eventName` | `string` | yes |
| `match` | `{ commandContains: string; }` | yes |
| `projectDir` | `string \| undefined` | no |
| `scope` | `"local" \| "user" \| "project"` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `removed` | `number` | yes |

### <a id="client:claude-code.config.mcpServers.add"></a>`client:claude-code.config.mcpServers.add` (rpc)

Add an MCP server to the project's `.mcp.json`.

Idempotent: when a server with the same `name` already exists and its
definition is structurally equal, no write is performed and
`added: false` is returned.  When a server with the same name exists
but differs, it is overwritten and `added: true, replaced: true`.

Subject: `client:claude-code.config.mcpServers.add`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `name` | `string` | yes |
| `projectDir` | `string` | yes |
| `server` | `{ [x: string]: unknown; type: string; url?: string \| undefined; command?: string \| undefined; args?: string[] \| undefined; env?: Record<string, string> \| undefined; }` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `added` | `boolean` | yes |
| `replaced` | `boolean` | yes |

### <a id="client:claude-code.config.mcpServers.list"></a>`client:claude-code.config.mcpServers.list` (rpc)

List MCP servers defined in the project's `.mcp.json`.

Returns all server entries keyed by name.  `projectDir` is required
because `.mcp.json` is always project-scoped.

Subject: `client:claude-code.config.mcpServers.list`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `projectDir` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `servers` | `Record<string, { [x: string]: unknown; type: string; url?: string \| undefined; command?: string \| undefined; args?: string[] \| undefined; env?: Record<string, string> \| undefined; }>` | yes |

### <a id="client:claude-code.config.mcpServers.remove"></a>`client:claude-code.config.mcpServers.remove` (rpc)

Remove an MCP server from the project's `.mcp.json`.

Subject: `client:claude-code.config.mcpServers.remove`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `name` | `string` | yes |
| `projectDir` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `removed` | `boolean` | yes |

### <a id="client:claude-code.config.plugins.list"></a>`client:claude-code.config.plugins.list` (rpc)

List effective extensions visible to Claude Code along with enabled state.

Later scopes override earlier scopes per plugin name; the returned scope is
the scope that supplied the effective enabled state.

Subject: `client:claude-code.config.plugins.list`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `projectDir` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `plugins` | `{ name: string; enabled: boolean; scope: "local" \| "user" \| "project"; }[]` | yes |

### <a id="client:claude-code.config.prime"></a>`client:claude-code.config.prime` (rpc)

Prime the config directory with Claude Code-specific defaults.

Dispatched by the framework at `managed-install`, `profile-create`, and
`session-create` lifecycle phases. The handler ensures `settings.json`
contains `env.DISABLE_AUTOUPDATER = "1"` while preserving any existing
settings.

Subject: `client:claude-code.config.prime`
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

### <a id="client:claude-code.config.statusline.list"></a>`client:claude-code.config.statusline.list` (rpc)

Read the effective status-line configuration plus each scope's raw value.

The `effective` field reflects the value that Claude Code would use after
scope resolution. `perScope` enumerates available scopes in resolution
order (broadest to narrowest) so callers can inspect the full picture.

Subject: `client:claude-code.config.statusline.list`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `projectDir` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `effective` | `{ type: "command"; command: string; padding?: number \| undefined; } \| null` | yes |
| `perScope` | `{ scope: "local" \| "user" \| "project"; path: string; value: { type: "command"; command: string; padding?: number \| undefined; } \| null; }[]` | yes |

### <a id="client:claude-code.config.statusline.set"></a>`client:claude-code.config.statusline.set` (rpc)

Write a status-line value to a specific scope.

Overwrites any existing status-line entry at the chosen scope and returns
both the previous value (for undo support) and the value that was actually
persisted.

Subject: `client:claude-code.config.statusline.set`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `projectDir` | `string \| undefined` | no |
| `scope` | `"local" \| "user" \| "project"` | yes |
| `value` | `{ type: "command"; command: string; padding?: number \| undefined; }` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `applied` | `{ type: "command"; command: string; padding?: number \| undefined; }` | yes |
| `previous` | `{ type: "command"; command: string; padding?: number \| undefined; } \| null` | yes |

### <a id="client:claude-code.sessionConfig.destroy"></a>`client:claude-code.sessionConfig.destroy` (rpc)

Clear native credential material associated with a session-scoped config
directory before the generic lifecycle service removes the directory.

Subject: `client:claude-code.sessionConfig.destroy`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `platform` | `"darwin" \| "linux" \| "win32"` | yes |
| `sessionDir` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `success` | `boolean` | yes |

### <a id="client:claude-code.sessionConfig.setup"></a>`client:claude-code.sessionConfig.setup` (rpc)

Seed the session-scoped config directory with the appropriate Claude Code
native files.

Dispatched by `ClientSessionConfigService` after creating the session
directory.  The handler applies `configInheritance` to decide whether to
inherit settings plus auth, auth only, or an empty config shell.

Subject: `client:claude-code.sessionConfig.setup`
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
| `authMaterialized` | `boolean` | yes |
| `env` | `Record<string, string> \| undefined` | no |

### <a id="client:claude-code.statusline.received"></a>`client:claude-code.statusline.received` (event)

Raw Claude Code statusline payload schema used by the Claude-specific
`client:claude-code.*` namespace.

Subject: `client:claude-code.statusline.received`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `agent` | `{ [x: string]: unknown; name?: string \| undefined; kind?: string \| undefined; } \| undefined` | no |
| `context_window` | `{ [x: string]: unknown; total_input_tokens?: number \| undefined; total_output_tokens?: number \| undefined; context_window_size?: number \| undefined; used_percentage?: number \| null \| undefined; remaining_percentage?: number \| null \| undefined; current_usage?: { [x: string]: unknown; input_tokens?: number \| undefined; output_tokens?: number \| undefined; cache_creation_input_tokens?: number \| undefined; cache_read_input_tokens?: number \| undefined; } \| null \| undefined; } \| null \| undefined` | no |
| `cost` | `{ [x: string]: unknown; total_cost_usd?: number \| undefined; total_duration_ms?: number \| undefined; total_api_duration_ms?: number \| undefined; total_lines_added?: number \| undefined; total_lines_removed?: number \| undefined; total_edits?: number \| undefined; } \| undefined` | no |
| `cwd` | `string \| undefined` | no |
| `exceeds_200k_tokens` | `boolean \| undefined` | no |
| `model` | `{ [x: string]: unknown; id?: string \| undefined; display_name?: string \| undefined; family?: string \| undefined; } \| undefined` | no |
| `output_style` | `{ [x: string]: unknown; name?: string \| undefined; variant?: string \| undefined; } \| undefined` | no |
| `rate_limits` | `{ [x: string]: unknown; five_hour?: { [x: string]: unknown; used_percentage?: number \| undefined; resets_at?: number \| undefined; } \| undefined; seven_day?: { [x: string]: unknown; used_percentage?: number \| undefined; resets_at?: number \| undefined; } \| undefined; } \| undefined` | no |
| `session_id` | `string \| undefined` | no |
| `session_name` | `string \| undefined` | no |
| `transcript_path` | `string \| undefined` | no |
| `version` | `string \| undefined` | no |
| `vim` | `{ [x: string]: unknown; mode?: string \| undefined; } \| undefined` | no |
| `workspace` | `{ [x: string]: unknown; current_dir?: string \| undefined; project_dir?: string \| undefined; added_dirs?: string[] \| undefined; git_worktree?: string \| undefined; } \| undefined` | no |
| `worktree` | `{ [x: string]: unknown; name?: string \| undefined; path?: string \| undefined; branch?: string \| undefined; original_cwd?: string \| undefined; original_branch?: string \| undefined; provider?: string \| undefined; } \| undefined` | no |

### <a id="client:claude-code.wiring.apply"></a>`client:claude-code.wiring.apply` (rpc)

Install all wiring entries into the specified scope.

Entries already present are skipped (idempotent). The `makaioCommand`
string is written verbatim as the shell command for hooks and as the
status-line command for the statusline entry.

Subject: `client:claude-code.wiring.apply`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `configDir` | `string \| undefined` | no |
| `envPairs` | `string[] \| undefined` | no |
| `makaioCommand` | `string` | yes |
| `projectDir` | `string \| undefined` | no |
| `scope` | `"local" \| "user" \| "project"` | yes |
| `skipDangerousModePermissionPrompt` | `boolean \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `applied` | `number` | yes |
| `skipped` | `number` | yes |

### <a id="client:claude-code.wiring.list"></a>`client:claude-code.wiring.list` (rpc)

List all known wiring entries for the target scope, indicating which are
currently installed in the Claude Code native config.

When `projectDir` is absent, only the `user` scope entries are reported.
Callers that need project- or local-scope entries must supply the absolute
path to the project root.

Subject: `client:claude-code.wiring.list`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `envPairs` | `string[] \| undefined` | no |
| `makaioCommand` | `string` | yes |
| `projectDir` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `entries` | `{ group: string; name: string; installed: boolean; command: string; }[]` | yes |

### <a id="client:claude-code.wiring.remove"></a>`client:claude-code.wiring.remove` (rpc)

Uninstall all wiring entries from the specified scope.

Entries that are not present are silently ignored (idempotent). The
`removed` count in the response reflects only entries that were actually
deleted from the config file.

Subject: `client:claude-code.wiring.remove`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `projectDir` | `string \| undefined` | no |
| `scope` | `"local" \| "user" \| "project"` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `removed` | `number` | yes |

---

*Auto-generated by `yarn docs:bus`. Do not edit manually.*
