---
title: Adapter Discovery
description: How the Makaio Framework discovers, loads, and activates AI provider adapters through the extension system.
---

Adapters are not discovered separately. They are extension contribution surfaces — declared in
`MakaioExtension.adapters[]` and wired by the adapter subsystem's contribution processor during
boot. There is no parallel adapter filesystem scanner; adapter discovery is a function of
extension discovery.

## Extension ↔ adapter bridge

An adapter-providing extension declares its adapters in `package.ts`:

```ts
import type { MakaioExtension } from '@makaio/contracts/extension';
import { adapterDefinition } from './definition.js';

const extension: MakaioExtension = {
  name: 'my-provider',
  displayName: 'My Provider',
  adapters: [{
    manifest: { name: 'my-provider', protocols: ['openai'] },
    definition: adapterDefinition,
  }],
};

export default extension;
```

The `adapters` array contains `AdapterContribution` objects:

```ts
interface AdapterContribution<TAdapter = unknown> {
  readonly manifest: AdapterManifest;
  readonly definition: AdapterDefinitionContract<TAdapter>;
}
```

**AdapterManifest** — static metadata read before the adapter is instantiated:

| Field | Type | Purpose |
|-------|------|---------|
| `name` | `string` | Stable machine identifier (unique key) |
| `displayName?` | `string` | UI display name |
| `description?` | `string` | Short description |
| `clients?` | `AdapterClientRef[]` | Client binary dependencies with semver ranges |
| `protocols` | `ProtocolRef[]` | Wire protocols implemented (at least one required) |
| `defaultProvider?` | `string` | Default provider definition ID |

**AdapterDefinitionContract** — runtime factory and schema surface:

| Field | Type | Purpose |
|-------|------|---------|
| `name` | `string` | Must match `manifest.name` |
| `providers` | `AdapterProviderRef[]` | Provider IDs this adapter serves |
| `defaultTimeouts` | `RequiredTimeoutConfig` | Timeout defaults |
| `createAdapter` | `function` | Factory: `(options?) => Promise<TAdapter>` |
| `adapterConfigSchema?` | Zod schema | Adapter-level config schema |
| `providerConfigSchema?` | Zod schema | Default config schema for providers |
| `helpLinks?` | array | External help links for UI |
| `instructions?` | `string` | Setup instructions |
| `clientId?` | `string` | Client identifier for binary management |

## Boot sequence

Adapter wiring happens inside `coordinator.startAll()`, driven by
`AdapterContributionProcessor.onPackageActivated()`:

```
Extension discovered (descriptor.json)
  → Dynamic import (load-extensions.ts)
    → Extension becomes active (coordinator.startAll)
      → AdapterContributionProcessor.onPackageActivated()
        → For each adapter contribution:
           1. Resolve provider definitions from extension catalog
           2. Populate provider models from model registry
           3. Build LoadedAdapter from definition + manifest
           4. Ensure file-backed config exists ($MAKAIO_HOME/adapters/)
           5. Register in in-memory loadedAdapters map
           6. Initialize if enabled (call createAdapter factory)
        → Publish adapter.registered event
          → Adapter ready for agents
```

If any adapter in a package fails during activation, the processor rolls back all adapters from
that package — reverse-iterating contributions and deregistering each — then marks the extension
as `failed`.

## File-backed configuration

Each adapter gets a config file at `$MAKAIO_HOME/adapters/<adapterName>.json` on first
discovery. New adapters default to `enabled: false` and must be explicitly enabled through the
settings UI or by editing the config file directly.

Provider configs live at `$MAKAIO_HOME/provider-configs/<providerConfigId>.json`.

## Runtime state

After boot, adapters are queryable through the bus:

| Bus subject | Returns |
|-------------|---------|
| `adapterSubsystem.adapter.registered` (event) | Published for each adapter during boot |
| `adapterSubsystem.listAdapters` (RPC) | Effective adapter config/read models |
| `adapter.listAgents` (RPC) | Active agents for a specific adapter |
| `adapter.getCapabilities` (RPC) | Capability tokens for a specific adapter |

<!-- web:hide -->

## Key source files

| File | Purpose |
|------|---------|
| `../../packages/contracts/src/extension/extension-contributions.ts` | `AdapterContribution` type |
| `../../packages/contracts/src/extension/adapter-definition.ts` | `AdapterDefinitionContract` |
| `../../packages/contracts/src/extension/contribution-manifest.ts` | `AdapterManifest` |
| `../../subsystems/adapter/src/adapter-contribution-processor.ts` | Boot-time adapter wiring |
| `../../subsystems/adapter/src/adapter-runtime-registry.ts` | Runtime adapter registry |
| `../../subsystems/adapter/src/adapter-subsystem-service.ts` | Adapter subsystem service |
| `../../runtimes/node/src/boot.ts` | Boot sequence integration |

<!-- /web:hide -->
