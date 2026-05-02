# @makaio/cli

Command-line interface for the Makaio Framework. Start the runtime, manage extensions, and interact with the bus — all from the terminal.

## Install

```bash
brew install --cask makaio
```

The CLI is included with the Makaio desktop app. The `makaio` command is available in your terminal after installation.

## Local Development

From the framework source checkout, start desktop development with:

```bash
yarn dev
yarn dev:electron
```

## Commands

### `makaio open`

Open the Makaio desktop app, or focus it if already running.

```bash
makaio open
```

If a Makaio instance is detected on the default port, sends `host.app.focus` via the bus to bring it to the foreground. Otherwise, launches the app path supplied by `MAKAIO_APP`. Packaged launchers set `MAKAIO_APP`; source-checkout usage should start the desktop host first with the matching development script above.

---

### `makaio auto-launch`

Manage whether Makaio starts automatically at login.

```bash
makaio auto-launch enable     # Enable auto-launch (starts hidden)
makaio auto-launch disable    # Disable auto-launch
makaio auto-launch status     # Show current status
```

Requires a running Makaio instance. On macOS this manages a Login Item. On unsupported platforms, `status` reports `supported: false`.

---

### `makaio serve`

Start the Makaio runtime — bus, services, adapters, and HTTP/WebSocket transport.

```bash
makaio serve [options]
```

| Flag | Description | Default |
|------|-------------|---------|
| `-p, --port <port>` | HTTP/WebSocket port | `6252` |
| `--host <host>` | Bind address | `127.0.0.1` |
| `--lan-bind` | Host-composition LAN mode with E2E peer key resolution | off |

For standalone non-loopback access, set `MAKAIO_BUS_SECRET` and use `--host`. The
`--lan-bind` E2E pairing path requires peer key resolution supplied by the embedding host.

```bash
makaio serve                          # Loopback, default port
makaio serve --port 7000              # Custom port
MAKAIO_BUS_SECRET=s3cret makaio serve --host 0.0.0.0   # LAN access with HMAC auth
```

---

### `makaio extension`

Manage extensions — scaffold, install, verify, and list.

#### `makaio extension init <name>`

Scaffold a new extension workspace.

```bash
makaio extension init <name> [options]
```

| Flag | Description | Default |
|------|-------------|---------|
| `--display-name <name>` | Display name in descriptor.json | Title-cased from name |
| `--surface <list>` | Comma-separated: `server`, `browser`, `cli` | `server` |
| `--scope <scope>` | npm scope (e.g. `@acme`) | none |
| `--out-dir <dir>` | Target directory | `./<name>` |

```bash
makaio extension init weather-tools --surface server,cli --scope @acme
```

#### `makaio extension install <source>`

Install an extension from npm or a local path.

```bash
makaio extension install @makaio/account-manager    # From npm registry
makaio extension install ./my-extension             # From local path (symlinked)
makaio extension install /abs/path/to/extension     # Absolute path
```

Local path installs create a symlink for live development. npm installs go to `~/.makaio/node_modules/`.

#### `makaio extension uninstall <name>`

Remove an installed extension.

```bash
makaio extension uninstall account-manager
```

#### `makaio extension list`

Show all installed extensions with source and version.

```bash
makaio extension list
```

#### `makaio extension update [name]`

Update one or all npm-installed extensions.

```bash
makaio extension update                   # Update all
makaio extension update account-manager   # Update one
```

#### `makaio extension verify`

Validate the local extension workspace against the framework contract.

```bash
makaio extension verify [--cwd <path>]
```

Checks: descriptor validity, entrypoint resolution, export shape, browser bundle compatibility.

---

### `makaio mcp-server`

Start an MCP stdio bridge backed by the Makaio bus. Reads JSON-RPC from stdin, dispatches tool calls through the connected bus.

```bash
makaio mcp-server
```

Requires a running `makaio serve` instance. Useful for integrating Makaio as an MCP server in tools like Claude Desktop.

---

### Extension Commands

Extensions contribute additional CLI commands discovered at runtime. With a server running:

```bash
makaio --help                        # See all commands including extension-contributed ones
makaio <extension-name> --help       # Help for a specific extension
makaio <extension-name>              # Interactive TUI (if the extension provides one)
makaio <extension-name> <subcommand> # Run a subcommand
```

Remote subcommands execute through the running server's `cli.execute` RPC. Bare interactive
commands are not executed over remote RPC; if a command is only available remotely and only
provides an interactive entry point, the CLI reports that interactive remote execution is
unsupported.

---

## Offline Commands

These commands work without a running server:

- `makaio open`
- `makaio extension init`
- `makaio extension install`
- `makaio extension uninstall`
- `makaio extension list`
- `makaio extension update`
- `makaio extension verify`
- `makaio --version`
- `makaio --help` (shows built-ins; extension commands require server)

---

## Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `MAKAIO_APP` | App install root or direct launch target used by `makaio open` | set by packaged launcher |
| `MAKAIO_BUS_URL` | WebSocket URL of the bus server | `ws://127.0.0.1:6252/bus` |
| `MAKAIO_BUS_SECRET` | HMAC secret for bus authentication | none (loopback only) |
| `MAKAIO_HOME` | Runtime data directory | `~/.makaio` |
| `MAKAIO_CONFIG_FILE` | Path to `makaio.config.*` | auto-detect under `MAKAIO_HOME` |
| `MAKAIO_DATABASE_PATH` | Override database file location | `~/.makaio/makaio.db` |

---

## Configuration

Root-level runtime config is resolved before command dispatch. Use `--config <path>` before the command name, or set `MAKAIO_CONFIG_FILE`, or place a `makaio.config.ts` / `.js` / `.json` in `MAKAIO_HOME`.

```bash
makaio --config ./my-config.ts serve
```

See [Configuration](../../docs/configuration.md) for the full config schema.
