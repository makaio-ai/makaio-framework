---
title: "native-session-supervisor"
editUrl: false
prev: false
next: false
---

# `native-session-supervisor`

| Field | Value |
|-------|-------|
| Prefix | `native-session-supervisor` |
| Namespace constant | `NativeSessionSupervisorNamespace` |
| Subjects constant | `NativeSessionSupervisorSubjects` |
| Kind | bus |
| Schema record | `NativeSessionSupervisorSchemas` |
| Tier | framework |
| Package | `@makaio/contracts` |
| Defined in | [`core/contracts/src/native-session-supervisor/namespace.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/native-session-supervisor/namespace.ts) |

## Subjects

| Key | Wire | Type | Schema |
|-----|------|------|--------|
| `attach` | [`native-session-supervisor.attach`](#native-session-supervisor.attach) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/native-session-supervisor/schemas.ts) |
| `launch` | [`native-session-supervisor.launch`](#native-session-supervisor.launch) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/native-session-supervisor/schemas.ts) |
| `status` | [`native-session-supervisor.status`](#native-session-supervisor.status) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/native-session-supervisor/schemas.ts) |
| `stop` | [`native-session-supervisor.stop`](#native-session-supervisor.stop) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/native-session-supervisor/schemas.ts) |

## Subject Details

### <a id="native-session-supervisor.attach"></a>`native-session-supervisor.attach` (rpc)

Request and response schemas for `native-session-supervisor.attach`.

Requests attachment to an already-supervised runtime, identified by one of
the three available locators.

Subject: `native-session-supervisor.attach`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterSessionId` | `string \| undefined` | no |
| `sessionId` | `string \| undefined` | no |
| `supervisorSessionId` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `pid` | `number \| undefined` | no |
| `success` | `boolean` | yes |
| `supervisorSessionId` | `string \| undefined` | no |
| `terminalAttachment` | `{ canAttach: boolean; } \| undefined` | no |

### <a id="native-session-supervisor.launch"></a>`native-session-supervisor.launch` (rpc)

Request and response schemas for `native-session-supervisor.launch`.

Launches a new supervised native process and returns a stable supervisor
session ID together with the OS process ID of the spawned process.

Subject: `native-session-supervisor.launch`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterSessionId` | `string \| undefined` | no |
| `args` | `string[]` | yes |
| `clientId` | `string` | yes |
| `clientProfileName` | `string \| undefined` | no |
| `command` | `string` | yes |
| `cwd` | `string` | yes |
| `env` | `Record<string, string> \| undefined` | no |
| `metadata` | `Record<string, unknown> \| undefined` | no |
| `sessionId` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `pid` | `number` | yes |
| `supervisorSessionId` | `string` | yes |

### <a id="native-session-supervisor.status"></a>`native-session-supervisor.status` (rpc)

Request and response schemas for `native-session-supervisor.status`.

Queries status for one or all supervised runtimes.

The request accepts exactly zero or one locator field:
- No locator — returns all known runtimes.
- One locator — returns the single runtime matching that field.

Providing more than one locator is rejected by the schema so that callers
cannot rely on an undocumented priority ordering between fields.

Subject: `native-session-supervisor.status`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterSessionId` | `string \| undefined` | no |
| `sessionId` | `string \| undefined` | no |
| `supervisorSessionId` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `runtimes` | `{ supervisorSessionId: string; clientId: string; pid: number \| null; status: "unknown" \| "exited" \| "running" \| "stopped"; cwd: string; startedAt: number; sessionId?: string \| undefined; adapterSessionId?: string \| undefined; stoppedAt?: number \| undefined; }[]` | yes |

### <a id="native-session-supervisor.stop"></a>`native-session-supervisor.stop` (rpc)

Request and response schemas for `native-session-supervisor.stop`.

Stops a supervised runtime process identified by its supervisor session ID.

Subject: `native-session-supervisor.stop`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `signal` | `string \| undefined` | no |
| `supervisorSessionId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `success` | `boolean` | yes |

---

*Auto-generated by `yarn docs:bus`. Do not edit manually.*
