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
| `contributions.catalog` | [`kernel:extension.contributions.catalog`](#kernel:extension.contributions.catalog) | rpc | — |
| `enabledChanged` | [`kernel:extension.enabledChanged`](#kernel:extension.enabledChanged) | event | — |
| `get` | [`kernel:extension.get`](#kernel:extension.get) | rpc | — |
| `list` | [`kernel:extension.list`](#kernel:extension.list) | rpc | — |
| `setEnabled` | [`kernel:extension.setEnabled`](#kernel:extension.setEnabled) | rpc | — |
| `stateChanged` | [`kernel:extension.stateChanged`](#kernel:extension.stateChanged) | event | — |
| `warnings.changed` | [`kernel:extension.warnings.changed`](#kernel:extension.warnings.changed) | event | [`extension-warning.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/extension/extension-warning.ts) |
| `warnings.list` | [`kernel:extension.warnings.list`](#kernel:extension.warnings.list) | rpc | — |

## Subject Details

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
| `clients` | `{ packageName: string; definition: { id: string; name: string; version: string; nativeTools: { name: string; friendlyName: string; capabilities: { tag: string; description?: string \| undefined; }[]; description?: string \| undefined; category?: string \| undefined; }[]; defaultApprovalPolicy: "reject" \| "always-ask" \| "full-access"; runtimeCapabilities: { supportsHooks: boolean; supportsStatusline: boolean; supportsSupervisorLaunch: boolean; supportsManagedBinary: boolean; hookEvents: { name: string; frameworkSubject?: string \| undefined; }[]; }; description?: string \| undefined; binary?: { name: string; supportedVersions: string; } \| undefined; logSources?: { id: string; name: string; description?: string \| undefined; glob?: string \| undefined; }[] \| undefined; defaultProviderId?: string \| undefined; managedInstall?: { type: "npm"; package: string; version: string; } \| { type: "signed-binary-bucket"; version: string; config: { baseUrl: string; manifestPathTemplate: string; manifestSignaturePathTemplate: string; publicKeyUrl: string; publicKeyFingerprint: string; binaryPathTemplate: string; platforms: Record<string, string>; }; } \| undefined; versionCommand?: { executable: string \| { default: string; darwin?: string \| undefined; linux?: string \| undefined; win32?: string \| undefined; }; args: string[]; } \| undefined; postInstall?: { kind: string; payload?: Record<string, unknown> \| undefined; } \| undefined; configIsolation?: { envVar: string; defaultPath: string; pathKind: "file" \| "directory"; } \| undefined; }; }[]` | yes |
| `providers` | `{ packageName: string; definition: { id: string; name: string; availableModels: { name: string; contextWindowSize: number; labId: string; friendlyName?: string \| undefined; family?: string \| undefined; supportedReasoningLevels?: { none?: string \| number \| undefined; low?: string \| number \| undefined; medium?: string \| number \| undefined; high?: string \| number \| undefined; 'extra-high'?: string \| number \| undefined; } \| undefined; metadata?: { maxOutputTokens?: number \| undefined; capabilities?: { vision?: boolean \| undefined; toolCalling?: boolean \| undefined; parallelToolCalls?: boolean \| undefined; structuredOutput?: boolean \| undefined; pdfUpload?: boolean \| undefined; speechToText?: { modes: ("batch" \| "streaming")[]; vocabularyBiasing?: boolean \| undefined; } \| undefined; textToSpeech?: { modes: ("streaming" \| "buffered")[]; voiceSelection?: boolean \| undefined; voiceInstructions?: boolean \| undefined; outputFormats?: string[] \| undefined; } \| undefined; } \| undefined; pricing?: { token?: { inputPerMillion: number; outputPerMillion: number; inputCachedPerMillion?: number \| undefined; cacheWritePerMillion?: number \| undefined; } \| undefined; request?: { multiplier: number; } \| undefined; } \| undefined; includedInSubscription?: boolean \| undefined; description?: string \| undefined; } \| undefined; }[]; description?: string \| undefined; endpoints?: { anthropic?: string \| undefined; openai?: string \| undefined; } \| undefined; defaultModel?: string \| undefined; fastModel?: string \| undefined; primaryTestModel?: string \| undefined; secondaryTestModel?: string \| undefined; defaultModelFilterMode?: "allowlist" \| "show-all" \| undefined; credentialEnvVars?: Record<string, string> \| undefined; }; }[]` | yes |

### <a id="kernel:extension.enabledChanged"></a>`kernel:extension.enabledChanged` (event)

Signal that an extension's enabled state has changed.

Subject: `kernel:extension.enabledChanged`
Type: Event (fire-and-forget)
Purpose: Emitted after a successful `kernel:extension.setEnabled` call so
observers can react to enable/disable changes without polling.

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
| `extension` | `{ name: string; displayName: string; state: "active" \| "discovered" \| "skipped" \| "failed" \| "stopped" \| "initializing"; enabled: boolean; error?: string \| undefined; surface?: "any" \| "interactive" \| "headless" \| undefined; browser?: { entrypoint: string; } \| undefined; } \| null` | yes |

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
| `extensions` | `{ name: string; displayName: string; state: "active" \| "discovered" \| "skipped" \| "failed" \| "stopped" \| "initializing"; enabled: boolean; error?: string \| undefined; surface?: "any" \| "interactive" \| "headless" \| undefined; browser?: { entrypoint: string; } \| undefined; }[]` | yes |

### <a id="kernel:extension.setEnabled"></a>`kernel:extension.setEnabled` (rpc)

Enable or disable an extension at runtime.

Subject: `kernel:extension.setEnabled`
Type: RPC (request/response)
Purpose: Allows the user or platform config to toggle an extension without
a full restart. The coordinator re-enters the load path on enable, or runs
cleanup and transitions to `stopped` on disable.

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `enabled` | `boolean` | yes |
| `name` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
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
| `contributes` | `{ adapters: boolean; tools: boolean; triggers: boolean; providers: boolean; clients: boolean; ui: boolean; storage: boolean; sessionEventActions: boolean; } \| undefined` | no |
| `displayName` | `string` | yes |
| `error` | `string \| undefined` | no |
| `from` | `"active" \| "discovered" \| "skipped" \| "failed" \| "stopped" \| "initializing"` | yes |
| `name` | `string` | yes |
| `to` | `"active" \| "discovered" \| "skipped" \| "failed" \| "stopped" \| "initializing"` | yes |

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
| `warnings` | `{ severity: "info" \| "recommended" \| "degraded"; title: string; message: string; action?: { kind: "configure-integration"; clientId: string; bundle: string; } \| { kind: "install-extension"; extensionName: string; } \| { kind: "open-url"; url: string; } \| { kind: "run-command"; command: string; } \| undefined; }[]` | yes |

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
| `entries` | `{ extensionName: string; warnings: { severity: "info" \| "recommended" \| "degraded"; title: string; message: string; action?: { kind: "configure-integration"; clientId: string; bundle: string; } \| { kind: "install-extension"; extensionName: string; } \| { kind: "open-url"; url: string; } \| { kind: "run-command"; command: string; } \| undefined; }[]; }[]` | yes |

---

*Auto-generated by `yarn docs:bus`. Do not edit manually.*
