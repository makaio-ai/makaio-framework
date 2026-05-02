# @makaio/kernel

Runtime extension orchestration for the Makaio framework. The package exposes the
`ExtensionCoordinator`, boot/extension observability subjects, window registry,
and shutdown helpers used by hosted composition roots.

## Usage

```typescript
import { ExtensionCoordinator } from '@makaio/kernel';
import type { MakaioExtension } from '@makaio/contracts';
import { MakaioBus } from '@makaio/bus-core';

const extensions: MakaioExtension[] = [
  {
    name: 'example',
    displayName: 'Example',
    critical: true,
    create: (ctx) => new ExampleService(ctx.bus),
  },
];

const coordinator = new ExtensionCoordinator(MakaioBus, {
  surface: 'headless',
  extensionContextBase: {
    platform: process.platform,
    homedir: process.env['HOME'] ?? '',
    makaioHome: process.env['MAKAIO_HOME'] ?? `${process.env['HOME'] ?? ''}/.makaio`,
    username: process.env['USER'] ?? 'unknown',
    machineId,
    tryImport: async () => null,
  },
});

coordinator.load(extensions);
await coordinator.startAll();

const example = coordinator.getExtensionService('example');

await coordinator.shutdown();
```

### Observe boot progress

```typescript
import { BootSubjects } from '@makaio/kernel';

MakaioBus.on(BootSubjects.progress, ({ payload }) => {
  console.log(`${payload.completedCount}/${payload.totalCount} - ${payload.currentService}`);
});

MakaioBus.on(BootSubjects.complete, ({ payload }) => {
  console.log(`Boot complete in ${payload.totalDurationMs}ms`);
});
```

## API Overview

| Export | Description |
|--------|-------------|
| `ExtensionCoordinator` | Loads `MakaioExtension` entries, orders dependencies, starts/stops extension services, and emits extension/boot observability |
| `BootSubjects` / `BootNamespace` | Bus subjects for boot progress events and boot state snapshots |
| `ExtensionSubjects` / `ExtensionNamespace` | Bus subjects for extension lifecycle state and enable/disable control |
| `ServiceSubjects` / `ServiceNamespace` | Bus subjects for service lifecycle observability |
| `WindowRegistry` | Registers named UI windows and their style defaults |
| `createShutdownSequence()` | Composes an ordered shutdown sequence |
| `ServiceSkipError` | Throw from a non-critical extension `create()`/`init()` to mark it skipped |
