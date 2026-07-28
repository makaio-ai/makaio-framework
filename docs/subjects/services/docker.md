---
title: "docker"
editUrl: false
prev: false
next: false
---

# `docker`

| Field | Value |
|-------|-------|
| Prefix | `docker` |
| Namespace constant | `DockerNamespace` |
| Subjects constant | `DockerSubjects` |
| Kind | bus |
| Schema record | `DockerSchemas` |
| Tier | framework |
| Package | `@makaio/services-core` |
| Defined in | [`services/core/src/execution-target/container-namespace.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/execution-target/container-namespace.ts) |

## Subjects

| Key | Wire | Type | Schema |
|-----|------|------|--------|
| `bootstrap.getChannelToken` | [`docker.bootstrap.getChannelToken`](#docker.bootstrap.getChannelToken) | rpc | — |
| `bootstrap.spawn` | [`docker.bootstrap.spawn`](#docker.bootstrap.spawn) | rpc | — |
| `container.created` | [`docker.container.created`](#docker.container.created) | event | [`container-schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/execution-target/container-schemas.ts) |
| `container.destroyed` | [`docker.container.destroyed`](#docker.container.destroyed) | event | [`container-schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/execution-target/container-schemas.ts) |
| `container.spawn` | [`docker.container.spawn`](#docker.container.spawn) | rpc | — |
| `container.started` | [`docker.container.started`](#docker.container.started) | event | [`container-schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/execution-target/container-schemas.ts) |
| `container.status` | [`docker.container.status`](#docker.container.status) | rpc | — |
| `container.stop` | [`docker.container.stop`](#docker.container.stop) | rpc | — |
| `container.stopped` | [`docker.container.stopped`](#docker.container.stopped) | event | [`container-schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/execution-target/container-schemas.ts) |

## Subject Details

### <a id="docker.bootstrap.getChannelToken"></a>`docker.bootstrap.getChannelToken` (rpc)

Return the process-local bootstrap channel bearer capability.

Subject: `docker.bootstrap.getChannelToken`
Type: Request (RPC)

**Request:**

_Empty object._

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `token` | `string` | yes |

### <a id="docker.bootstrap.spawn"></a>`docker.bootstrap.spawn` (rpc)

Atomically spawn from a public descriptor plus encrypted bootstrap data.
Channel-only because the request contains resolved plaintext secrets.

Subject: `docker.bootstrap.spawn`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `bootstrapConfig` | `{ busAuthSecret?: string \| undefined; gitToken?: string \| undefined; runtimeEnv?: Record<string, string> \| undefined; sessionRuntime?: Readonly<{ machineId: string; packageNames: readonly string[]; }> \| undefined; adapterAuth?: Readonly<{ selector: Readonly<{ sessionId: string; adapterName: string; providerConfigId: string; definitionId: string; runtime: Readonly<{ machineId: string; packageNames: readonly string[]; }>; auth: Readonly<{ mode: "none" \| "explicit"; method: { owner: "provider"; providerDefinitionId: string; methodId: string; } \| { owner: "client"; clientId: string; methodId: string; }; }>; }>; scrubEnvVars: readonly string[]; processEnv: Readonly<Record<string, string>>; connectorDeliveries: readonly Readonly<{ target: string; values: Readonly<Record<string, string \| number \| boolean \| null>>; }>[]; }> \| undefined; }` | yes |
| `descriptor` | `{ sessionId: string; adapter: string; mode: "container-local"; repoPath: string; baseBranch: string; runtime?: "full" \| "simple" \| undefined; image?: string \| undefined; worktreeBranch?: string \| undefined; } \| { sessionId: string; adapter: string; mode: "container-local"; repoPath: string; baseBranch: string; executionId: string; executionAttemptId: string; runtime?: "full" \| "simple" \| undefined; image?: string \| undefined; worktreeBranch?: string \| undefined; } \| { sessionId: string; adapter: string; mode: "container-isolated"; repoUrl: string; runtime?: "full" \| "simple" \| undefined; image?: string \| undefined; branch?: string \| undefined; }` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `containerId` | `string` | yes |
| `worktreeBranch` | `string \| undefined` | no |
| `worktreePath` | `string \| undefined` | no |

### <a id="docker.container.created"></a>`docker.container.created` (event)

Container created event.

Subject: `docker.container.created`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `containerId` | `string` | yes |
| `sessionId` | `string` | yes |
| `worktreePath` | `string \| undefined` | no |

### <a id="docker.container.destroyed"></a>`docker.container.destroyed` (event)

Container destroyed event.

Subject: `docker.container.destroyed`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `containerId` | `string` | yes |
| `sessionId` | `string` | yes |

### <a id="docker.container.spawn"></a>`docker.container.spawn` (rpc)

Spawn a container from one mode-specific public descriptor.

`container-local` requires `repoPath` and `baseBranch`.
`container-isolated` requires `repoUrl`. Fields belonging
only to the other mode are rejected by the strict discriminated union.

Subject: `docker.container.spawn`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapter` | `string` | yes |
| `baseBranch` | `string \| undefined` | no |
| `branch` | `string \| undefined` | no |
| `executionAttemptId` | `string \| undefined` | no |
| `executionId` | `string \| undefined` | no |
| `image` | `string \| undefined` | no |
| `mode` | `"container-local" \| "container-isolated"` | yes |
| `repoPath` | `string \| undefined` | no |
| `repoUrl` | `string \| undefined` | no |
| `runtime` | `"full" \| "simple" \| undefined` | no |
| `sessionId` | `string` | yes |
| `worktreeBranch` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `containerId` | `string` | yes |
| `worktreeBranch` | `string \| undefined` | no |
| `worktreePath` | `string \| undefined` | no |

### <a id="docker.container.started"></a>`docker.container.started` (event)

Container started event.

Subject: `docker.container.started`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `containerId` | `string` | yes |
| `sessionId` | `string` | yes |
| `worktreePath` | `string \| undefined` | no |

### <a id="docker.container.status"></a>`docker.container.status` (rpc)

Subject: `docker.container.status`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `containerId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `sessionId` | `string` | yes |
| `state` | `"created" \| "running" \| "stopped" \| "destroyed"` | yes |
| `worktreePath` | `string \| undefined` | no |

### <a id="docker.container.stop"></a>`docker.container.stop` (rpc)

Subject: `docker.container.stop`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `containerId` | `string` | yes |
| `deleteBranch` | `boolean \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `success` | `boolean` | yes |

### <a id="docker.container.stopped"></a>`docker.container.stopped` (event)

Container stopped event.

Subject: `docker.container.stopped`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `containerId` | `string` | yes |
| `exitCode` | `number` | yes |
| `sessionId` | `string` | yes |

---

*Auto-generated by `yarn docs:bus`. Do not edit manually.*
