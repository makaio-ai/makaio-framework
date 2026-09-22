---
title: "kernel:extension"
editUrl: false
prev: false
next: false
---

# `kernel:extension`

| Field | Value |
|-------|-------|
| Prefix | `kernel:extension` |
| Namespace constant | `ExtensionNamespace` |
| Subjects constant | `ExtensionSubjects` |
| Kind | bus |
| Schema record | `ExtensionSchemas` |
| Tier | framework |
| Package | `@makaio/kernel` |
| Defined in | [`packages/kernel/src/observability/extension-namespace.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/kernel/src/observability/extension-namespace.ts) |

## Subjects

| Key | Wire | Type | Schema |
|-----|------|------|--------|
| `catalog` | [`kernel:extension.catalog`](#kernel:extension.catalog) | rpc | — |
| `contributions.catalog` | [`kernel:extension.contributions.catalog`](#kernel:extension.contributions.catalog) | rpc | — |
| `enabledChanged` | [`kernel:extension.enabledChanged`](#kernel:extension.enabledChanged) | event | — |
| `get` | [`kernel:extension.get`](#kernel:extension.get) | rpc | — |
| `list` | [`kernel:extension.list`](#kernel:extension.list) | rpc | — |
| `setEnabled` | [`kernel:extension.setEnabled`](#kernel:extension.setEnabled) | rpc | — |
| `stateChanged` | [`kernel:extension.stateChanged`](#kernel:extension.stateChanged) | event | — |
| `warnings.changed` | [`kernel:extension.warnings.changed`](#kernel:extension.warnings.changed) | event | [`extension-warning.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/extension/extension-warning.ts) |
| `warnings.list` | [`kernel:extension.warnings.list`](#kernel:extension.warnings.list) | rpc | — |

## Subject Details

### <a id="kernel:extension.catalog"></a>`kernel:extension.catalog` (rpc)

Request every extension package installed on the host running this
coordinator.

Subject: `kernel:extension.catalog`
Type: RPC (request/response)
Purpose: Exposes the coordinator host's own installed-package view —
across every discovery tier it reads, including the project-local
`node_modules` of the directory it was started from — enriched with the
enablement facts only the host holding the durable store can answer.
Callers that cannot inspect this host's filesystem (a client configured
against a remote bus, or one invoked from a different working directory)
have no other way to enumerate installed-but-not-loaded extensions, and
`kernel:extension.setEnabled` validates against this same catalog.

Returns `{ entries: null }` — not an empty array — when this runtime has
no installed-extension catalog at all, because "nothing is installed" and
"this host cannot answer" must not read alike to a caller deciding
whether to trust the result.

**Request:**

_Empty object._

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `entries` | `{ name: string; version: string; origin: "local" \| "npm" \| "project-local"; extensionManaged: boolean; critical?: boolean \| undefined; criticalityUnknown?: boolean \| undefined; declaresServerEntrypoint?: boolean \| undefined; npmName?: string \| undefined; surface?: "interactive" \| "headless" \| undefined; shadowedBy?: "local" \| "npm" \| "project-local" \| undefined; collidesWith?: "local" \| "npm" \| "project-local" \| undefined; collisionIgnoresSurface?: boolean \| undefined; persistedEnabled?: boolean \| undefined; }[] \| null` | yes |

### <a id="kernel:extension.contributions.catalog"></a>`kernel:extension.contributions.catalog` (rpc)

Request active extension-owned provider and client contributions.

Subject: `kernel:extension.contributions.catalog`
Type: RPC (request/response)
Purpose: Exposes boot/runtime contribution metadata through a typed bus seam
without passing the coordinator object through lifecycle phase payloads.

**Request:**

_Empty object._

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `clients` | `{ packageName: string; definition: { id: string; name: string; version: string; nativeTools: { name: string; friendlyName: string; capabilities: { tag: string; description?: string \| undefined; }[]; description?: string \| undefined; category?: string \| undefined; }[]; defaultApprovalPolicy: "reject" \| "always-ask" \| "full-access"; authMethods: ({ id: string; mode: "explicit"; label: string; fields: { id: string; label: string; required: boolean; secret: boolean; sourceHints: { kind: "environment"; variable: string; }[]; description?: string \| undefined; }[]; description?: string \| undefined; } \| { id: string; mode: "inferred"; label: string; description?: string \| undefined; } \| { id: string; mode: "none"; label: string; description?: string \| undefined; })[]; runtimeCapabilities: { supportsHooks: boolean; supportsStatusline: boolean; supportsSupervisorLaunch: boolean; supportsManagedBinary: boolean; hookEvents: { name: string; responseCapabilities: readonly string[]; frameworkSubject?: string \| undefined; minimumVersion?: string \| undefined; }[]; }; description?: string \| undefined; binary?: { name: string; supportedVersions: string; } \| undefined; logSources?: { id: string; name: string; description?: string \| undefined; glob?: string \| undefined; }[] \| undefined; defaultAuth?: { providerDefinitionId: string; methodId: string; } \| undefined; managedInstall?: { type: "npm"; package: string; version: string; } \| { type: "signed-binary-bucket"; version: string; config: { baseUrl: string; manifestPathTemplate: string; manifestSignaturePathTemplate: string; publicKeyUrl: string; publicKeyFingerprint: string; binaryPathTemplate: string; platforms: Record<string, string>; }; } \| undefined; versionCommand?: { executable: string \| { default: string; darwin?: string \| undefined; linux?: string \| undefined; win32?: string \| undefined; }; args: string[]; } \| undefined; postInstall?: { kind: string; payload?: Record<string, unknown> \| undefined; } \| undefined; configIsolation?: { envVar: string; defaultPath: string; pathKind: "file" \| "directory"; } \| undefined; }; }[]` | yes |
| `providers` | `{ packageName: string; definition: { id: string; name: string; availableModels: { name: string; contextWindowSize: number; labId: string; friendlyName?: string \| undefined; family?: string \| undefined; supportedReasoningLevels?: { none?: string \| number \| undefined; low?: string \| number \| undefined; medium?: string \| number \| undefined; high?: string \| number \| undefined; 'extra-high'?: string \| number \| undefined; } \| undefined; metadata?: { maxOutputTokens?: number \| undefined; capabilities?: { vision?: boolean \| undefined; toolCalling?: boolean \| undefined; parallelToolCalls?: boolean \| undefined; structuredOutput?: boolean \| undefined; pdfUpload?: boolean \| undefined; speechToText?: { modes: ("batch" \| "streaming")[]; vocabularyBiasing?: boolean \| undefined; } \| undefined; textToSpeech?: { modes: ("streaming" \| "buffered")[]; voiceSelection?: boolean \| undefined; voiceInstructions?: boolean \| undefined; outputFormats?: string[] \| undefined; } \| undefined; } \| undefined; pricing?: { token?: { inputPerMillion: number; outputPerMillion: number; inputCachedPerMillion?: number \| undefined; cacheWritePerMillion?: number \| undefined; } \| undefined; request?: { multiplier: number; } \| undefined; } \| undefined; includedInSubscription?: boolean \| undefined; description?: string \| undefined; } \| undefined; }[]; authMethods: ({ id: string; mode: "explicit"; label: string; fields: { id: string; label: string; required: boolean; secret: boolean; sourceHints: { kind: "environment"; variable: string; }[]; description?: string \| undefined; }[]; description?: string \| undefined; } \| { id: string; mode: "none"; label: string; description?: string \| undefined; })[]; description?: string \| undefined; endpoints?: { anthropic?: string \| undefined; openai?: string \| undefined; } \| undefined; defaultModel?: string \| undefined; fastModel?: string \| undefined; primaryTestModel?: string \| undefined; secondaryTestModel?: string \| undefined; defaultModelFilterMode?: "allowlist" \| "show-all" \| undefined; capabilities?: Record<string, unknown> \| undefined; }; }[]` | yes |

### <a id="kernel:extension.enabledChanged"></a>`kernel:extension.enabledChanged` (event)

Confirm an accepted enable/disable call and the extension's effective state.

Subject: `kernel:extension.enabledChanged`
Type: Event (fire-and-forget)
Purpose: Emitted whenever the coordinator-internal
`applyExtensionTransition` restart primitive accepts an enable/disable
request (its outcome is `'applied'`, never `'rejected'`), so observers
can learn the extension's effective runtime state without polling. This
is **not** a promise that a state transition actually occurred: an
idempotent enable-on-`active` or disable-on-`stopped` call is also
`'applied'` and also announced here, with `entry.enabled` unchanged.
`kernel:extension.setEnabled` does **not** emit this event: that RPC is
persist-only and never attempts a live transition (see its own doc
above), so a durable preference change whose `outcome` is `'applied'` or
`'restart-required'` produces no `enabledChanged` event until whatever
coordinator-internal mechanism actually restarts the extension.

| Field | Type | Required |
|-------|------|----------|
| `enabled` | `boolean` | yes |
| `name` | `string` | yes |

### <a id="kernel:extension.get"></a>`kernel:extension.get` (rpc)

Request info for a single extension by name.

Subject: `kernel:extension.get`
Type: RPC (request/response)
Purpose: Allows targeted lookup of a single extension's state and metadata.
Returns `{ extension: null }` when no extension with the given name is registered.

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `name` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `extension` | `{ name: string; displayName: string; state: "active" \| "discovered" \| "failed" \| "skipped" \| "stopped" \| "initializing"; enabled: boolean; extensionManaged: boolean; critical: boolean; error?: string \| undefined; surface?: "any" \| "interactive" \| "headless" \| undefined; persistedEnabled?: boolean \| undefined; browser?: { entrypoint: string; } \| undefined; } \| null` | yes |

### <a id="kernel:extension.list"></a>`kernel:extension.list` (rpc)

Request the current state of all registered extensions.

Subject: `kernel:extension.list`
Type: RPC (request/response)
Purpose: Allows late subscribers (e.g. CLI status commands, debug panels)
to retrieve the full extension list with current lifecycle states without
waiting for incremental `stateChanged` events.

**Request:**

_Empty object._

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `extensions` | `{ name: string; displayName: string; state: "active" \| "discovered" \| "failed" \| "skipped" \| "stopped" \| "initializing"; enabled: boolean; extensionManaged: boolean; critical: boolean; error?: string \| undefined; surface?: "any" \| "interactive" \| "headless" \| undefined; persistedEnabled?: boolean \| undefined; browser?: { entrypoint: string; } \| undefined; }[]` | yes |

### <a id="kernel:extension.setEnabled"></a>`kernel:extension.setEnabled` (rpc)

Durably record the operator's enablement preference for an extension.

Subject: `kernel:extension.setEnabled`
Type: RPC (request/response)
Purpose: Allows the user or platform config to persist an enable/disable
preference for an extension. This is persist-only: the coordinator never
applies the change to the running process, because several package
contributions are composed exactly once at boot and cannot be replayed
for one package in isolation. The response's `outcome` reports whether
the process's current runtime state already matches the request
(`'applied'`) or a restart is needed for it to take effect
(`'restart-required'`).

Names this coordinator never loaded are addressable too, provided it
exposes an installed-extension catalog (`kernel:extension.catalog`): the
request is validated against that catalog — the name must be installed
here, and a disable of a `critical` package, or of one whose criticality
could not be resolved, is refused — before anything is written. This is
what lets a caller that cannot see this host's filesystem persist a
preference without having to vouch for the name itself. A name several
installed copies claim is resolved against this coordinator's own runtime
surface first, since two copies restricted to different surfaces both load
— each on its own — and only one of them is the copy this runtime would
start; a name that stays unresolvable is refused outright.

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `enabled` | `boolean` | yes |
| `name` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `outcome` | `"applied" \| "rejected" \| "restart-required"` | yes |
| `reason` | `"critical" \| "not-installed" \| "criticality-unknown" \| "no-catalog" \| "name-collision" \| "shutting-down" \| "runtime-state-diverges" \| "not-loaded" \| "framework-package-shadowed" \| undefined` | no |
| `success` | `boolean` | yes |

### <a id="kernel:extension.stateChanged"></a>`kernel:extension.stateChanged` (event)

Signal that an extension has transitioned between lifecycle states.

Subject: `kernel:extension.stateChanged`
Type: Event (fire-and-forget)
Purpose: Emitted by the ExtensionCoordinator whenever an extension moves
from one lifecycle state to another. Observers (e.g. debug logging,
boot progress UI, adapter subsystem) subscribe to track extension health.

| Field | Type | Required |
|-------|------|----------|
| `contributes` | `{ adapters: boolean; tools: boolean; hashTriggers: boolean; providers: boolean; clients: boolean; ui: boolean; storage: boolean; sessionEventActions: boolean; } \| undefined` | no |
| `displayName` | `string` | yes |
| `error` | `string \| undefined` | no |
| `from` | `"active" \| "discovered" \| "failed" \| "skipped" \| "stopped" \| "initializing"` | yes |
| `name` | `string` | yes |
| `to` | `"active" \| "discovered" \| "failed" \| "skipped" \| "stopped" \| "initializing"` | yes |

### <a id="kernel:extension.warnings.changed"></a>`kernel:extension.warnings.changed` (event)

Snapshot of an extension's health warnings after a health-check run.

Subject: `kernel:extension.warnings.changed`
Type: Event (fire-and-forget)
Purpose: Emitted by the ExtensionCoordinator after every health-check run,
regardless of whether the warning set actually changed. This unconditional
emission simplifies subscriber logic — consumers always receive the latest
snapshot without needing to diff against a prior state.

| Field | Type | Required |
|-------|------|----------|
| `extensionName` | `string` | yes |
| `warnings` | `{ severity: "info" \| "degraded" \| "recommended"; title: string; message: string; action?: { kind: "configure-integration"; clientId: string; bundle: string; } \| { kind: "install-extension"; extensionName: string; } \| { kind: "open-url"; url: string; } \| { kind: "run-command"; command: string; } \| undefined; }[]` | yes |

### <a id="kernel:extension.warnings.list"></a>`kernel:extension.warnings.list` (rpc)

Request the current health warnings for all (or a specific) extension.

Subject: `kernel:extension.warnings.list`
Type: RPC (request/response)
Purpose: Allows late subscribers (e.g. notification panels, CLI health
commands) to retrieve a snapshot of active extension warnings without
waiting for incremental `warnings.changed` events.

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `extensionName` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `entries` | `{ extensionName: string; warnings: { severity: "info" \| "degraded" \| "recommended"; title: string; message: string; action?: { kind: "configure-integration"; clientId: string; bundle: string; } \| { kind: "install-extension"; extensionName: string; } \| { kind: "open-url"; url: string; } \| { kind: "run-command"; command: string; } \| undefined; }[]; }[]` | yes |

---

*Auto-generated by `yarn docs:bus`. Do not edit manually.*
