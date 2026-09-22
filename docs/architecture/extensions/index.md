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
  hashTriggers?: ExtensionHashTriggersContribution<THostContext['bus']>;
  automationTriggers?: ExtensionAutomationTriggersContribution<THostContext>;
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

A server entrypoint's top level must contain only declarations — the exported `MakaioExtension`
object literal(s) and whatever pure helpers they reference. Side effects belong in `create()` or
`init()`, never at module scope: the loader and offline tooling both import the module to read its
default export before any service is started, so top-level side effects would run unconditionally
just from being discovered, not from being activated.

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
  /** WebSocket URL of the host bus; absent when the host has no WebSocket transport. */
  busUrl?: string;
  /**
   * Host-supplied resolver for `CredentialRef` values.
   *
   * - `env:<VAR>` — reads the named environment variable.
   * - `file:<path>` — reads the file at the given path.
   * - `keychain:<service>:<account>` — reads macOS Keychain (other platforms return `null`).
   * - `stored:providerConfig:<configId>:<key>` — fetches through the host's credential
   *   service; returns `null` with a warning on bare headless hosts where the service is
   *   not registered.
   *
   * Always returns `null` rather than throwing when the credential is unavailable.
   * **Never log resolved values** — treat them as secrets.
   */
  credentials?: CredentialResolver;
}
```

The base context is host-agnostic. Node-based hosts provide `NodeExtensionContext`;
extensions that read OS or filesystem fields should type their factories against that
explicit host context.

### Config resolution

`ctx.config` is the result of composing four layers through the extension's
`configSchema` (if declared), lowest to highest:

1. **`descriptor.json` `config.defaults`** — the extension author's baseline.
2. **`packageConfigDefaults`** — values from the runtime config file
   (`makaio.config.*`) or host composition root.
3. **Stored settings records** — supplied by a host that wires an
   `ExtensionConfigProvider`; no host ships one today, so this layer is currently
   inert; the kernel contract is what is specified here.
4. **Operator config file** — `$MAKAIO_HOME/config/extensions/<encoded-name>.json`;
   read once at boot; highest priority.

Merging is shallow at one level: a value at layer 4 replaces the entire
corresponding top-level key from lower layers rather than merging recursively.
Schema validation happens after all layers are composed; an error caused by the
operator file fails that extension's activation rather than falling back to schema
defaults.

See [Configuration](../../configuration.md) for the file format, name encoding,
diagnostics, and the relation between operator files and runtime config files.

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

### 8. Automation trigger types (`automationTriggers`)

An **Automation Trigger Type** is an executable description of *when something should happen*. It
is contributed by an extension, registered globally, and consumed by any number of automation
consumers — the workflow engine is one of them, not the owner.

```ts
export const weatherExtension: MakaioExtension = {
  name: 'weather-tools',
  automationTriggers: {
    createAutomationTriggers: (ctx) => [
      defineAutomationTrigger({
        kind: 'weather-tools.storm-warning',
        label: 'Storm Warning',
        description: 'Fires when the forecast reports a storm for a region.',
        categories: ['Weather'],
        paramsSchema: z.object({ region: z.string().min(1) }),
        eventSchema: z.object({ region: z.string(), severity: z.number() }),
        activate: async (context, params) => {
          const stop = watchRegion(params.region, (severity) => {
            void context.emit({ region: params.region, severity });
          });
          return stop;
        },
      }),
    ],
  },
};
```

The `kind` must be `<extension-name>.<local-name>`; the registry rejects a batch that claims a
kind outside the contributing extension's namespace. `createAutomationTriggers` returns the
extension's **complete** batch, which atomically replaces any prior batch under that name.

`activate` receives an `AutomationTriggerActivationContext` — a `bindingKey`, an `AbortSignal`, and
an `emit(payload, metadata?)` function — plus the params already parsed through `paramsSchema`. It
returns a cleanup function. The runtime aborts the signal before awaiting cleanup, so an
`activate` that parks on the signal always settles.

`bindingKey` is the canonical key the runtime indexed this activation under, for a trigger that has
to name its activation to a collaborator or in a log line. It is not a unique index over time: a
retiring and a fresh activation of one key can briefly coexist, so a collaborator keys its own state
on the activation it was handed rather than on the string.

Re-registering a batch replaces the implementation of every kind in it. A binding that is acquired
afterwards activates the **new** implementation rather than joining the previous activation of the
same key; the superseded activation is retired, and its consumers re-acquire on
`automation-triggers.changed`.

**End-to-end lifecycle:**

```
extension activation
  → register Automation Trigger Types                    one atomic batch per extension name
       │                                                 automation-triggers.changed emitted
consumer definition reconciliation
  → parse and canonicalize binding parameters            paramsSchema, then sorted-key canonical form
  → acquire or share ONE source activation               equal canonical params ⇒ one activation
  → validate emitted payload                             eventSchema, then JSON-compatibility
  → fan out Automation Trigger Events                    every attached listener, independently
  → consumer-specific condition and action                e.g. filter → start a workflow
       │
final consumer detach
  → source cleanup                                       signal aborted, cleanup awaited
```

The activation is **shared, not duplicated**: two consumers binding the same `kind` with
parameters that canonicalize identically attach to a single live activation, and the source is torn
down only when the last consumer detaches. Emits from a retired or superseded activation are
discarded rather than delivered.

Consumers subscribe with an **Automation Trigger Binding** — `{ kind, params }` plus whatever
consumer-side conditions that consumer supports. Bindings are data, so they survive persistence
and editing; the executable half lives only in the contributing extension.

Two trigger types ship with the framework: `makaio.bus-event` (params `{ subject }`) and
`makaio.cron` (params `{ schedule, timezone }`, delegating to the host-selected
`AutomationCronScheduler`).

The registry exposes its catalog over the bus — `automation-triggers.list` returns serializable
`AutomationTriggerDescriptor` records (JSON Schema projections of both schemas) and
`automation-triggers.changed` announces registration and deregistration with the exact union of
the previous and replacement batch's kinds. Listing never executes extension code, so UI catalogs
can read it safely.

### 9. Hash triggers (`hashTriggers`)

Hash triggers are unrelated to automation triggers. They are **interactive** input-time actions
bound to a `#` or `@` prefix in a composer, expanding what the user typed before the message is
sent.

```ts
export const weatherExtension: MakaioExtension = {
  name: 'weather-tools',
  hashTriggers: {
    createHashTriggers: (bus) => [
      {
        metadata: { prefix: '@forecast', description: 'Insert a forecast', version: '1.0.0', stage: 'gather' },
        suggest: async (query, context) => ({ suggestions: await lookupRegions(query) }),
        execute: async (value, context) => renderForecast(value),
      },
    ],
  },
};
```

`suggest` powers autocomplete as the user types; the optional `execute` resolves the selected
value into text. `metadata.stage` (`'gather' | 'transform' | 'action'`) and `metadata.runAfter`
order triggers within one composition pass, so a `transform` trigger can consume what a `gather`
trigger already collected via `context.gathered`. Prefixes must be unique across the resolved
manifest.

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

1. **`load(packages)`** — validates dependencies, topological sort, and — for
   _enabled_ extensions only — registers windows and collects tray entries and CLI
   contributions. Disabled extensions receive a coordinator entry but their static
   surfaces are only ever collected by a later process restart's own `load()` call.
   No service code runs.
2. **`startAll()`** — calls `create(ctx)` then `service.init()` for each package in
   dependency order. Storage handlers are registered after migrations are applied, and
   contribution processors activate executable surfaces such as HTTP routes.
3. **`shutdown()`** — calls `service.destroy()` in reverse boot order.

### Enable and disable

Enabled state is persisted to `$MAKAIO_HOME/config/extensions.json`. The coordinator
reads it at boot via `loadEnabled` and writes it via `persistEnabled` whenever
`kernel:extension.setEnabled` is called.

**`kernel:extension.setEnabled` is persist-only.** It durably records the operator's
enable/disable preference for the next boot, but it **never applies the change to the
running process**. Live extension toggling is not a contract this runtime can honor:
several package contributions — `clients` definitions (wired into the client registry
at construction time), `runtimeOwnership` roles (a second owner cannot be added to a
live process), `runtimeBoot.configure` callbacks (registered before `startAll`),
`storage.migrations` (applied once, at boot), and host-level policies wired in outside
the coordinator's own visibility (for example the automation cron scheduler host
policy, whose single scheduler provider is resolved once from the packages eligible
**and** enabled at boot) — are all composed exactly once during boot and have no seam
to replay for one package in isolation while the process keeps running.

`setEnabled` persists the requested preference unconditionally — refusing outright,
before writing anything, only for an unknown extension name or a disable of a
`critical` extension — and reports `outcome` as a comparison between the request and
the process's actual current runtime state:

- `'applied'` — the process's runtime state already matches the request (for example,
  disabling an extension that is already `skipped`, `stopped`, or `failed`).
- `'restart-required'` — the preference was persisted, but the process's runtime state
  diverges from it; only the next restart makes the runtime match.
- `'rejected'` — the request was refused outright and nothing was persisted.

**Boot gate (soft):** A package whose `loadEnabled` returns `false` starts in `skipped`
state rather than being excluded from the coordinator entirely, so it stays
observable and toggleable through `kernel:extension.list` / `setEnabled` even though
enabling it can only ever report `'restart-required'`.

**Coordinator-internal restarts.** `ExtensionCoordinator.applyExtensionTransition(name,
enabled)` is the primitive that actually runs the enable/disable state machine —
re-registering storage handlers, re-activating contribution processors, tearing down
cleanly on disable. It is for the coordinator's or a product package's own mechanics
(for example a dependency registry restarting a dependent that is built to tolerate
the gap), never for an operator-originated request: it does not persist anything and
does not refuse a `critical` extension. It refuses to activate an extension this
process never started (`'skipped'` state with no surfaces collected), because that
entry's boot-only contributions were never composed in the first place; a `'stopped'`
or `'failed'` entry that already started this boot restarts normally.

**Critical guard:** Extensions marked `critical: true` cannot be disabled via
`setEnabled` (RPC or CLI). If a critical extension appears in the `"disabled"` list of
the enablement file (e.g. added by hand), the runtime starts it anyway at boot and
emits a console warning, so a corrupt file cannot brick the runtime.

**Where `critical` is declared:** on the exported `MakaioExtension`, never on a
`descriptor.json` that declares a `server` entrypoint — one server entry may export
several packages (`example`, `example.child`), each with its own criticality, so a
single descriptor-level flag cannot describe them and the runtime never reads one.
`ExtensionDescriptorSchema` rejects that combination, at descriptor validation, at
discovery, and at install. A descriptor *without* a server entrypoint — detached,
CLI-only, browser-only — has no exported package: the runtime synthesizes its single
package from descriptor metadata, so the descriptor field is that package's flag and
may be declared there. Offline surfaces (`makaio extension list`/`enable`/`disable`)
follow the same rule: they read the flag from the exported package when there is one,
and from descriptor metadata only when there is not.

**Evaluation order:**

1. `MAKAIO_SKIP_EXTENSIONS` env var — acts at discovery; extensions suppressed here are
   absent from the coordinator entirely.
2. Enablement file (`$MAKAIO_HOME/config/extensions.json`) — names in `"disabled"` start
   in `skipped` state; enabling them takes effect on the next process restart.
3. Surface and runtime-environment filter — independent of enablement; cannot be
   overridden at runtime.

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
| `../packages/contracts/src/automation-trigger/` | `AutomationTriggerType`, `defineAutomationTrigger`, bindings, bus namespace |
| `../packages/services/core/src/automation-trigger/` | `AutomationTriggerRegistry`, `AutomationTriggerBindingRuntime`, built-ins, cron scheduler |
| `../packages/contracts/src/extension/contributions/hash-trigger-types.ts` | `HashTrigger`, `HashTriggerMetadata`, suggest/execute contract |

<!-- /web:hide -->
