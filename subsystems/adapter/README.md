# @makaio/subsystem-adapter

Framework-owned service that manages the full adapter lifecycle: contribution
loading, config persistence, runtime initialization, and identity resolution.
Adapter packages are processed by the `AdapterSubsystemService` reacting to
`extension.stateChanged` bus events, so adapter contributions are registered
and enabled adapters are initialized before any post-boot phase runs.

## Usage

### Register in the composition root

```typescript
import {
  createAdapterSubsystemPackage,
  createAdapterSubsystemContributionProcessor,
  FileAdapterConfigRepository,
} from '@makaio/subsystem-adapter';

// Build the contribution processor and register it before startAll().
const contributionProcessor = createAdapterSubsystemContributionProcessor({
  coordinator,
  platformDefaults: { cwd: os.tmpdir() },
});
coordinator.registerContributionProcessor(contributionProcessor);

// Register the subsystem extension package itself.
const adapterSubsystemExt = createAdapterSubsystemPackage({
  configRepository: new FileAdapterConfigRepository(configPath),
  coordinator,
  platformDefaults: { cwd: os.tmpdir() },
});

coordinator.load([adapterSubsystemExt, ...otherExtensions]);
await coordinator.startAll();
```

## API Overview

| Export | Description |
|--------|-------------|
| `createAdapterSubsystemPackage()` | Creates the critical `MakaioExtension` for the adapter subsystem |
| `AdapterSubsystemToken` | Extension token used to retrieve the service from the coordinator |
| `AdapterSubsystemService` | Service class — owns adapter init, shutdown, and config sync |
| `createAdapterSubsystemContributionProcessor()` | Factory for the contribution processor; must be registered before `coordinator.startAll()` |
| `FileAdapterConfigRepository` | File-backed implementation of `IAdapterConfigRepository` |
| `extractAdapterIdFromPackageName()` | Derives a stable short ID from an NPM package name |
| `ensureAdapterConfigs()` | Bootstraps file-backed config entries for discovered adapters |
| `initializeEnabledAdapters()` | Invokes adapter factories for all enabled entries |
| `shutdownAdapterInstances()` | Best-effort graceful shutdown of live adapter instances |
| `toAvailableAdapter()` | Converts a loaded adapter entry to the settings-facing shape |
| `type PlatformDefaults` | `cwd` and `env` defaults injected by the runtime host |
| `type LoadedAdapter` | In-memory representation of a loaded adapter contribution |
| `type AdapterInstance` | Running adapter instance with bus handle |
| `type IAdapterConfigRepository` | Seam for config persistence (re-exported from `@makaio/services-core`) |

## Installation

`@makaio/subsystem-adapter` is a private workspace package. Add it with the
workspace protocol:

```json
{ "@makaio/subsystem-adapter": "workspace:*" }
```
