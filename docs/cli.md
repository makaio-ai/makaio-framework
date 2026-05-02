---
title: CLI
description: Command-line interface for running Makaio sessions, managing extensions, and development tooling.
---

The `makaio` CLI is a thin client that connects to a running Makaio server and dispatches
commands to it. The server itself can run as `makaio serve` (headless) or through a desktop host.
All heavy work — service logic, storage, adapters — lives in the server process. The CLI process
connects, runs one command, and exits.

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│  makaio serve  (or a desktop host)              │
│                                                  │
│  Hono HTTP server  :6252                         │
│  ├── GET /health                                 │
│  └── /bus  ── WebSocket upgrade                  │
│                        ↑                         │
│  ExtensionCoordinator  │  loads extensions       │
│  bootMakaioRuntime     │  boots services         │
└──────────────────────────────────────────────────┘
              ▲   WebSocket ws://127.0.0.1:6252/bus
              │
┌─────────────────────────────────────────────────┐
│  makaio <command> [subcommand] [options]         │
│                                                  │
│  - connects to one bus client for invocation    │
│  - dispatches to matched extension handler      │
│  - exits                                        │
└─────────────────────────────────────────────────┘
```

For `makaio serve`, the `/bus` endpoint is **not** a Hono route — it is a raw WebSocket
`upgrade` handler attached directly to the Node.js HTTP server via `createBusUpgradeHandler`.
A Hono GET route at `/bus` exists only to return HTTP 426 for plain HTTP probes. The upgrade
handler path-gates requests so non-bus upgrades (e.g., Vite HMR) pass through to other
listeners.

`makaio serve` emits `MAKAIO_PORT=<port>` to stdout once the bus transport is ready.
Process supervisors and integration tests use this line to know the server is accepting
connections.

---

## Installation

The `makaio` launcher script execs the bundled Bun runtime in the Electrobun app bundle
with the CLI entry point (`cli.mjs`). No `ELECTRON_RUN_AS_NODE` mode switch is needed:
Bun is a native runtime. Install via Homebrew Cask:

```bash
brew install --cask makaio
```

---

## Usage

```
makaio [command] [options]
```

Root-level runtime config is resolved before command registration. Put `--config <path>`
before the command name to select a specific `makaio.config.ts`, `makaio.config.js`,
or `makaio.config.json`; otherwise the CLI checks `MAKAIO_CONFIG_FILE` and then the
default config under `MAKAIO_HOME` (`~/.makaio` by default).

### `makaio open`

Open the Makaio desktop app, or focus it if already running.

```bash
makaio open
```

If a Makaio instance is detected on the default port (`6252`), sends `host.app.focus` via
the bus to bring the existing window to the foreground. Otherwise, launches the desktop
app path supplied by `MAKAIO_APP`.

Packaged launchers set `MAKAIO_APP` to the app install root. Direct framework-repo usage
is a development path: start the desktop host with `yarn dev:electron`, then run
`makaio open` to focus it.

### `makaio auto-launch`

Manage whether Makaio starts automatically at login.

```bash
makaio auto-launch enable     # Enable auto-launch (starts hidden)
makaio auto-launch disable    # Disable auto-launch
makaio auto-launch status     # Show current status
```

Requires a running Makaio instance (`makaio open` or the desktop app). On macOS, this manages a Login Item. On unsupported platforms, `status` reports `supported: false`.

### `makaio serve`

Start the Makaio server — bus, services, HTTP endpoint, and all loaded extensions.

```
makaio serve [options]

Options:
  -p, --port <port>   HTTP/WebSocket port (default: 6252)
  --host <host>       Bind address override (default: 127.0.0.1)
  --lan-bind          Host-composition LAN mode. Requires a peer-signing-key resolver
                      supplied by the embedding host.
```

**Examples:**

```bash
# Start on the default loopback port
makaio serve

# Start on a custom port
makaio serve --port 7000

# Expose on the local network (requires MAKAIO_BUS_SECRET)
MAKAIO_BUS_SECRET=mysecret makaio serve --host 0.0.0.0
```

### `makaio extension init <name>`

Create a new local extension workspace scaffold.

This command is a local builtin. It does not probe `/health`, does not connect
to the bus, and does not require a running Makaio server.

```bash
makaio extension init my-extension [options]

Options:
  --display-name <displayName>   Display name written to descriptor.json
  --surface <surfaceList>        Comma-separated surfaces: server,browser,cli
                                 (default: server)
  --scope <scope>                Optional npm scope, for example @acme
  --out-dir <outDir>             Target directory (default: ./<name>)
```

The current supported path is repo-local authoring inside the framework workspace.
`init` writes `package.json`, `descriptor.json`, `tsconfig.json`,
`tsconfig.repo-dev.json`, `tsdown.config.ts`, `vitest.config.ts`, `README.md`,
repo-dev helper scripts, `test/verify.test.ts`, and the selected `src/*`
entrypoints.

The generated source tree is explicit about its modes:

- repo-dev source mode for contributors working inside the framework repo
- staged portable source package mode via `yarn prepare:portable-package`

Run `yarn install` in the generated extension before invoking `yarn build`,
`yarn test`, or `yarn verify`. `yarn prepare:portable-package` is self-contained
and can run before that install step.

### `makaio extension verify`

Validate a local extension workspace against the current authoring contract.

This command is also a local builtin and runs entirely on the filesystem.

```bash
makaio extension verify [options]

Options:
  --cwd <cwd>   Extension root to verify (default: current working directory)
```

Current checks include:

- `descriptor.json` parses against `ExtensionDescriptor`
- declared entrypoints resolve to an existing `src/<stem>.ts` or `dist/<stem>.mjs`
  within the extension root
- server entry default export is `MakaioExtension`-like
- CLI entry default export is an executable `CliContribution`
- browser bundle is parseable/loadable ESM
- browser bundle uses only framework-owned shared bare specifiers
- browser bundle remains compatible with the host static-root contract

### `makaio <extension-command> [subcommand] [options]`

Run a command contributed by a loaded extension. The CLI connects to the running
server, dispatches to the matched handler over the bus, and exits.

```bash
# Launch an extension's interactive TUI (if the extension defines one)
makaio <extension-name>

# Run a specific subcommand
makaio <extension-name> <subcommand> [options]

# Show help for an extension command
makaio <extension-name> --help
```

**Dispatch rules:**

| Invocation | Result |
|------------|--------|
| `makaio <name>` | Interactive TUI (if `cli.interactive` is defined), otherwise help |
| `makaio <name> <subcommand>` | Runs the matched subcommand handler |
| `makaio <name> --help` | Auto-generated help from subcommand schemas |

### `makaio --help`

List all available commands, including those contributed by loaded extensions.

### `makaio --version`

Print the CLI version string.

---

## Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `MAKAIO_APP` | App install root or direct launch target used by `makaio open` | set by packaged launcher |
| `MAKAIO_BUS_URL` | WebSocket URL of the running bus server | `ws://127.0.0.1:6252/bus` |
| `MAKAIO_BUS_SECRET` | HMAC shared secret for bus authentication | _(none — loopback only)_ |
| `MAKAIO_CONFIG_FILE` | Runtime config file path used when root `--config` is omitted | _(auto-detect under `MAKAIO_HOME`)_ |
| `MAKAIO_DATABASE_PATH` | Override the database file location | `~/.makaio/makaio.db` |
| `MAKAIO_HOME` | Runtime data home for config, databases, extension installs, and machine keys | `~/.makaio` |
| `MAKAIO_RELAY_URL` | Relay server WebSocket URL for browser-to-machine pairing | _(none — relay disabled)_ |

`MAKAIO_BUS_URL` is the primary override for pointing the CLI at a non-default server
(e.g., a remote or port-forwarded instance). The CLI probes `/health` before connecting
and uses the advertised auth mode to decide whether to send HMAC credentials.

---

## How Extension Commands Are Registered

CLI command definitions now converge on one runtime-managed catalog.

### Runtime-managed command catalog

Extensions contribute executable `CliContribution`s on their `MakaioExtension`. During boot,
the `ExtensionCoordinator` collects those contributions and exposes them over `cli.*` RPC:

- `cli.listContributions` returns serializable `CliManifest` metadata
- `cli.execute` validates args and runs the selected subcommand on the host

The standalone CLI process connects to the running server, registers Commander commands
from that manifest list, and dispatches subcommands remotely.

### Descriptor-backed extensions

Extensions start from `descriptor.json` and use one execution path. The descriptor's
`cli` field provides serializable command metadata, while `entrypoints.cli` declares the
CLI surface stem resolved by the shared `src/<stem>.ts` then `dist/<stem>.mjs` convention.
During host boot, descriptor-declared CLI entrypoints are imported and attached to the
same runtime extension graph, so descriptor-backed commands are discovered and executed
through the same `cli.*` RPC flow.

The single framework CLI/runtime entry selects descriptor sources from `makaio.config.*`:

- `extensions.discoveryPaths` sets descriptor roots or package roots to scan
- `extensions.include` and `extensions.exclude` filter descriptor names
- `extensions.autoDiscover` controls whether unmatched discovered descriptors load by default
- `packageConfigDefaults` supplies descriptor-backed extension config defaults by extension name

Filesystem discovery precedence is:

- local
- installed
- global-npm

### Command precedence

Built-ins win over remotely discovered commands. `main.ts` skips any remote command whose
name collides with an already registered builtin such as `serve` or `extension`.

### Defining commands

Extensions never import Commander directly. Extensions define commands using Zod
schemas with `.meta()` for CLI metadata (descriptions, short flags, positional markers).
The CLI router (`../apps/cli`) converts those schemas into Commander commands at
registration time — Commander is an implementation detail of the CLI app, not the extension
contract.

```ts
import { z } from 'zod';
import { defineCliSubcommand, type CliContribution } from '@makaio/kernel/cli';

export const cli: CliContribution = {
  name: 'my-package',
  description: 'Manage my-package resources',

  // Optional: launched by bare `makaio my-package`
  // (dispatch wiring + TTY guard implemented; Ink rendering framework not yet provided)
  interactive: async ({ bus }) => {
    // Render a TUI using bus RPC
  },

  // hasInteractive is derived automatically in the serializable manifest returned over cli.*

  subcommands: [
    defineCliSubcommand(
      'list',
      'List all resources',
      z.object({
        format: z.enum(['table', 'json']).default('table').meta({
          description: 'Output format',
          short: '-f',
        }),
      }),
      async ({ args, bus }) => {
        // args.format → 'table' | 'json'
        // bus → connected IMakaioBus
      },
    ),
  ],
};
```

See [Extensions](./extensions/) for how to declare this in a full
`MakaioExtension`.

---

## Security

**Loopback mode (default):** The server binds to `127.0.0.1` only. No authentication
is required — only processes on the local machine can reach the bus.

**Host-composed LAN mode (`--lan-bind`):** The server binds to `0.0.0.0` and provisions
`DispatchingAuth`, but the E2E pairing path requires a `peerSigningKeyResolver` supplied
by the embedding host. The standalone CLI path should use `--host` plus
`MAKAIO_BUS_SECRET` for non-loopback access.

**Non-loopback `--host`:** Using `--host <non-loopback-addr>` without `--lan-bind`
requires `MAKAIO_BUS_SECRET` to be set. The server refuses to start on any non-loopback
address without authentication (`serve.ts`). Unlike `--lan-bind`, plain `--host`
does not auto-provision `DispatchingAuth`.

**Client auth:** The CLI client probes `/health`, resolves the advertised auth mode, and
sends HMAC credentials when the server requires them. This closes the earlier gap where
`MAKAIO_BUS_SECRET` was only applied server-side.

---

## Current Operational Notes

### Ink rendering framework for interactive TUI

**Status:** Non-interactive discovery and remote subcommand execution are implemented.
Bare interactive commands are still not executed over remote RPC; the CLI currently reports
that interactive entrypoints are unsupported via remote execution. What remains is deciding
whether interactive commands stay launcher-local or gain a different transport/runtime path.

**Reference:**
- `../apps/cli/src/main.ts`
- `../packages/kernel/src/extension/cli-rpc-handlers.ts`

### `--host` and `--lan-bind` overlap

**Status:** `--host <addr>` and `--lan-bind` partially overlap. Both enable non-loopback
binding, but `--lan-bind` also provisions `DispatchingAuth` and requires host-provided
peer key resolution, while `--host` with a non-loopback address requires
`MAKAIO_BUS_SECRET` to be set (throws at startup otherwise). The two flags are not yet
well-unified.

**Reference:** `../apps/cli/src/serve.ts` — `resolveAuth()` and non-loopback guard
