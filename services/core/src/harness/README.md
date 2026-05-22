# @makaio/services-core — Harness

Tool capability expansion and harness definition storage.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     HarnessService                           │
│  harness.* subjects — CRUD, default resolution, schema      │
│  Seeds default harnesses on init                             │
└─────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│                  HarnessStorageSubjects                      │
│  storage:harness.get/set/delete/list                        │
└─────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│              expandProfileToolCapabilities()                 │
│  Resolves capability → tool names via harness map           │
│  Unions with existing allowed/disallowed lists              │
│  (exported from @makaio/contracts/harness)                  │
└─────────────────────────────────────────────────────────────┘
```

## What is a Harness?

A `HarnessDefinition` describes the runtime context for an agent:
- **`approvalPolicy`** — default policy (`full-access`, `always-ask`, `reject`)
- **`nativeTools`** / **`registryTools`** — enabled/disabled tool selections
- **`toolCapabilityMap`** — maps tool names to capability tags (e.g., `write-files`)
- **`capabilityOverrides`** — per-capability approval policy overrides
- **`toolApprovalOverrides`** — per-tool approval policy overrides

## Components

### HarnessService
`src/harness-service.ts`

Orchestrates harness lifecycle. Seeds default harnesses on `init()` before
registering handlers. Uses partial-update semantics on `set` so schema-driven
editors cannot silently zero fields they don't render.

**Handles (via `HarnessSubjects.*`):**
- `harness.get` — fetch by id or by name plus `adapterName`/`clientId`
- `harness.list` — list, filter by `adapterName`, `clientId`, or `name`
- `harness.set` — create/update (stable ID uses `clientId` when present, otherwise `adapterName`)
- `harness.delete` — remove by id
- `harness.getDefault` — resolve default harness by `clientId` first, then fall back to `adapterName`
- `harness.resolve` — resolve harness for a persona/profile, falls back to adapter default
- `harness.getSchema` — JSON schema + UI config for forms

### Storage Namespace
`src/storage/namespace.ts`

Defines `HarnessStorageSubjects` (`storage:harness.*`):
- `storage:harness.get` — fetch by ID
- `storage:harness.set` — create/update (strict schema, rejects unknown fields)
- `storage:harness.delete` — remove by ID
- `storage:harness.list` — filter by `adapterName`, `clientId`, or `name`

### Capability Expansion
`@makaio/contracts/harness`

Resolves the harness's `toolCapabilityMap` and expands capability names to
concrete tool names. Uses "Stance B" (override) semantics.

## Exports

```
HarnessStorageNamespace, HarnessStorageSubjects
Harness, HarnessInput, HarnessListQuery
```

## Dependencies

- `@makaio/storage-core`, `@makaio/storage-handlers` — storage infrastructure
- `@makaio/contracts` — `HarnessDefinitionSchema`, `HarnessSubjects`, `ApprovalPolicySchema`
