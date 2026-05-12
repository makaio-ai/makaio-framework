# Makaio Client Hook Bridge

A generic CLI bridge that forwards raw hook events from any AI client tool (Claude Code, Codex, etc.) to the Makaio bus. Client tools invoke it from their native hook configuration; the bridge reads the event payload from stdin and emits it verbatim without any semantic interpretation.

## What It Provides

| Surface | Detail |
|---------|--------|
| CLI command | `makaio hook received <client> <event-name>` |
| Bus event | `client:<clientId>.hook.received` — raw `RawClientHookPayload` |
| Bus request (best-effort) | `client.runtime.observe` — when metadata carries hard runtime evidence |

This extension is CLI-only: it has no background service and no storage.

## How It Works

1. Reads JSON from stdin (fail-open: empty or invalid input emits `{}` as the payload).
2. Emits `client:<clientId>.hook.received` with `{ eventName, receivedAt, payload, metadata? }`.
3. When the optional `--metadata-json` flag contains hard runtime evidence (`pid`, `supervisorSessionId`, or `adapterSessionId`), fires a best-effort `client.runtime.observe` request so the runtime registry can track the client process.

The bridge is intentionally dumb — it never normalizes or interprets event names or payloads. Downstream services decide how to react.

## Usage

### From a client hook configuration

Configure the client to invoke `makaio hook received` as a hook command. For Claude Code, add to `.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "makaio hook received claude-code pre_tool_use"
          }
        ]
      }
    ]
  }
}
```

### With metadata for runtime tracking

Pass process-level metadata via `--metadata-json` so Makaio can correlate the hook event with the running client process:

```bash
makaio hook received claude-code session_started \
  --metadata-json '{"pid": 12345, "supervisorSessionId": "abc-123"}'
```

### Wire automatically

Use the `client-commands` extension to install hooks into the client's native config at the correct scope:

```bash
makaio client wire claude-code user
```

## Arguments

| Argument | Description |
|----------|-------------|
| `<client>` | Stable lowercase client identifier, e.g. `claude-code`, `codex` |
| `<event-name>` | Hook event name as reported by the native client, e.g. `pre_tool_use`, `session_started` |
| `--metadata-json` | Optional JSON object for pass-through context (e.g. `{ "pid": 1234 }`) |

## Bus Events Emitted

### `client:<clientId>.hook.received`

Emitted for every invocation regardless of metadata content.

```ts
{
  eventName: string;       // e.g. "pre_tool_use"
  receivedAt: number;      // epoch ms
  payload: Record<string, unknown>;  // parsed stdin JSON, or {}
  metadata?: Record<string, unknown>; // omitted when --metadata-json is absent
}
```

### `client.runtime.observe` (best-effort request)

Fired only when `metadata` contains at least one of `pid`, `supervisorSessionId`, or `adapterSessionId`. Missing handlers are silently ignored.

## Installation

```bash
makaio extension install ./extensions/client-hooks
```
