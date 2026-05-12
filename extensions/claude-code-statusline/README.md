# Makaio Claude Code Statusline

A CLI bridge that intercepts Claude Code's native statusline hook, parses the JSON payload, and emits it on the Makaio bus. An optional upstream renderer can be chained so existing statusline display tools continue to work alongside Makaio's live session tracking.

## What It Provides

| Surface | Detail |
|---------|--------|
| CLI command | `makaio claude statusline` — reads stdin, emits to bus, proxies to upstream |
| Bus event | `client:claude-code.statusline.received` — raw `ClaudeCodeStatuslineRawPayload` |

## How It Works

Claude Code invokes the configured statusline command on every prompt cycle, passing a JSON blob on stdin that includes session ID, model info, workspace paths, token usage, and cost. This extension:

1. Reads the JSON blob from stdin.
2. Validates and parses it against `ClaudeCodeStatuslineRawPayload`.
3. Emits it on `client:claude-code.statusline.received` so other services (e.g., the account manager's usage tracker) can react.
4. Optionally spawns an upstream renderer and forwards the original stdin text into it, preserving the display behavior of any pre-existing statusline tool.

All operations are fail-open: invalid JSON and bus or upstream failures are silently swallowed so Claude Code's operation is never disrupted.

## Usage

### Configure as Claude Code's statusline command

Add to your Claude Code settings (`.claude/settings.json` at user or project scope):

```json
{
  "statusCommand": "makaio claude statusline"
}
```

### Chain with an existing renderer

If you already have a statusline renderer (e.g., `starship`), chain it:

```bash
makaio claude statusline -u starship --upstream-args-json '["prompt", "--no-newline"]'
```

Pass the upstream executable via `--upstream-command` (or `-u`) and its arguments as a JSON array via `--upstream-args-json`.

### Wire automatically

Use the `client-commands` extension to install the hook into Claude Code's config:

```bash
makaio client wire claude-code user
```

## Flags

| Flag | Description |
|------|-------------|
| `--upstream-command`, `-u` | Executable to spawn after emitting to the bus |
| `--upstream-args-json` | JSON array of arguments for the upstream command |

## Installation

```bash
makaio extension install ./extensions/claude-code-statusline
```
