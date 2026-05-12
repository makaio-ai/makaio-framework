---
title: Creating Extensions
description: Build extensions that add functionality to Makaio through bus handlers, tools, and namespace registration.
---

Extensions are the primary composition model in Makaio. An extension is a runtime module
discovered via `descriptor.json`, loaded by `ExtensionCoordinator`, and lifecycle-managed
through the same descriptor-backed pipeline.

This guide covers scaffolding, surfaces, CLI authoring (with positional args and interactive
TUI), browser UI contributions, verification, and the build/publish workflow.

---

## Quick Start

```bash
# Scaffold a new extension with server + CLI surfaces
makaio extension init my-extension --surface server,cli

# Or with all three surfaces (server, browser, cli)
makaio extension init my-extension --surface server,browser,cli --scope @acme

# During local framework source checkout development
yarn dev:cli extension init my-extension --surface server,cli
```

This creates a workspace with:

```
my-extension/
├── descriptor.json          # Discovery contract (canonical metadata)
├── package.json             # Workspace with link: deps to framework packages
├── src/
│   ├── server.ts            # Server entrypoint (MakaioExtension)
│   ├── cli.ts               # CLI entrypoint (CliContribution)
│   └── browser.ts           # Browser entrypoint (ExtensionBrowserFactory)
├── test/
│   └── verify.test.ts       # Contract verification tests
├── scripts/
│   ├── package-mode.ts      # Repo-dev vs portable mode helpers
│   ├── run-with-mode.ts     # Mode-aware script runner
│   └── prepare-portable-package.mjs  # Portable source staging
├── tsconfig.json
├── tsconfig.repo-dev.json   # Path overrides for local framework source resolution
├── tsdown.config.ts         # Build config using framework preset
└── vitest.config.ts
```

After scaffolding inside a local framework source checkout, run `yarn install` from the
source checkout so Yarn picks up the new workspace, then:

```bash
yarn workspace @acme/my-extension build    # Build dist outputs
yarn workspace @acme/my-extension test     # Run tests
yarn workspace @acme/my-extension verify   # Run contract verification
```

For a standalone generated extension, run the same lifecycle from the extension directory:

```bash
yarn install
yarn build
yarn test
yarn verify
```

---

## Surfaces

Extensions declare which surfaces they provide. Each surface has a separate entrypoint:

| Surface | Entrypoint | Export type | Purpose |
|---------|-----------|-------------|---------|
| `server` | `src/server.ts` | `MakaioExtension` | Background services, bus handlers, storage, adapters, tools |
| `cli` | `src/cli.ts` | `CliContribution` | CLI subcommands and interactive TUI |
| `browser` | `src/browser.ts` | `ExtensionBrowserFactory` | Framework browser contributions (`shell`, `pages`, `pageDefinitions`, `widgets`) |

Select surfaces at scaffold time with `--surface server,cli,browser`. At minimum, one
surface must be selected.

---

## Server Entrypoint

The server entrypoint exports a `MakaioExtension` — the central contract for what an
extension contributes to the runtime.

```typescript
import type { MakaioExtension } from '@makaio/contracts';

const extension: MakaioExtension = {
  name: 'my-extension',
  displayName: 'My Extension',
};

export default extension;
```

A minimal extension declares only `name` and `displayName`. As the extension grows, add
contribution surfaces:

```typescript
import type { MakaioExtension } from '@makaio/contracts';
import { MyService } from './service.js';

const extension: MakaioExtension = {
  name: 'my-extension',
  displayName: 'My Extension',

  // Background service (extends BaseService)
  create: (ctx) => new MyService(ctx),

  // If true, runtime startup fails when this extension fails to initialize
  critical: false,
};

export default extension;
```

The `create` factory receives an `ExtensionContext` with access to the bus, data directory,
configuration, and other extensions. The returned service follows the `BaseService` lifecycle:
`init()` → active → `destroy()`.

---

## Bus Integration

Extensions communicate with the rest of the system through the bus. To send and receive
typed messages, register an **extension namespace** with Zod schemas.

### Defining an Extension Namespace

```typescript
// src/namespace.ts
import { z } from 'zod';
import { createExtensionNamespace } from '@makaio/bus-core';

const MySchemas = {
  // Event — single Zod schema (fire-and-forget)
  somethingHappened: z.object({
    itemId: z.string(),
    detail: z.string(),
  }),

  // Request — { request, response } pair (RPC)
  getData: {
    request: z.object({
      limit: z.number().int().min(1).optional(),
    }),
    response: z.object({
      items: z.array(z.object({ id: z.string(), value: z.string() })),
    }),
  },
} as const;

const MyNamespace = createExtensionNamespace('my-extension', {
  schemas: MySchemas,
});

export const MySubjects = MyNamespace.subjects;
```

`createExtensionNamespace` registers the namespace under `extension:my-extension.*` and
returns typed subject references. TypeScript infers handler and response types directly
from the Zod schemas — no manual type annotations needed.

### Server-Side: Handling Requests and Emitting Events

Use `ctx.bus.on()` to register a request handler and `ctx.bus.emit()` to fire events:

```typescript
// src/server.ts
import type { MakaioExtension, ExtensionContext, ExtensionServiceLifecycle } from '@makaio/contracts';
import { MySubjects } from './namespace.js';

const extension: MakaioExtension = {
  name: 'my-extension',
  displayName: 'My Extension',

  create(ctx: ExtensionContext): ExtensionServiceLifecycle {
    let unsubscribe: (() => void) | null = null;

    return {
      async init() {
        // Register a typed request handler
        unsubscribe = ctx.bus.on(MySubjects.getData, ({ payload, setResult }) => {
          const limit = payload.limit ?? 10;
          setResult({ items: [{ id: '1', value: 'hello' }].slice(0, limit) });
        });

        // Emit a typed event
        await ctx.bus.emit(MySubjects.somethingHappened, {
          itemId: '1',
          detail: 'Extension initialized',
        });
      },

      async destroy() {
        unsubscribe?.();
      },
    };
  },
};

export default extension;
```

### Client-Side: Making Bus Requests from the CLI

CLI subcommands receive the bus via `ctx.bus`. Use `bus.request()` with the typed subject:

```typescript
// src/cli.ts (excerpt)
import { MySubjects } from './namespace.js';

const fetchData = defineCliSubcommand(
  'fetch',
  'Fetch data from the server-side extension',
  z.object({
    limit: z.number().optional().meta({ description: 'Max items', short: '-n' }),
  }),
  async ({ args, bus, output }) => {
    // Typed request — response shape inferred from the Zod schema
    const { items } = await bus.request(MySubjects.getData, {
      limit: args.limit ?? 10,
    });

    for (const item of items) {
      output.write(`${item.id}: ${item.value}\n`);
    }
  },
);
```

`ctx.bus` is a connected `IMakaioBus` by the time a subcommand handler runs. If the
server is unavailable, the CLI connection layer reports that before invoking extension
handlers.

### Subscribing to Framework Events

Extensions can subscribe to framework-level events without defining their own namespace.
Each framework namespace exposes a `$all` wildcard for namespace-wide subscriptions:

```typescript
import { AgentSubjects, AdapterSubjects } from '@makaio/contracts';

// Subscribe to all agent events
ctx.bus.on(AgentSubjects.$all, (context) => {
  console.info(`[${context.type}] ${context.subject}`);
});

// Subscribe to a specific event
ctx.bus.on(AgentSubjects.started, (context) => {
  console.info(`Agent started: ${context.payload.agentId}`);
});
```

### `__onAny` (Dev/Debug Only)

`bus.__onAny()` registers a handler that receives every message across all namespaces.
**This is a no-op in production** (`NODE_ENV=production`) — use it only for debugging,
logging, and development tooling:

```typescript
const unsubscribe = ctx.bus.__onAny((msgCtx) => {
  console.debug(`[${msgCtx.type}] ${msgCtx.subject}`, msgCtx.payload);
});
```

For full bus documentation, see [Bus Architecture](./architecture/bus/).

---

## CLI Entrypoint

The CLI entrypoint exports a `CliContribution` with named subcommands and an optional
interactive handler.

### Basic Subcommand

```typescript
import { z } from 'zod';
import { defineCliSubcommand, type CliContribution } from '@makaio/kernel/cli';

const greet = defineCliSubcommand(
  'greet',
  'Say hello to someone',
  z.object({
    name: z.string().meta({
      description: 'Who to greet',
      positional: true,
      placeholder: '<name>',
    }),
    loud: z.boolean().optional().meta({
      description: 'Shout the greeting',
      short: '-l',
    }),
  }),
  async ({ args, output }) => {
    const greeting = `Hello, ${args.name}!`;
    output.write(args.loud ? `${greeting.toUpperCase()}\n` : `${greeting}\n`);
  },
);

const cliContribution: CliContribution = {
  name: 'my-extension',
  description: 'My extension CLI commands',
  subcommands: [greet],
};

export default cliContribution;
```

Usage: `makaio my-extension greet World --loud`

### Positional Arguments

Mark schema fields as positional with `.meta({ positional: true })`:

```typescript
z.object({
  // Required positional — rendered as <name>
  name: z.string().meta({
    description: 'Name of the item',
    positional: true,
    placeholder: '<name>',
  }),
  // Optional positional — rendered as [target]
  target: z.string().optional().meta({
    description: 'Target directory',
    positional: true,
    placeholder: '[target]',
  }),
  // Named option with short flag
  verbose: z.boolean().optional().meta({
    description: 'Verbose output',
    short: '-v',
  }),
})
```

The Zod schema is the single source of truth for CLI args. `descriptor.json` keeps only
stable pointer metadata (subcommand names and descriptions) so the top-level help tree can
render without importing extension code. The richer arg metadata is derived at runtime by
introspecting the live Zod schema.

### Subcommand Handler Context

The handler receives a typed context object:

```typescript
defineCliSubcommand('do-thing', 'Does the thing', schema, async (ctx) => {
  ctx.args;          // Typed, validated args from the Zod schema
  ctx.bus;           // Connected IMakaioBus instance
  ctx.output;        // { write(text), error(text) } — use instead of console.*
  ctx.signal;        // AbortSignal for cancellation
  ctx.setExitCode(n) // Set process exit code
});
```

### Interactive TUI

For extensions that provide a terminal UI (e.g., using [Ink](https://github.com/vadimdemedes/ink)),
add an `interactive` handler to the `CliContribution` and set `hasInteractive: true` in
the descriptor.

**In `src/cli.ts`:**

```typescript
const cliContribution: CliContribution = {
  name: 'my-extension',
  description: 'My extension',

  interactive: async ({ bus }) => {
    // Lazy-import TUI dependencies to avoid loading them for non-interactive commands
    const { render } = await import('ink');
    const React = await import('react');
    const { App } = await import('./tui/app.js');

    const instance = render(React.createElement(App, { bus }));
    await instance.waitUntilExit();
  },

  subcommands: [greet],
};
```

**In `descriptor.json`** — the `cli` block declares the interactive flag and subcommand
metadata. The `entrypoints` section just enables the surface:

```json
{
  "entrypoints": { "cli": true },
  "cli": {
    "name": "my-extension",
    "hasInteractive": true,
    "subcommands": [...]
  }
}
```

The interactive handler is invoked when the user runs the bare command without a subcommand
(`makaio my-extension`). The framework guards against non-TTY environments automatically.

**Lazy imports are important:** The `interactive` handler should dynamically import Ink/React
so that non-interactive subcommands don't pay the startup cost.

---

## Browser Entrypoint

The browser entrypoint exports an `ExtensionBrowserFactory` — a function that returns UI
contribution declarations:

```typescript
import type { ProductExtensionBrowserContribution } from '@makaio/web-framework/extension-browser';

const browserContribution = (): ProductExtensionBrowserContribution => ({
  // All fields are optional — declare only what you contribute
  // shell:           { component: Shell },
  // pages:           [...],
  // pageDefinitions: [...],
  // widgets:         [...],
  // destroy:         () => cleanup(),
});

export default browserContribution;
```

The framework browser path is:

1. `descriptor.json` declares `entrypoints.browser`
2. the platform bridge publishes `ExtensionInfo.browser.entrypoint`
3. `ExtensionBrowserLoader` imports that URL
4. the imported default must resolve to a callable `ExtensionBrowserFactory`
5. the factory returns `shell`, `pages`, `pageDefinitions`, `widgets`, and optional `destroy`

Browser bundles are served by `ExtensionBrowserLoader`. Browser entrypoint runtime bare imports
must use only the framework-owned browser authoring externals:

- `react`
- `react-dom`
- `react/jsx-runtime`
- `@makaio/web-framework/extension-browser`

Type-only imports from framework packages are erased from the emitted browser bundle. Do not add
runtime bare imports such as `@makaio/ui-hooks` or the root `@makaio/web-framework` barrel to
extension browser entrypoints. Use `@makaio/web-framework/extension-browser` for browser
contribution contracts and helpers; renderer-only UI hooks must come from documented
browser-safe subpaths. The root barrel may remain in the host shared externals list for legacy
host-owned chunks, but extension browser entries should not target it. The build preset handles
the shared externalization automatically.

For the full browser extension architecture, renderer lifecycle, and framework web primitives,
see [Browser & UI](./architecture/extensions/browser).

---

## Descriptor (`descriptor.json`)

The descriptor is the universal discovery contract. It is canonical metadata — the framework
reads it to discover and load extensions without importing their code.

```json
{
  "name": "my-extension",
  "displayName": "My Extension",
  "version": "0.1.0",
  "makaio": {
    "minVersion": "0.1.0"
  },
  "entrypoints": {
    "server": true,
    "browser": true,
    "cli": true
  },
  "cli": {
    "name": "my-extension",
    "description": "CLI commands for My Extension",
    "hasInteractive": true,
    "subcommands": [
      {
        "name": "greet",
        "description": "Say hello to someone"
      }
    ]
  },
  "execution": "embedded"
}
```

### Entrypoint Resolution

Entrypoints are declared as `true` to use the surface name as the stem, or as a string
to use a custom stem:

| Value | Resolved stem | Example |
|-------|--------------|---------|
| `true` | surface name | `"server": true` → `server` |
| `"<stem>"` | custom stem | `"cli": "commands/index"` → `commands/index` |

The framework resolves the actual file path by convention:

1. **Dev:** `src/{stem}.ts` — TypeScript source, imported directly via tsx/Node loaders
2. **Prod:** `dist/{stem}.mjs` — built ESM output

The descriptor stays identical across dev and production. In production, `src/` is not
shipped, so resolution naturally falls through to `dist/`.

**Key rules:**
- `descriptor.name` owns the runtime extension namespace; `package.json.name` is distribution
  metadata and may be scoped or otherwise differ
- Source lives in `src/`, built output in `dist/` — this convention is not configurable
- Custom entrypoint strings are stems, not file paths; do not include `src`, `dist`, or file extensions
- Entrypoints must not escape the extension root directory
- CLI subcommand args in the descriptor are optional pointers — the live Zod schema is the
  source of truth

---

## Verification

Run `makaio extension verify` (or `yarn workspace <name> verify`) to validate:

- `descriptor.json` parses against `ExtensionDescriptorSchema`
- Declared entrypoints resolve to existing files (source or dist)
- Resolved entrypoints don't escape the extension root (symlink containment check)
- Server entrypoint default-exports a valid `MakaioExtension`
- CLI entrypoint default-exports a valid `CliContribution`
- Browser entrypoint contains no unsupported bare imports
- Browser entrypoint is parseable/loadable ESM
- Browser bundle doesn't reach outside the static root

The scaffolded `test/verify.test.ts` runs these checks as a test suite, ensuring the
contract holds across builds.

---

## Build

Extensions use the framework build preset via `tsdown`:

```typescript
// tsdown.config.ts
import { defineExtensionConfig } from '@makaio/build-tooling/tsdown-extension-preset';

export default defineExtensionConfig({
  entry: {
    server: './src/server.ts',
    cli: './src/cli.ts',
  },
});
```

The preset handles output format (ESM `.mjs`), externalization of framework packages, and
source maps. In a local framework source checkout, the scaffold's `run-with-mode.ts` script
sets `MAKAIO_EXTENSION_MODE=repo-dev` so builds resolve against local framework sources via
`link:` dependencies.

### Adapter package versioning

Framework and adapter packages may all start at `0.1.0`. The versioning contract follows
semantic versioning with the following conventions during the `0.x` phase:

- **Patch bumps** (`0.x.y → 0.x.(y+1)`) are compatible fixes — no breaking API changes.
- **Minor bumps** (`0.x → 0.(x+1)`) while in `0.x` may include breaking changes, consistent
  with the semver `0.x` pre-stable convention.
- **`peerDependencies["@makaio/framework"]`** is the compatibility contract. Consumers use it
  to pin the range of framework versions a given adapter version supports.

When the framework reaches `1.0`, the standard semver breaking-change semantics apply.

---

## Package Modes

Extensions support two modes:

| Mode | When | How |
|------|------|-----|
| **repo-dev** | Developing inside a local framework source checkout | `link:` deps resolve to framework source. `tsconfig.repo-dev.json` provides path overrides. |
| **portable** | Distributing as a standalone package | `yarn prepare:portable-package` stages a source package under `build/portable-source/` with versioned `^x.y.z` framework dependencies instead of `link:` paths. |

The `scripts/package-mode.ts` helper exposes `isRepoDevMode()` and `createRepoDevAliases()`
for build and test configs to switch behavior based on `MAKAIO_EXTENSION_MODE`.

---

## Scaffold Options Reference

```
makaio extension init <name> [options]

Arguments:
  name                    Canonical extension name

Options:
  --display-name <name>   Display name (default: title-cased from name)
  --surface <list>        Comma-separated: server,browser,cli (default: server)
  --scope <scope>         npm scope for package.json (e.g. @acme)
  --out-dir <dir>         Target directory (default: ./<name>)
```
