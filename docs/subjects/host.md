---
title: "host"
editUrl: false
prev: false
next: false
---

# `host`

| Field | Value |
|-------|-------|
| Prefix | `host` |
| Namespace constant | `HostNamespace` |
| Subjects constant | `HostSubjects` |
| Kind | bus |
| Schema record | `HostSchemas` |
| Tier | framework |
| Package | `@makaio/contracts` |
| Defined in | [`packages/contracts/src/host/namespace.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/contracts/src/host/namespace.ts) |

## Subjects

| Key | Wire | Type | Schema |
|-----|------|------|--------|
| `app.focus` | [`host.app.focus`](#host.app.focus) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/contracts/src/host/schemas.ts) |
| `tray.activate` | [`host.tray.activate`](#host.tray.activate) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/contracts/src/host/schemas.ts) |
| `window.closed` | [`host.window.closed`](#host.window.closed) | event | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/contracts/src/host/schemas.ts) |
| `window.create` | [`host.window.create`](#host.window.create) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/contracts/src/host/schemas.ts) |
| `window.focus` | [`host.window.focus`](#host.window.focus) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/contracts/src/host/schemas.ts) |
| `window.labelChanged` | [`host.window.labelChanged`](#host.window.labelChanged) | event | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/contracts/src/host/schemas.ts) |
| `window.list` | [`host.window.list`](#host.window.list) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/contracts/src/host/schemas.ts) |
| `window.openDashboard` | [`host.window.openDashboard`](#host.window.openDashboard) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/contracts/src/host/schemas.ts) |
| `window.opened` | [`host.window.opened`](#host.window.opened) | event | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/contracts/src/host/schemas.ts) |

## Subject Details

### <a id="host.app.focus"></a>`host.app.focus` (rpc)

Focus the application: bring an existing window to front, or open the
default shell window if none are open.

Used by: second-instance detection (Electrobun health-probe),
`makaio open` CLI command, Electron `second-instance` event.

Subject: `host.app.focus`
Type: Request (RPC)

**Request:**

_Empty object._

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `focused` | `boolean` | yes |
| `windowId` | `number \| null` | yes |

### <a id="host.tray.activate"></a>`host.tray.activate` (rpc)

Activate the tray popover panel. Fired when the user
left-clicks the tray icon.

The response tells whether the host handled the click.
When `handled` is `true`, suppress the native menu.
This is `true` for both showing and dismissing the popover (toggle).

Subject: `host.tray.activate`
Type: Request (RPC)

**Request:**

_Empty object._

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `handled` | `boolean` | yes |

### <a id="host.window.closed"></a>`host.window.closed` (event)

Emitted when a desktop window is closed.

Subject: `host.window.closed`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `params` | `Record<string, string> \| undefined` | no |
| `registrationId` | `string` | yes |
| `windowId` | `number` | yes |

### <a id="host.window.create"></a>`host.window.create` (rpc)

Create a new desktop window identified by its registry registration ID.

Subject: `host.window.create`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `params` | `Record<string, string> \| undefined` | no |
| `registrationId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `windowId` | `number` | yes |

### <a id="host.window.focus"></a>`host.window.focus` (rpc)

Focus an existing window. If no `windowId` is provided, focuses the
most recently active window.

Subject: `host.window.focus`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `windowId` | `number \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `success` | `boolean` | yes |

### <a id="host.window.labelChanged"></a>`host.window.labelChanged` (event)

Emitted by the web UI when a window's display label changes — for example,
when a project name becomes available or when the first message of a chat
session is typed.

The host main process listens for this event and calls
`WindowManager.updateLabel` so the internal registry stays current.
Because the event is on the shared bus, the tray handler can also
react to it (e.g. to update the tray menu item label) without any
additional wiring.

Subject: `host.window.labelChanged`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `label` | `string` | yes |
| `windowId` | `number` | yes |

### <a id="host.window.list"></a>`host.window.list` (rpc)

List all currently open desktop windows with their current state.

Subject: `host.window.list`
Type: Request (RPC)

**Request:**

_Empty object._

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `windows` | `{ windowId: number; registrationId: string; visible: boolean; focused: boolean; params?: Record<string, string> \| undefined; label?: string \| undefined; }[]` | yes |

### <a id="host.window.openDashboard"></a>`host.window.openDashboard` (rpc)

Open (or focus) the primary dashboard window managed by the host shell.

Request: empty — the handler knows the dashboard registration ID.
Response: `windowId` — the host-assigned window ID, or `null` when no
window could be created or focused.

Subject: `host.window.openDashboard`
Type: Request (RPC)

**Request:**

_Empty object._

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `windowId` | `number \| null` | yes |

### <a id="host.window.opened"></a>`host.window.opened` (event)

Emitted when a new desktop window is opened.

Subject: `host.window.opened`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `focused` | `boolean` | yes |
| `label` | `string \| undefined` | no |
| `params` | `Record<string, string> \| undefined` | no |
| `registrationId` | `string` | yes |
| `visible` | `boolean` | yes |
| `windowId` | `number` | yes |

---

*Auto-generated by `yarn docs:bus`. Do not edit manually.*
