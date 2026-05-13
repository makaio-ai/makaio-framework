---
title: Extensions
description: Modular extension system for adding functionality to Makaio through declarative package manifests.
---

An extension is any module that implements the `MakaioExtension` interface and is loaded by
`ExtensionCoordinator` at runtime. Extensions declare their surfaces — services, CLI
commands, HTTP routes, storage, windows, tray entries, browser UI — in a single manifest
object. The runtime handles boot ordering, lifecycle, and observability.

---

## Core concepts

### `ExtensionManifest` — pure metadata

The serializable layer: everything the runtime needs to discover, gate, and route an extension
without executing any of its code.

```ts
interface ExtensionManifest {
  name: string;          // unique identifier, e.g. 'account-manager'
  displayName: string;   // shown in UI surfaces
  surface?: 'interactive' | 'headless' | 'any'; // default: 'any'
  dependencies?: ExtensionDependency[];  // extension ordering and version range; booted first
  requires?: RuntimeRequirement[];       // typed host/runtime environment gates, e.g. { type: 'host', id: 'node' }
  provides?: string[];      // catalog/onboarding metadata; not a boot token
  windows?: WindowManifest[];
  tray?: TrayManifest;
  cli?: CliManifest;
  storage?: StorageManifest;
  browser?: BrowserEntrypoint;
  contributions?: ContributionManifest;
}
```

### `MakaioExtension` — executable extension

Extends `ExtensionManifest` with executable code. This is what your extension exports.

```ts
interface MakaioExtension<THostContext extends ExtensionContext = NodeExtensionContext> extends ExtensionManifest {
  create?: (ctx: THostContext) => ExtensionService | Promise<ExtensionService>;
  critical?: boolean;
  runtimeOwnership?: ExtensionRuntimeOwnership;
  runtimeBoot?: ExtensionRuntimeBootContribution<THostContext>;
  cli?: ExtensionCliContribution; // narrows ExtensionManifest.cli
  http?: { prefix: string; mount: (app: unknown) => void };
  storage?: StorageManifest & {
    registerHandlers?: (bus, db, ctx) => (() => void) | void;
  };
  adapters?: readonly AdapterContribution[];
  clients?: readonly ClientDefinition[];
  providers?: readonly ProviderDefinitionInput[];
  tools?: ExtensionToolsContribution<THostContext>;
  triggers?: ExtensionTriggersContribution;
  sessionEventActions?: ExtensionSessionEventActionsContribution;
  logImport?: LogImportContribution;
  ui?: ExtensionUiContribution; // declarative metadata unless bridged by a browser factory
}
```

The `create` factory is optional. An extension that only contributes a window, a tray entry,
or browser UI omits it entirely.

### `descriptor.json` — install/discovery contract

`descriptor.json` is the package-root contract the host scans before it imports any
extension code. It declares extension identity, supported entrypoints, version
compatibility, and descriptor-level defaults.

```json
{
  "name": "weather-tools",
  "displayName": "Weather Tools",
  "version": "0.1.0",
  "makaio": {
    "framework": ">=0.1.0"
  },
  "entrypoints": {
    "server": true,
    "browser": "browser/index",
    "cli": true
  },
  "cli": {
    "name": "weather-tools",
    "description": "Weather tool commands",
    "subcommands": [
      {
        "name": "forecast",
        "description": "Show a forecast"
      }
    ]
  },
  "execution": "embedded"
}
```

Entrypoints use **convention-based resolution** — no file paths in the descriptor.

| Value | Resolved stem | Example |
|-------|--------------|---------|
| `true` | surface name | `"server": true` → stem `server` |
| `"<stem>"` | custom path stem | `"browser": "browser/index"` → stem `browser/index` |

For each declared entrypoint the loader tries, in order:

1. `src/<stem>.ts` — TypeScript source (dev mode, inside framework workspace)
2. `dist/<stem>.mjs` — compiled ESM output (production / portable package)

The first path that exists within the extension root is used. Stems must use forward-slash
segments, must not contain empty, `.`, `..`, `src`, or `dist` segments, and must not include
a dotted final segment. The loader performs a containment check on the resolved path, so
symlink or platform-specific path behavior cannot bypass the descriptor contract.

### Descriptor Namespace

The descriptor `name` owns the extension identity namespace. This rule applies to every
extension regardless of origin:

| Export shape | Extension-name rule |
|--------------|-------------------|
| single extension | `extension.name` must equal `descriptor.name` |
| extension array | one extension must equal `descriptor.name`; every child extension must be `descriptor.name.*` |

Examples:

```ts
export const weatherToolsExtension: MakaioExtension = {
  name: 'weather-tools',
  displayName: 'Weather Tools',
};

export const weatherToolsSyncExtension: MakaioExtension = {
  name: 'weather-tools.sync',
  displayName: 'Weather Sync',
  dependencies: [{ type: 'extension', name: 'weather-tools', version: '^1.0.0' }],
};

export default [weatherToolsExtension, weatherToolsSyncExtension];
```

There is no trust bypass for unscoped array exports. If a descriptor is named
`weather-tools`, an exported sibling named `sync` is invalid; it must be
`weather-tools.sync`. Dependencies use the actual loaded extension names. Framework extension
dependencies keep their framework-owned names, but extensions owned by the same descriptor
use the descriptor-scoped name.

`package.json.name` is distribution metadata and may differ from `descriptor.name`, including
for scoped npm packages. Runtime namespace validation is based on `descriptor.name` and the
`MakaioExtension.name` values exported by the entrypoint, not on the npm package name.

### `ExtensionContext` — provided by the runtime

```ts
interface ExtensionContext {
  bus: IMakaioBus;
  identity: ExtensionIdentity;
  dataDir: string;
  machineId: string; // stable machine ID resolved by the composition root
  config?: unknown;   // resolved extension config (parsed through the extension's configSchema if declared)
  getService<T>(token: ExtensionToken<T>): T | undefined;
  tryImport<T>(specifier: string): Promise<T | null>;
  signal: AbortSignal;
  hasExtension(name: string): boolean;
}

interface NodeExtensionContext extends ExtensionContext {
  platform: NodeJS.Platform;
  homedir: string;
  makaioHome: string;
  username: string;
}
```

The base context is host-agnostic. Node-based hosts provide `NodeExtensionContext`;
extensions that read OS or filesystem fields should type their factories against that
explicit host context.

---

## Surface types

### 1. Background service (`create`)

The most common surface. The runtime calls `create(ctx)` to instantiate the service, then
calls `service.init()`. On shutdown it calls `service.destroy()`.

```ts
import { BaseService } from '@makaio/service-base';
import type { ExtensionContext, MakaioExtension } from '@makaio/contracts/extension';
import type { IMakaioBus } from '@makaio/bus-core';

class MyService extends BaseService {
  constructor(bus: IMakaioBus) {
    super(bus);
  }

  protected async onInit(): Promise<void> {
    // register bus handlers, start watchers, etc.
  }

  protected async onDestroy(): Promise<void> {
    // release resources
  }
}

export const myExtension: MakaioExtension<ExtensionContext> = {
  name: 'my-package',
  displayName: 'My Package',
  critical: true,
  create: (ctx) => new MyService(ctx.bus),
};
```

Throw `ServiceSkipError` from `create` or `init` to mark the extension as `skipped` (not an
error — used for platform-conditional features).

### 2. CLI commands (`cli`)

Contributes a top-level `makaio <name>` command tree. Subcommands are defined with Zod
schemas — no Commander import required in your extension.

```ts
import { z } from 'zod';
import { defineCliSubcommand, type CliContribution } from '@makaio/kernel/cli';
import type { MakaioExtension } from '@makaio/contracts/extension';

const listSchema = z.object({
  format: z.enum(['table', 'json']).default('table').meta({
    description: 'Output format',
    short: '-f',
  }),
});

export const myExtension: MakaioExtension = {
  name: 'my-package',
  displayName: 'My Package',

  cli: {
    name: 'my-package',
    description: 'Manage my-package resources',

    // Optional: launched by bare `makaio my-package`
    interactive: async ({ bus }) => {
      // Render an Ink TUI
    },

    subcommands: [
      defineCliSubcommand('list', 'List resources', listSchema, async ({ args, bus }) => {
        // args.format → 'table' | 'json'
        // bus → connected IMakaioBus
      }),
    ],
  },
};
```

**Dispatch:**

| Invocation | Behaviour |
|------------|-----------|
| `makaio my-package` | `interactive` handler (or help) |
| `makaio my-package list` | `list` subcommand handler |
| `makaio my-package --help` | auto-generated from schema metadata |

**Zod metadata fields** (set via `.meta()`):

| Field | Type | Purpose |
|-------|------|---------|
| `description` | `string` | Help text |
| `short` | `string` | Short flag alias, e.g. `'-f'` |
| `placeholder` | `string` | Value placeholder in help text |
| `positional` | `boolean` | Treat as positional argument instead of named option |

### 3. HTTP routes (`http`)

Declare Hono routes for the host HTTP route graph. Hosts that provide HTTP serving register
an HTTP contribution processor during boot; when an extension activates, the processor mounts
the extension's routes onto a fresh Hono app and atomically swaps the route graph. When the
extension stops or is disabled, its contribution is removed and the graph is rebuilt again.

```ts
import { Hono } from 'hono';

export const myExtension: MakaioExtension = {
  name: 'my-package',
  displayName: 'My Package',

  http: {
    prefix: '/my-package',
    mount: (app: unknown) => {
      const hono = app as Hono;
      // Register the full URL path under `prefix`; the runtime does not rebase the Hono app.
      hono.get('/my-package/status', (c) => c.json({ ok: true }));
    },
  },
};
```

### 4. Storage (`storage`)

Declare Drizzle migrations and register bus-backed storage handlers. Migrations run before
any service's `init()` is called.

```ts
export const myExtension: MakaioExtension = {
  name: 'my-package',
  displayName: 'My Package',

  storage: {
    migrations: 'drizzle',

    registerHandlers: (bus, db, ctx) => {
      // Register Drizzle-backed bus handlers.
      // Return an optional cleanup function.
      const unsub = bus.on(MySubjects.list, async () => { /* ... */ });
      return unsub;
    },
  },
};
```

Migration paths are relative to the extension root and resolved by the composition root
before `registerHandlers` is called.

### 5. Windows (`windows`)

Declare UI windows the shell manages. The shell pre-registers windows from the manifest
so they can be opened without waiting for the extension service to initialize.

```ts
export const myExtension: MakaioExtension = {
  name: 'my-package',
  displayName: 'My Package',

  windows: [
    {
      id: 'settings',
      style: 'utility',     // 'tray-popover' | 'utility' | 'panel'
      width: 480,
      height: 600,
      singleton: true,      // only one instance at a time
    },
  ],
};
```

**Window styles:**

| Style | Description |
|-------|-------------|
| `'tray-popover'` | Small overlay anchored to the system tray icon |
| `'utility'` | Standalone auxiliary window (e.g., settings panel) |
| `'panel'` | Docked or floating workspace panel |

### 6. Tray (`tray`)

Contribute an entry to the system tray menu. A tray entry either opens a declared window
or emits `host:tray.item.clicked` with extension-owned metadata.

```ts
export const myExtension: MakaioExtension = {
  name: 'my-package',
  displayName: 'My Package',

  windows: [{ id: 'main', style: 'tray-popover' }],

  tray: {
    label: 'My Package',
    section: 'tools',       // 'utilities' | 'tools' | 'views'
    opensWindow: 'main',    // WindowManifest.id — takes precedence over action
    // action: 'my-package.trigger', // echoed as metadata.action on click (alternative)
  },
};
```

### 7. Browser extension (`browser`)

See [Browser & UI](./browser) for the full browser extension architecture,
renderer lifecycle, and framework web primitives.

---

## `surface` — execution affinity

Extensions declare which runtime surface they target:

| `surface` value | Loaded by |
|-----------------|-----------|
| `'any'` (default) | Both headless (`makaio serve`) and interactive desktop hosts |
| `'headless'` | Only by headless runtimes (CLI serve, CI) |
| `'interactive'` | Only by interactive desktop hosts (requires a renderer) |

`ExtensionCoordinator` skips extensions whose declared surface does not match the running
surface. An extension with tray or window surfaces should declare `'interactive'`.

---

## `dependencies` — boot ordering

Declare structured `ExtensionDependency` objects naming the extensions that must be
initialized before this one. Each dependency carries a semver `version` range that must
be satisfied by the installed extension package.
`ExtensionCoordinator` uses Kahn's algorithm to derive a topological boot order and
validates that all declared dependencies are present and version-compatible.

```ts
export const myExtension: MakaioExtension = {
  name: 'my-package',
  displayName: 'My Package',
  dependencies: [
    { type: 'extension', name: 'my-package.settings', version: '>=1.0.0 <2.0.0' },
    { type: 'extension', name: 'session', version: '>=1.0.0 <2.0.0' },
  ],
  create: (ctx) => new MyService(ctx.bus),
};
```

`my-package.settings` is owned by the same descriptor and uses the descriptor namespace.
`session` is a framework-owned extension name. A circular dependency throws at boot time,
not silently at runtime.

---

## Lifecycle

`ExtensionCoordinator` drives a per-extension state machine:

```
discovered → initializing → active ⇄ stopped  (disable/re-enable at runtime)
                         ↘ failed   (create or init threw)
                         ↘ skipped  (ServiceSkipError thrown, or disabled at boot)
```

Every state transition emits `kernel:extension.stateChanged` on the bus. Non-critical failures are
isolated: one non-critical extension failing does not abort the boot of remaining extensions.
Critical extension failures still fail boot because the host declared that extension mandatory.

**Phases:**

1. **`load(packages)`** — validates dependencies, topological sort, registers windows,
   and collects tray entries and CLI contributions. No service code runs.
2. **`startAll()`** — calls `create(ctx)` then `service.init()` for each package in
   dependency order. Storage handlers are registered after migrations are applied, and
   contribution processors activate executable surfaces such as HTTP routes.
3. **`shutdown()`** — calls `service.destroy()` in reverse boot order.

---

## Minimal example

A complete extension with a background service and a CLI command:

```ts
import { z } from 'zod';
import { BaseService } from '@makaio/service-base';
import { defineCliSubcommand, type CliContribution } from '@makaio/kernel/cli';
import type { ExtensionContext, MakaioExtension } from '@makaio/contracts/extension';
import type { IMakaioBus } from '@makaio/bus-core';

class GreeterService extends BaseService {
  constructor(bus: IMakaioBus) {
    super(bus);
  }
  protected async onInit(): Promise<void> { /* register handlers */ }
  protected async onDestroy(): Promise<void> { /* cleanup */ }
}

export const greeterExtension: MakaioExtension<ExtensionContext> = {
  name: 'greeter',
  displayName: 'Greeter',
  surface: 'any',

  create: (ctx) => new GreeterService(ctx.bus),

  cli: {
    name: 'greeter',
    description: 'Say hello',
    subcommands: [
      defineCliSubcommand(
        'hello',
        'Print a greeting',
        z.object({
          name: z.string().meta({ description: 'Name to greet', positional: true }),
        }),
        async ({ args, output }) => {
          output.write(`Hello, ${args.name}!\n`);
        },
      ),
    ],
  },
};
```

---

## Deep Dives

| Topic | What it covers |
|-------|----------------|
| [Creating Extensions](../../creating-extensions) | Scaffolding, surfaces, CLI/browser/server entrypoints, build, verification |
| [Discovery & Loading](./discovery) | Descriptor discovery, loading pipeline, config resolution, contribution wiring |
| [Browser & UI](./browser) | Renderer architecture, shell inversion, framework web primitives |
| [Distribution](./distribution) | Extension distribution, descriptor-selected loading, local authoring workflow |

<!-- web:hide -->

## Key source files

| File | Purpose |
|------|---------|
| `../packages/contracts/src/extension/makaio-extension.ts` | `MakaioExtension`, `ExtensionContributionProcessor` |
| `../packages/contracts/src/extension/extension-context.ts` | `ExtensionContext`, `NodeExtensionContext` |
| `../packages/contracts/src/extension/manifest.ts` | `ExtensionManifest` and all sub-manifests |
| `../packages/contracts/src/extension/extension-runtime-boot.ts` | `ExtensionRuntimeOwnership` single-owner runtime declarations |
| `../packages/kernel/src/cli/types.ts` | `CliContribution`, `defineCliSubcommand` |
| `../packages/kernel/src/extension/extension-coordinator.ts` | `ExtensionCoordinator` |

<!-- /web:hide -->
