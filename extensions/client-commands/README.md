# Makaio Client Commands

CLI extension for managing Makaio hook wiring and named client profiles in AI
client tools.

## What It Provides

| Surface | Detail |
|---------|--------|
| CLI commands | `makaio client wire`, `makaio client unwire`, `makaio client wiring`, `makaio client profile-*` |
| Bus dispatch | `client:<id>.wiring.apply`, `client:<id>.wiring.remove`, `client.wiring.list`, `client.profile.*` |

This extension is CLI-only: it has no background service and no direct storage
access. Hook installation and profile management are delegated to framework
services via the Makaio bus.

## Usage

### Install hooks into a client

```bash
# Install at user scope — scope defaults to 'user' when omitted
makaio client wire claude-code

# Install at user scope (explicit)
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

### Manage client profiles

The current extension CLI contribution model supports one subcommand layer, so
profile commands use flattened names:

```bash
makaio client profile-list claude-code
makaio client profile-create claude-code work --description "Work account"
makaio client profile-default claude-code work
makaio client profile-show claude-code work
makaio client profile-open claude-code work
makaio client profile-delete claude-code work
```

Native launch commands accept the profile name and pass it to session config
materialization:

```bash
makaio client launch claude-code --profile work
makaio claude-code --profile work
```

## Flags

### `wire`

| Argument | Short | Description |
|----------|-------|-------------|
| `<client>` | | Client identifier, e.g. `claude-code`, `codex` |
| `[scope]` | | Scope to install at, e.g. `user`, `global`, `project`. Defaults to `user` when omitted. |
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

### `profile-*`

| Command | Arguments | Description |
|---------|-----------|-------------|
| `profile-list` | `<client>` | List all profiles for a client |
| `profile-create` | `<client> <name>` | Create a named profile config directory |
| `profile-delete` | `<client> <name>` | Delete a named profile and its config directory |
| `profile-default` | `<client> <name>` | Set the default profile for a client |
| `profile-show` | `<client> <name>` | Show profile details and config directory |
| `profile-open` | `<client> <name>` | Open the profile config directory in the OS file manager |

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Bus request failed (client not loaded, runtime not running, schema error) |

## Installation

```bash
makaio extension install ./extensions/client-commands
```
