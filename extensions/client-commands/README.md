# Makaio Client Commands

CLI extension for managing Makaio hook wiring in AI client tools. Provides three subcommands — `wire`, `unwire`, and `wiring` — that install, remove, and inspect Makaio hooks in the native configuration of any supported client (Claude Code, Codex, etc.).

## What It Provides

| Surface | Detail |
|---------|--------|
| CLI commands | `makaio client wire`, `makaio client unwire`, `makaio client wiring` |
| Bus dispatch | `client:<id>.wiring.apply`, `client:<id>.wiring.remove`, `client.wiring.list` |

This extension is CLI-only: it has no background service and no storage. All hook installation and removal is delegated to the per-client service via the Makaio bus.

## Usage

### Install hooks into a client

```bash
# Install at user scope (affects all projects)
makaio client wire claude-code user

# Install at project scope
makaio client wire claude-code project --project-dir /path/to/project

# Install for Codex at global scope
makaio client wire codex global
```

The installed hook command is automatically set to the `makaio` binary that ran `wire`, so re-invocations stay consistent.

### Remove hooks from a client

```bash
# Remove user-scope hooks
makaio client unwire claude-code user

# Remove project-scope hooks
makaio client unwire claude-code project --project-dir /path/to/project
```

### Inspect wiring status

```bash
# Show all clients and their hook installation status
makaio client wiring

# Filter to a single client
makaio client wiring --client claude-code

# Include project-scope entries
makaio client wiring --project-dir /path/to/project
```

Output is a grouped table showing each hook entry, its group/name, the installed command, and whether it is currently present in the client config:

```
claude-code:
  [installed] hooks/statusline  makaio claude statusline
  [missing  ] hooks/pre-tool    makaio hook received claude-code pre_tool_use
```

## Flags

### `wire`

| Argument | Short | Description |
|----------|-------|-------------|
| `<client>` | | Client identifier, e.g. `claude-code`, `codex` |
| `<scope>` | | Scope to install at, e.g. `user`, `global`, `project` |
| `--project-dir` | `-d` | Absolute path to project directory (required for project scopes) |

### `unwire`

| Argument | Short | Description |
|----------|-------|-------------|
| `<client>` | | Client identifier |
| `<scope>` | | Scope to remove from |
| `--project-dir` | `-d` | Absolute path to project directory (required for project scopes) |

### `wiring`

| Argument | Short | Description |
|----------|-------|-------------|
| `--client` | `-c` | Filter to a single client identifier |
| `--project-dir` | `-d` | Include project-scope entries for this directory |

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Bus request failed (client not loaded, runtime not running, schema error) |

## Installation

```bash
makaio extension install ./extensions/client-commands
```

---

*Part of the [Makaio AI Framework](../../README.md)*
