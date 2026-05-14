# @makaio/runtime-node

Node.js runtime package for the Makaio AI Framework. Provides the full boot
sequence, filesystem-based config/discovery, SQLite storage initialisation,
credential resolution, and model-registry infrastructure for Node.js hosts.

## Boot Sequence

`bootMakaioRuntime()` is the primary entry point. It accepts a pre-bound
Node.js HTTP server and runs the complete 12-step startup:

| Step | Description |
|------|-------------|
| 1 | **Config** — `NodeRuntimeProvider` resolves effective `makaio.config.*` through `ConfigProvider` over `FileConfigStorage`, then loads machine ID |
| 2 | **Bus** — `MakaioBus` singleton is created; `busCreated` phase event emitted |
| 3 | **Transport** — `BusServerTransportProvider` attaches a WebSocket upgrade handler to the HTTP server |
| 4 | **Storage** — SQLite database initialised via `initializeNodeDatabase`; handle exposed on `RuntimeSubjects.database` |
| 5 | **Identity** — machine key material loaded or generated; `RuntimeSubjects.machineIdentity` and `RuntimeSubjects.busPort` handlers registered |
| 6 | **Config handlers** — runtime config bus handlers registered; framework core packages assembled |
| 7 | **Extension discovery and loading** — `FilesystemDescriptorDiscovery` (or override) scans configured roots; browser-only and CLI-only packages merged |
| 8 | **ExtensionCoordinator** — all extension and framework packages started (surface-gated) |
| 9 | **Adapter runtime identity** — adapter name resolver and adapter runtime identity handlers registered |
| 10 | **Coordinator-ready broadcast** — `coordinatorReady` lifecycle event emitted |
| 11 | **E2E auth hot-swap** (LAN mode only) — E2E auth strategy installed after machine identity is available |
| 12 | **Ready** — `kernel.ready` emitted; `MakaioRuntime` handle returned |

Startup failures trigger a reverse rollback of all completed steps.

## Quick Start

```typescript
import { createAdaptorServer } from '@hono/node-server';
import { Hono } from 'hono';
import {
  bootMakaioRuntime,
  createHonoRouteGraph,
  createHttpRouteGraphBuilder,
  waitForServerListening,
} from '@makaio/runtime-node';

const app = new Hono();
const routeGraph = createHonoRouteGraph(app, {
  health: () => ({ ok: true, auth: false }),
});
const httpServer = createAdaptorServer({ fetch: routeGraph.fetch });
httpServer.listen(0, '127.0.0.1');
await waitForServerListening(httpServer, 0);

const runtime = await bootMakaioRuntime({
  httpServer,
  routeGraphBuilder: createHttpRouteGraphBuilder(routeGraph),
  surface: 'interactive',
  onTransportReady: ({ port }) => {
    console.info(`Bus ready on port ${port}`);
  },
});
routeGraph.markReady();

// Graceful shutdown
await runtime.shutdown();
```

## Configuration

Makaio looks for `makaio.config.ts`, `makaio.config.js`, or
`makaio.config.json` in `MAKAIO_HOME` (default: `~/.makaio`). Use
`defineMakaioConfig` for type-safe authoring:

```typescript
// makaio.config.ts
import { defineMakaioConfig } from '@makaio/runtime-node/makaio-config';

export default defineMakaioConfig({
  extensions: {
    discoveryPaths: ['./extensions'],
    exclude: ['*-experimental'],
  },
  launcherCommand: 'makaio',
});
```

| Environment Variable | Purpose |
|----------------------|---------|
| `MAKAIO_HOME` | Runtime data directory (config, DB, keys, installed extensions). Default: `~/.makaio` |
| `MAKAIO_CONFIG_FILE` | Explicit config file path override |
| `MAKAIO_MODE` | ConfigProvider mode input; current Node boot still passes a local-mode host override |
| `MAKAIO_RELAY_URL` | Relay endpoint override exposed through effective runtime config without being persisted by `ConfigSubjects.update` |

## Named Exports

### Boot

| Export | Description |
|--------|-------------|
| `bootMakaioRuntime` | Boot against a pre-bound Node.js HTTP server |
| `bootMakaioRuntimeCore` | Platform-agnostic boot core used by Node and Bun |
| `normalizeNodeHostCapabilities` | Normalise host capability token list for Node.js |
| `selectFrameworkCorePackages` | Select framework-owned packages from the extension list |

### Configuration

| Export | Description |
|--------|-------------|
| `defineMakaioConfig` | Type-safe config file helper |
| `loadMakaioConfig` | Load and parse `makaio.config.*` from disk |
| `parseMakaioConfig` | Parse raw config values through the Zod schema |
| `buildConfiguredRuntimeOptions` | Derive boot-ready options from parsed config |
| `resolveMakaioHome` | Resolve `~/.makaio` or `MAKAIO_HOME` override |
| `resolveMakaioConfigPath` | Locate the config file using env and home defaults |
| `createMakaioConfigDiscovery` | Create a discovery strategy from parsed config |
| `shouldIncludeExtension` | Apply include/exclude filter to a descriptor name |

### Discovery and Extensions

| Export | Description |
|--------|-------------|
| `FilesystemDescriptorDiscovery` | Three-tier discovery: `local` → `installed` → `global-npm` |
| `ExplicitDescriptorDiscovery` | Provide a pre-scanned extension list (tests, host overrides) |
| `loadExtensions` | Load and validate extension packages from discovered descriptors |
| `bridgeExtensionBrowserEntries` | Build browser entry-point manifests for discovered extensions |

### Storage

| Export | Description |
|--------|-------------|
| `runMigrations` | Apply pending Drizzle migrations to the SQLite database |
| `createArtifactsFts5Tables` | Create FTS5 virtual tables for artifact full-text search |
| `setupArtifactsFtsSync` | Install triggers to keep FTS5 index in sync |
| `FileConfigStorage` | Persist extension config as JSON files under `MAKAIO_HOME` |
| `FileRegistryCache` | File-backed model registry cache |

### Identity and Credentials

| Export | Description |
|--------|-------------|
| `loadOrCreateMachineIdentity` | Load or generate persisted ECDH/ECDSA P-256 machine identity keys |
| `machineKeysExist` | Check whether machine keys are present on disk |
| `validateMachineKeys` | Validate an existing machine key set |
| `NodeCredentialProvider` | Resolve `env:`, `file:`, and `keychain:` credential refs |
| `StoredCredentialProvider` | Resolve `account-manager:` refs via the credential bus service |

### HTTP Utilities

| Export | Description |
|--------|-------------|
| `createHonoRouteGraph` | Create a dynamic Hono route graph with hot-swap support |
| `createHttpRouteGraphBuilder` | Build an `HttpRouteGraphBuilder` for contribution-driven routing |
| `waitForServerListening` | Wait until a server emits `listening` |
| `resolveListeningPort` | Read the bound port from an HTTP server address |

### Types

| Type | Description |
|------|-------------|
| `BootMakaioRuntimeOptions` | Options for `bootMakaioRuntime` (adds `httpServer`) |
| `CoreBootOptions` | Platform-agnostic boot options shared by Node and Bun |
| `MakaioRuntime` | Handle returned on successful boot (`port`, `host`, `machineId`, `shutdown`) |
| `ServerTransportProvider` | Transport provider interface with optional `dispatchingAuth` |
| `TransportReadyInfo` | `{ port, host }` passed to `onTransportReady` |
| `BootCoordinatorSetupContext` | Context for host-owned coordinator wiring via `configureCoordinator` |
| `MakaioConfig` | Config file authoring shape |
| `ParsedMakaioConfig` | Parsed config with absolute paths and defaults applied |
| `LoadedMakaioConfig` | `{ configPath?, config }` result from `loadMakaioConfig` |
| `ExtensionDiscovery` | Strategy interface implemented by all discovery providers |
| `DiscoveredExtension` | `{ descriptor, extensionPath, source }` from discovery |

## Sub-path Exports

| Export path | Contents |
|-------------|----------|
| `@makaio/runtime-node/extension-discovery` | `FilesystemDescriptorDiscovery`, `ExplicitDescriptorDiscovery` |
| `@makaio/runtime-node/extension-validation` | Extension descriptor validation helpers |
| `@makaio/runtime-node/makaio-config` | Config loading, parsing, and resolution |
| `@makaio/runtime-node/runtime/schemas` | Runtime bus message schemas |
| `@makaio/runtime-node` | Side-effect import to register runtime bus namespace |
