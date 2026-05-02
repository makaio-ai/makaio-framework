# @makaio/services-log-import

Central registry for log importers from adapters and extensions.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    LogImportRegistry                         │
│  Manages registration lifecycle for LogImporter instances   │
│  Coordinates LogImportOrchestrator per registered importer  │
└─────────────────────────────────────────────────────────────┘
         │
         ▼
┌──────────────────────┐   ┌──────────────────────────────────┐
│  Adapter importers   │   │   Extension importers            │
│  id: adapterId       │   │   id: 'package:{name}'           │
└──────────────────────┘   └──────────────────────────────────┘
```

## Components

### LogImportRegistry
`src/log-import-registry.ts`

Central registry that:
- Accepts `LogImporterRegistration` entries from adapters and extensions
- Creates and manages `LogImportOrchestrator` instances per importer
- Tracks whether orchestrators were started by the registry (managed lifecycle)

### Key Types

```typescript
interface LogImporterRegistration {
  id: string;                    // adapterId or 'package:{name}'
  adapterName: string;           // e.g., 'claude-code-cli'
  displayName: string;           // e.g., 'Claude Code'
  source: 'adapter' | 'extension';
  importer: LogImporter<unknown, unknown>;
  logFilePattern: string;        // e.g., '**\/session.jsonl'
  supportsManualImport?: boolean;
  orchestratorFactory?: OrchestratorFactory;
}
```

## Usage

```typescript
import { LogImportRegistry } from '@makaio/services-log-import';

const registry = new LogImportRegistry({ bus });
await registry.init();

await registry.register({
  id: 'my-adapter',
  adapterName: 'claude-code-cli',
  displayName: 'Claude Code',
  source: 'adapter',
  importer: myAdapterImporter,
  logFilePattern: '**/session.jsonl',
});

// Cleanup on shutdown
await registry.destroy();
```

`init()` registers the bus handlers and capability subscription; `destroy()` stops/disposes managed orchestrators and
unsubscribes those handlers. Registering importers alone does not install the bus surface.

## Dependencies

- `@makaio/ai-adapters-core` — `LogImporter`, `LogImportOrchestrator` interfaces
- `@makaio/contracts` — extension manifest and capability/adapter/log-import subject contracts
- `@makaio/bus-core` — message bus
- `@makaio/kernel` — package lifecycle token wiring
- `@makaio/service-base` and `@makaio/services-core` — service lifecycle and capability service integration
- `@makaio/storage-drizzle` — Drizzle-backed log-import settings storage

## Package Surface

- Root exports include `LogImportRegistry`, `createLogImportContributionProcessor`,
  `LogImporterRegistration`, `OrchestratorFactory`, `LogImporterInfo`, storage registration helpers,
  and the package lifecycle token.
- `./log-import` and `./namespace` are side-effect entries for registering the log-import bus surface.
- `./schemas` exports the bus schema objects used by the namespace and handlers.

---

*Part of the [Makaio AI Framework](https://github.com/makaio-ai/makaio)*
