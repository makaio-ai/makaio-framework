---
title: "kernel"
editUrl: false
prev: false
next: false
---

# `kernel`

| Field | Value |
|-------|-------|
| Prefix | `kernel` |
| Namespace constant | `KernelNamespace` |
| Subjects constant | `KernelSubjects` |
| Kind | bus |
| Schema record | `KernelSchemas` |
| Tier | framework |
| Package | `@makaio/kernel` |
| Defined in | [`packages/kernel/src/namespace/index.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/kernel/src/namespace/index.ts) |

## Subjects

| Key | Wire | Type | Schema |
|-----|------|------|--------|
| `isReady` | [`kernel.isReady`](#kernel.isReady) | rpc | [`kernel-schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/kernel/src/namespace/kernel-schemas.ts) |
| `lifecycle.shutdown` | [`kernel.lifecycle.shutdown`](#kernel.lifecycle.shutdown) | rpc | [`kernel-schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/kernel/src/namespace/kernel-schemas.ts) |
| `lifecycle.start` | [`kernel.lifecycle.start`](#kernel.lifecycle.start) | rpc | [`kernel-schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/kernel/src/namespace/kernel-schemas.ts) |
| `phase.busCreated` | [`kernel.phase.busCreated`](#kernel.phase.busCreated) | event | [`kernel-schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/kernel/src/namespace/kernel-schemas.ts) |
| `phase.coordinatorReady` | [`kernel.phase.coordinatorReady`](#kernel.phase.coordinatorReady) | rpc | [`kernel-schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/kernel/src/namespace/kernel-schemas.ts) |
| `phase.coreReady` | [`kernel.phase.coreReady`](#kernel.phase.coreReady) | event | [`kernel-schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/kernel/src/namespace/kernel-schemas.ts) |
| `phase.servicesReady` | [`kernel.phase.servicesReady`](#kernel.phase.servicesReady) | event | [`kernel-schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/kernel/src/namespace/kernel-schemas.ts) |
| `ready` | [`kernel.ready`](#kernel.ready) | event | [`kernel-schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/kernel/src/namespace/kernel-schemas.ts) |

## Subject Details

### <a id="kernel.isReady"></a>`kernel.isReady` (rpc)

Probe kernel readiness state.

Subject: `kernel.isReady`
Type: Request (RPC)
Purpose: Allows clients that connect after startup to query readiness
         without waiting for the one-time `kernel.ready` event.

**Request:**

_Empty object._

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `machineId` | `string` | yes |
| `ready` | `boolean` | yes |

### <a id="kernel.lifecycle.shutdown"></a>`kernel.lifecycle.shutdown` (rpc)

Notify observers that lifecycle wiring shutdown has completed.

Subject: `kernel.lifecycle.shutdown`
Type: Request (RPC)
Purpose: Used as an observability/synchronization hook.
         Package teardown is performed by the extension coordinator, not by
         handlers on this subject.

**Request:**

_Empty object._

**Response:**

_Empty object._

### <a id="kernel.lifecycle.start"></a>`kernel.lifecycle.start` (rpc)

Notify observers that lifecycle wiring has completed.

Subject: `kernel.lifecycle.start`
Type: Request (RPC)
Purpose: Used as an observability/synchronization hook.
         Package startup is performed by the extension coordinator, not by
         handlers on this subject.

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `machineId` | `string` | yes |

**Response:**

_Empty object._

### <a id="kernel.phase.busCreated"></a>`kernel.phase.busCreated` (event)

Signal that the bus has been created and is ready for use.

Subject: `kernel.phase.busCreated`
Type: Event (fire-and-forget)
Purpose: Emitted immediately after bus creation so early external observers
         (e.g., transport bridges) can attach before config or services start.

| Field | Type | Required |
|-------|------|----------|
| `machineId` | `string` | yes |

### <a id="kernel.phase.coordinatorReady"></a>`kernel.phase.coordinatorReady` (rpc)

Lifecycle barrier emitted after the extension coordinator has started all
loaded packages.

Subject: `kernel.phase.coordinatorReady`
Type: Broadcast request
Purpose: Allows host-owned integrations to finish post-coordinator wiring
         before the kernel announces full readiness.

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `machineId` | `string` | yes |

**Response:**

_Empty object._

### <a id="kernel.phase.coreReady"></a>`kernel.phase.coreReady` (event)

Signal that the bus, config service, and runtime-host resource handlers are ready.

Subject: `kernel.phase.coreReady`
Type: Event (fire-and-forget)
Purpose: Emitted after bus creation, config service registration, and runtime
         resource provider registration — before lifecycle wiring begins.
         External transports (e.g., WebSocket bus server) hook in here so they
         have bus and machine identity but are available before full service readiness.

| Field | Type | Required |
|-------|------|----------|
| `machineId` | `string` | yes |

### <a id="kernel.phase.servicesReady"></a>`kernel.phase.servicesReady` (event)

Signal that lifecycle wiring and lifecycle.start have completed.

Subject: `kernel.phase.servicesReady`
Type: Event (fire-and-forget)
Purpose: Emitted after `startLifecycleWiring` and `lifecycle.start` complete.
         All core services are registered and ready to handle requests at this point.

| Field | Type | Required |
|-------|------|----------|
| `machineId` | `string` | yes |

### <a id="kernel.ready"></a>`kernel.ready` (event)

Signal that the kernel has completed initialization.

Subject: `kernel.ready`
Type: Event (fire-and-forget)
Purpose: SharedWorker waits for this before considering the backend ready.
         Eliminates the handler registration race where tabs send requests
         before registerRuntimeHandlers() completes.

| Field | Type | Required |
|-------|------|----------|
| `machineId` | `string` | yes |

---

*Auto-generated by `yarn docs:bus`. Do not edit manually.*
