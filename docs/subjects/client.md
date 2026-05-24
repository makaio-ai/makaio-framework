---
title: "client"
editUrl: false
prev: false
next: false
---

# `client`

| Field | Value |
|-------|-------|
| Prefix | `client` |
| Namespace constant | `ClientNamespace` |
| Subjects constant | `ClientSubjects` |
| Kind | bus |
| Schema record | `ClientSchemas` |
| Tier | framework |
| Package | `@makaio/contracts` |
| Defined in | [`core/contracts/src/client/namespace.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/client/namespace.ts) |

## Subjects

| Key | Wire | Type | Schema |
|-----|------|------|--------|
| `account.activate` | [`client.account.activate`](#client.account.activate) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/client/schemas.ts) |
| `account.getActive` | [`client.account.getActive`](#client.account.getActive) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/client/schemas.ts) |
| `account.observe` | [`client.account.observe`](#client.account.observe) | rpc | [`account-identity.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/client/account-identity.ts) |
| `config.prime` | [`client.config.prime`](#client.config.prime) | rpc | [`profile.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/client/profile.ts) |
| `install` | [`client.install`](#client.install) | rpc | [`binary-management.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/client/binary-management.ts) |
| `installJob.completed` | [`client.installJob.completed`](#client.installJob.completed) | event | [`binary-management.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/client/binary-management.ts) |
| `installJob.progress` | [`client.installJob.progress`](#client.installJob.progress) | event | [`binary-management.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/client/binary-management.ts) |
| `list` | [`client.list`](#client.list) | rpc | [`binary-management.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/client/binary-management.ts) |
| `profile.create` | [`client.profile.create`](#client.profile.create) | rpc | [`profile.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/client/profile.ts) |
| `profile.delete` | [`client.profile.delete`](#client.profile.delete) | rpc | [`profile.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/client/profile.ts) |
| `profile.get` | [`client.profile.get`](#client.profile.get) | rpc | [`profile.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/client/profile.ts) |
| `profile.list` | [`client.profile.list`](#client.profile.list) | rpc | [`profile.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/client/profile.ts) |
| `profile.setDefault` | [`client.profile.setDefault`](#client.profile.setDefault) | rpc | [`profile.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/client/profile.ts) |
| `profile.update` | [`client.profile.update`](#client.profile.update) | rpc | [`profile.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/client/profile.ts) |
| `resolveBinary` | [`client.resolveBinary`](#client.resolveBinary) | rpc | [`binary-resolution.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/client/binary-resolution.ts) |
| `runtime.observe` | [`client.runtime.observe`](#client.runtime.observe) | rpc | [`runtime-observation.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/client/runtime-observation.ts) |
| `runtime.started` | [`client.runtime.started`](#client.runtime.started) | event | [`runtime-observation.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/client/runtime-observation.ts) |
| `scan` | [`client.scan`](#client.scan) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/client/schemas.ts) |
| `session.account.observe` | [`client.session.account.observe`](#client.session.account.observe) | rpc | [`account-identity.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/client/account-identity.ts) |
| `session.started` | [`client.session.started`](#client.session.started) | event | [`session-observed.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/client/session-observed.ts) |
| `session.tool.post` | [`client.session.tool.post`](#client.session.tool.post) | event | [`session-observed.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/client/session-observed.ts) |
| `session.tool.pre` | [`client.session.tool.pre`](#client.session.tool.pre) | event | [`session-observed.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/client/session-observed.ts) |
| `session.turn.completed` | [`client.session.turn.completed`](#client.session.turn.completed) | event | [`session-observed.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/client/session-observed.ts) |
| `session.turn.started` | [`client.session.turn.started`](#client.session.turn.started) | event | [`session-observed.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/client/session-observed.ts) |
| `session.userPrompt.submitted` | [`client.session.userPrompt.submitted`](#client.session.userPrompt.submitted) | event | [`session-observed.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/client/session-observed.ts) |
| `sessionConfig.cleanup` | [`client.sessionConfig.cleanup`](#client.sessionConfig.cleanup) | rpc | [`profile.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/client/profile.ts) |
| `sessionConfig.create` | [`client.sessionConfig.create`](#client.sessionConfig.create) | rpc | [`profile.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/client/profile.ts) |
| `sessionConfig.destroy` | [`client.sessionConfig.destroy`](#client.sessionConfig.destroy) | rpc | [`profile.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/client/profile.ts) |
| `setActive` | [`client.setActive`](#client.setActive) | rpc | [`binary-management.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/client/binary-management.ts) |
| `uninstall` | [`client.uninstall`](#client.uninstall) | rpc | [`binary-management.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/client/binary-management.ts) |
| `update` | [`client.update`](#client.update) | rpc | [`binary-management.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/client/binary-management.ts) |
| `usage.ingest` | [`client.usage.ingest`](#client.usage.ingest) | rpc | [`account-identity.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/client/account-identity.ts) |
| `usage.snapshot` | [`client.usage.snapshot`](#client.usage.snapshot) | event | [`account-identity.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/client/account-identity.ts) |
| `version.changed` | [`client.version.changed`](#client.version.changed) | event | [`binary-management.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/client/binary-management.ts) |
| `wiring.list` | [`client.wiring.list`](#client.wiring.list) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/client/schemas.ts) |

## Subject Details

### <a id="client.account.activate"></a>`client.account.activate` (rpc)

Signal which account is currently active for a client.

Called by the account-manager after successfully linking an account
via `client.account.observe`. `ClientRuntimeService` persists the
supplied identity in memory so that other services (e.g. the Claude
Code client service) can query it without a session lookup.

Subject: `client.account.activate`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `clientAccountId` | `string` | yes |
| `clientId` | `string` | yes |
| `displayLabel` | `string \| undefined` | no |
| `identifiers` | `{ scheme: string; value: string; strength: "strong" \| "alias"; }[]` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `accepted` | `boolean` | yes |

### <a id="client.account.getActive"></a>`client.account.getActive` (rpc)

Retrieve the currently active account identity for a client.

Returns the identity most recently signalled via `account.activate`,
or `null` when no activation has been recorded for the given client.
Used as a fallback by the Claude Code client service when a statusline
payload cannot be correlated to a persisted session.

Subject: `client.account.getActive`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `clientId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `identity` | `{ clientAccountId: string; identifiers: { scheme: string; value: string; strength: "strong" \| "alias"; }[]; displayLabel?: string \| undefined; } \| null` | yes |

### <a id="client.account.observe"></a>`client.account.observe` (rpc)

Request and response schemas for client.account.observe.

Subject: `client.account.observe`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `clientId` | `string` | yes |
| `displayLabel` | `string \| undefined` | no |
| `identifiers` | `{ scheme: string; value: string; strength: "strong" \| "alias"; }[]` | yes |
| `metadata` | `Record<string, unknown> \| undefined` | no |
| `observedAt` | `number \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `clientAccountId` | `string` | yes |
| `displayLabel` | `string \| undefined` | no |

### <a id="client.config.prime"></a>`client.config.prime` (rpc)

Request and response schemas for `client.config.prime`.

The generic `client.config.prime` handler delegates to the per-client
`client:<clientId>.config.prime` subject via `requestOptional`.  If no
client-specific handler is registered the call is a no-op.

This allows client packages to perform one-time or per-session config
initialisation (e.g. writing settings templates, injecting MCP server
entries) at well-defined lifecycle points without the framework needing to
know the client's config file format.

Subject: `client.config.prime`
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

### <a id="client.install"></a>`client.install` (rpc)

Request and response schemas for `client.install`.

Enqueues a background install job for a managed client binary.
Callers can track progress via `client.installJob.progress` and
`client.installJob.completed` events using the returned `jobId`.

Subject: `client.install`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `clientId` | `string` | yes |
| `version` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `jobId` | `string` | yes |
| `requestedVersion` | `string \| null` | yes |
| `resolvedVersion` | `string \| null` | yes |

### <a id="client.installJob.completed"></a>`client.installJob.completed` (event)

Event payload for `client.installJob.completed`.

Emitted once by the install job runner when the pipeline finishes,
regardless of outcome. Listeners should check `status` before acting.

Subject: `client.installJob.completed`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `activeVersion` | `string \| null` | yes |
| `clientId` | `string` | yes |
| `error` | `{ message: string; code?: string \| undefined; } \| undefined` | no |
| `installPath` | `string \| undefined` | no |
| `jobId` | `string` | yes |
| `metadata` | `Record<string, unknown> \| undefined` | no |
| `status` | `"error" \| "success"` | yes |
| `strategy` | `"npm" \| "signed-binary-bucket"` | yes |
| `version` | `string \| undefined` | no |

### <a id="client.installJob.progress"></a>`client.installJob.progress` (event)

Event payload for `client.installJob.progress`.

Emitted by the install job runner at each pipeline stage transition and
whenever the download progress percentage changes materially.

Subject: `client.installJob.progress`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `activeAfterCompletion` | `boolean \| undefined` | no |
| `clientId` | `string` | yes |
| `installPath` | `string \| undefined` | no |
| `jobId` | `string` | yes |
| `metadata` | `Record<string, unknown> \| undefined` | no |
| `progress` | `number \| null` | yes |
| `stage` | `"downloading" \| "resolving" \| "verifying" \| "extracting" \| "installing" \| "post-install" \| "activating"` | yes |
| `strategy` | `"npm" \| "signed-binary-bucket"` | yes |
| `version` | `string \| undefined` | no |

### <a id="client.list"></a>`client.list` (rpc)

Request and response schemas for `client.list`.

Returns the local installation inventory for all managed clients, including
their pinned version and whether the active version matches the current pin.

Subject: `client.list`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `forceRefresh` | `boolean \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `clients` | `{ clientId: string; installedVersions: { version: string; installPath: string; installedAt: number; isActive: boolean; }[]; activeVersion: string \| null; pinnedVersion: string; updateAvailable: boolean; }[]` | yes |

### <a id="client.profile.create"></a>`client.profile.create` (rpc)

Create a new profile for a client.

Subject: `client.profile.create`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `clientId` | `string` | yes |
| `description` | `string \| undefined` | no |
| `name` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `profile` | `{ id: string; clientId: string; name: string; description: string \| null; configDir: string; isDefault: boolean; createdAt: number; updatedAt: number; }` | yes |

### <a id="client.profile.delete"></a>`client.profile.delete` (rpc)

Delete a profile by client ID and name.

Subject: `client.profile.delete`
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

### <a id="client.profile.get"></a>`client.profile.get` (rpc)

Get a profile by client ID and name.

Returns `null` in the response when no matching profile exists rather
than throwing, so callers can handle the absent-profile case inline.

Subject: `client.profile.get`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `clientId` | `string` | yes |
| `name` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `profile` | `{ id: string; clientId: string; name: string; description: string \| null; configDir: string; isDefault: boolean; createdAt: number; updatedAt: number; } \| null` | yes |

### <a id="client.profile.list"></a>`client.profile.list` (rpc)

List all profiles for a client.

Subject: `client.profile.list`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `clientId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `profiles` | `{ id: string; clientId: string; name: string; description: string \| null; configDir: string; isDefault: boolean; createdAt: number; updatedAt: number; }[]` | yes |

### <a id="client.profile.setDefault"></a>`client.profile.setDefault` (rpc)

Mark a profile as the default for its client.

Subject: `client.profile.setDefault`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `clientId` | `string` | yes |
| `name` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `profile` | `{ id: string; clientId: string; name: string; description: string \| null; configDir: string; isDefault: boolean; createdAt: number; updatedAt: number; }` | yes |

### <a id="client.profile.update"></a>`client.profile.update` (rpc)

Update an existing profile's mutable fields.

Subject: `client.profile.update`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `clientId` | `string` | yes |
| `description` | `string \| undefined` | no |
| `name` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `profile` | `{ id: string; clientId: string; name: string; description: string \| null; configDir: string; isDefault: boolean; createdAt: number; updatedAt: number; }` | yes |

### <a id="client.resolveBinary"></a>`client.resolveBinary` (rpc)

Request and response schemas for `client.resolveBinary`.

Resolves the binary path, environment overrides, and config directory for a
given client. The response is everything a caller needs to spawn the binary.

Phase 2 optional fields (`sessionId`, `projectDir`, `preferSource`,
`harnessId`) are declared now as seams so the handler contract is stable
before the implementations land.

Subject: `client.resolveBinary`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `clientId` | `string` | yes |
| `harnessId` | `string \| undefined` | no |
| `preferSource` | `"global" \| "managed" \| undefined` | no |
| `projectDir` | `string \| undefined` | no |
| `sessionId` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `binaryPath` | `string \| null` | yes |
| `configDir` | `string \| null` | yes |
| `env` | `Record<string, string>` | yes |
| `source` | `"global" \| "managed"` | yes |
| `version` | `string \| null` | yes |

### <a id="client.runtime.observe"></a>`client.runtime.observe` (rpc)

Request and response schemas for `client.runtime.observe`.

Callers send this request when they detect that a client runtime has started.
The handler upserts a `ClientRuntime` record and returns a stable
`clientRuntimeId` together with flags indicating whether the record was
created or promoted to a richer state.

Hard-evidence invariant: at least one of `supervisorSessionId`, `pid`, or
`adapterSessionId` must be present. Enforced via `.refine()` on the request
schema (not on the shared evidence base, which stays composable).

Subject: `client.runtime.observe`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterSessionId` | `string \| undefined` | no |
| `argv` | `string[] \| undefined` | no |
| `clientId` | `string` | yes |
| `cwd` | `string \| undefined` | no |
| `metadata` | `Record<string, unknown> \| undefined` | no |
| `observedAt` | `number` | yes |
| `parentPid` | `number \| undefined` | no |
| `pid` | `number \| undefined` | no |
| `sessionId` | `string \| undefined` | no |
| `source` | `{ layer: "adapter" \| "supervisor" \| "client-hook" \| "statusline" \| "cli-wrapper"; producer: string; }` | yes |
| `supervisorSessionId` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `clientRuntimeId` | `string` | yes |
| `created` | `boolean` | yes |
| `promoted` | `boolean` | yes |

### <a id="client.runtime.started"></a>`client.runtime.started` (event)

Payload for `client.runtime.started`.

Emitted by the runtime-observe service after a `client.runtime.observe` request
has been handled and a runtime record has been created or confirmed. Listeners
can react to this event without coupling to the observe handler.

Hard-evidence invariant: at least one of `supervisorSessionId`, `pid`, or
`adapterSessionId` is present (guaranteed by the observe handler before emit).

Subject: `client.runtime.started`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `adapterSessionId` | `string \| undefined` | no |
| `argv` | `string[] \| undefined` | no |
| `clientId` | `string` | yes |
| `clientRuntimeId` | `string` | yes |
| `cwd` | `string \| undefined` | no |
| `metadata` | `Record<string, unknown> \| undefined` | no |
| `observedAt` | `number` | yes |
| `parentPid` | `number \| undefined` | no |
| `pid` | `number \| undefined` | no |
| `sessionId` | `string \| undefined` | no |
| `source` | `{ layer: "adapter" \| "supervisor" \| "client-hook" \| "statusline" \| "cli-wrapper"; producer: string; }` | yes |
| `status` | `"started" \| "observed"` | yes |
| `supervisorSessionId` | `string \| undefined` | no |

### <a id="client.scan"></a>`client.scan` (rpc)

Subject: `client.scan`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `targets` | `{ clientId: string; binaryName: string; supportedVersions?: string \| undefined; }[] \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `results` | `{ clientId: string; found: boolean; version?: string \| undefined; warningMessage?: string \| undefined; }[]` | yes |

### <a id="client.session.account.observe"></a>`client.session.account.observe` (rpc)

Request and response schemas for client.session.account.observe.

Subject: `client.session.account.observe`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `clientId` | `string` | yes |
| `kind` | `string` | yes |
| `locator` | `{ kind: "session"; sessionId: string; } \| { kind: "adapter-session"; adapterSessionId: string; } \| { kind: "both"; sessionId: string; adapterSessionId: string; }` | yes |
| `observedAt` | `number` | yes |
| `payload` | `unknown` | yes |
| `source` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `changed` | `boolean` | yes |
| `clientAccountId` | `string \| null` | yes |
| `handled` | `boolean` | yes |
| `sessionId` | `string \| null` | yes |

### <a id="client.session.started"></a>`client.session.started` (event)

Payload for `client.session.started`.

Emitted when an adapter observes that a new client session has begun.
This is a normalized observed signal — not a command. The session may not
yet be linked to a framework session at emission time.

Subject: `client.session.started`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `adapterSessionId` | `string \| undefined` | no |
| `clientId` | `string` | yes |
| `metadata` | `Record<string, unknown> \| undefined` | no |
| `observedAt` | `number` | yes |
| `sessionId` | `string \| undefined` | no |
| `source` | `string` | yes |

### <a id="client.session.tool.post"></a>`client.session.tool.post` (event)

Payload for `client.session.tool.post`.

Emitted when an adapter observes that a tool call has completed inside the
client runtime. The `success` field reflects the outcome when the adapter
can determine it.

Subject: `client.session.tool.post`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `adapterSessionId` | `string \| undefined` | no |
| `clientId` | `string` | yes |
| `metadata` | `Record<string, unknown> \| undefined` | no |
| `observedAt` | `number` | yes |
| `sessionId` | `string \| undefined` | no |
| `source` | `string` | yes |
| `success` | `boolean \| undefined` | no |
| `toolCallId` | `string \| undefined` | no |
| `toolName` | `string \| undefined` | no |

### <a id="client.session.tool.pre"></a>`client.session.tool.pre` (event)

Payload for `client.session.tool.pre`.

Emitted when an adapter observes that a tool call is about to be executed
by the client runtime. The `toolName` and `toolCallId` fields identify the
specific invocation when the adapter has access to them.

Subject: `client.session.tool.pre`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `adapterSessionId` | `string \| undefined` | no |
| `clientId` | `string` | yes |
| `metadata` | `Record<string, unknown> \| undefined` | no |
| `observedAt` | `number` | yes |
| `sessionId` | `string \| undefined` | no |
| `source` | `string` | yes |
| `toolCallId` | `string \| undefined` | no |
| `toolName` | `string \| undefined` | no |

### <a id="client.session.turn.completed"></a>`client.session.turn.completed` (event)

Payload for `client.session.turn.completed`.

Emitted when an adapter observes that an assistant turn has finished inside
an ongoing client session.

Subject: `client.session.turn.completed`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `adapterSessionId` | `string \| undefined` | no |
| `clientId` | `string` | yes |
| `metadata` | `Record<string, unknown> \| undefined` | no |
| `observedAt` | `number` | yes |
| `sessionId` | `string \| undefined` | no |
| `source` | `string` | yes |

### <a id="client.session.turn.started"></a>`client.session.turn.started` (event)

Payload for `client.session.turn.started`.

Emitted when an adapter observes the beginning of an assistant turn inside
an ongoing client session.

Subject: `client.session.turn.started`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `adapterSessionId` | `string \| undefined` | no |
| `clientId` | `string` | yes |
| `metadata` | `Record<string, unknown> \| undefined` | no |
| `observedAt` | `number` | yes |
| `sessionId` | `string \| undefined` | no |
| `source` | `string` | yes |

### <a id="client.session.userPrompt.submitted"></a>`client.session.userPrompt.submitted` (event)

Payload for `client.session.userPrompt.submitted`.

Emitted when an adapter observes that the user has submitted a prompt to
the client runtime. The `prompt` field carries the raw prompt text when
the adapter has access to it.

Subject: `client.session.userPrompt.submitted`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `adapterSessionId` | `string \| undefined` | no |
| `clientId` | `string` | yes |
| `metadata` | `Record<string, unknown> \| undefined` | no |
| `observedAt` | `number` | yes |
| `prompt` | `string \| undefined` | no |
| `sessionId` | `string \| undefined` | no |
| `source` | `string` | yes |

### <a id="client.sessionConfig.cleanup"></a>`client.sessionConfig.cleanup` (rpc)

Clean up stale session config directories.

When `clientId` is supplied only that client's orphaned directories are
removed; omit it to clean across all clients.

Subject: `client.sessionConfig.cleanup`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `clientId` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `removed` | `string[]` | yes |

### <a id="client.sessionConfig.create"></a>`client.sessionConfig.create` (rpc)

Create an isolated configuration directory for a session.

The service seeds the directory from the named profile (or the client
default when `profileName` is omitted) and returns the path together
with any environment variables the client process should inherit.

Subject: `client.sessionConfig.create`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `baseConfigDir` | `string \| undefined` | no |
| `clientId` | `string` | yes |
| `configInheritance` | `"auth-only" \| "full" \| "empty" \| undefined` | no |
| `profileName` | `string \| undefined` | no |
| `projectDir` | `string \| undefined` | no |
| `sessionId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `env` | `Record<string, string>` | yes |
| `sessionDir` | `string` | yes |

### <a id="client.sessionConfig.destroy"></a>`client.sessionConfig.destroy` (rpc)

Destroy the isolated configuration directory for a session.

Subject: `client.sessionConfig.destroy`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `clientId` | `string` | yes |
| `sessionId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `success` | `boolean` | yes |

### <a id="client.setActive"></a>`client.setActive` (rpc)

Request and response schemas for `client.setActive`.

Switches the active binary pointer to an already-installed version.
The requested version must be present on disk; the handler will reject
requests for versions that have not been installed.

Subject: `client.setActive`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `clientId` | `string` | yes |
| `version` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `activeVersion` | `string` | yes |
| `clientId` | `string` | yes |

### <a id="client.uninstall"></a>`client.uninstall` (rpc)

Request and response schemas for `client.uninstall`.

Removes a specific installed version of a managed client binary.
If the removed version was active, the active pointer is cleared to `null`
— no automatic replacement is made. Callers must explicitly call
`client.setActive` to promote another installed version.

Subject: `client.uninstall`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `clientId` | `string` | yes |
| `version` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `activeVersion` | `string \| null` | yes |
| `clientId` | `string` | yes |
| `removedVersion` | `string` | yes |

### <a id="client.update"></a>`client.update` (rpc)

Request and response schemas for `client.update`.

Enqueues an update job that installs the client package pin and activates it.
Callers can track progress via `client.installJob.progress` and
`client.installJob.completed` events using the returned `jobId`.

Subject: `client.update`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `clientId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `jobId` | `string` | yes |
| `resolvedVersion` | `string \| null` | yes |

### <a id="client.usage.ingest"></a>`client.usage.ingest` (rpc)

Request and response schemas for client.usage.ingest.

Subject: `client.usage.ingest`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `account` | `{ identifiers: { scheme: string; value: string; strength: "strong" \| "alias"; }[]; displayLabel?: string \| undefined; }` | yes |
| `clientId` | `string` | yes |
| `metadata` | `Record<string, unknown> \| undefined` | no |
| `observedAt` | `number` | yes |
| `source` | `string` | yes |
| `usage` | `{ windows: { key: string; label: string; usedPercentage: number; resetsAt?: number \| undefined; }[]; }` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `clientAccountId` | `string` | yes |
| `snapshot` | `{ clientAccountId: string; clientId: string; observedAt: number; source: string; usage: { windows: { key: string; label: string; usedPercentage: number; resetsAt?: number \| undefined; }[]; }; displayLabel?: string \| undefined; metadata?: Record<string, unknown> \| undefined; }` | yes |

### <a id="client.usage.snapshot"></a>`client.usage.snapshot` (event)

Canonical usage snapshot emitted after stitching identity and usage.

Subject: `client.usage.snapshot`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `clientAccountId` | `string` | yes |
| `clientId` | `string` | yes |
| `displayLabel` | `string \| undefined` | no |
| `metadata` | `Record<string, unknown> \| undefined` | no |
| `observedAt` | `number` | yes |
| `source` | `string` | yes |
| `usage` | `{ windows: { key: string; label: string; usedPercentage: number; resetsAt?: number \| undefined; }[]; }` | yes |

### <a id="client.version.changed"></a>`client.version.changed` (event)

Event payload for `client.version.changed`.

Emitted whenever the active-version pointer for a managed client changes,
regardless of the operation that caused the change.

Subject: `client.version.changed`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `activeVersion` | `string \| null` | yes |
| `clientId` | `string` | yes |
| `previousActiveVersion` | `string \| null` | yes |
| `reason` | `"update" \| "install" \| "uninstall" \| "set-active"` | yes |

### <a id="client.wiring.list"></a>`client.wiring.list` (rpc)

Subject: `client.wiring.list`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `clientId` | `string \| undefined` | no |
| `makaioCommand` | `string` | yes |
| `projectDir` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `results` | `{ clientId: string; entries: { group: string; name: string; installed: boolean; command: string; }[]; }[]` | yes |

---

*Auto-generated by `yarn docs:bus`. Do not edit manually.*
