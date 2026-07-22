# Makaio Client Hook Bridge

A generic CLI bridge that forwards raw hook events from any AI client tool (Claude Code, Codex, etc.) to the Makaio bus. Client tools invoke it from their native hook configuration; the bridge reads the event payload from stdin and emits it verbatim without any semantic interpretation.

## What It Provides

| Surface | Detail |
|---------|--------|
| CLI command | `makaio hook received <client> <event-name>` |
| CLI command | `makaio hook handle <client> <event-name>` |
| Bus event | `client:<clientId>.hook.received` — raw `RawClientHookPayload` |
| Bus request | `client:<clientId>.hook.handle` — request/response round-trip |
| Bus request (best-effort) | `client.runtime.observe` — when metadata carries hard runtime evidence |

This extension is CLI-only: it has no background service and no storage.

## How It Works

### `hook received` — fire-and-forget

1. Reads JSON from stdin (fail-open: empty or invalid input emits `{}` as the payload).
2. Emits `client:<clientId>.hook.received` with `{ eventName, receivedAt, payload, metadata? }`.
3. When the optional `--metadata-json` flag contains hard runtime evidence (`pid`, `supervisorSessionId`, or `adapterSessionId`), fires a best-effort `client.runtime.observe` request so the runtime registry can track the client process.

### `hook handle` — request/response bridge

1. Reads JSON from stdin exactly once.
2. Emits `hook.received` (identical to the `received` command — observation is never lost).
3. Fires a best-effort `client.runtime.observe` request when metadata contains evidence.
4. Issues a `bus.requestOptional` call on `client:<clientId>.hook.handle` with the CLI's `--timeout` as a relative timeout.
5. Writes the handler's `stdout`, `stderr`, and `exitCode` verbatim to the process streams.

The bridge is intentionally dumb — it never normalizes, interprets, parses, or merges event names, payloads, or responses. Downstream services decide how to react; the bridge passes through.

## Deadline Awareness

The bridge is deadline-aware without minting its own deadlines:

- The CLI `--timeout` flag specifies a **relative timeout** in milliseconds (default: 5000ms).
- The bridge passes this relative timeout to `bus.requestOptional()` — it never computes or serializes an absolute deadline into the payload.
- The bus internally mints the absolute deadline (`Date.now() + timeout`) once at the request entry point and exposes it as `RequestContext.deadline` to the terminal handler.
- Each hop in the dispatch chain (local or remote) observes the same absolute deadline and computes its remaining time budget from it.

### Timeout budget management

The bridge bounds the observation step (`hook.received` emit) by the handle timeout so a slow observation path cannot consume the entire native response budget. The remaining timeout after observation is passed to the handle request:

```
CLI timeout (5000ms)
  |
  +--> hook.received emit (bounded by timeout)
  |       time consumed: ~Xms
  |
  +--> hook.handle request (timeout = 5000 - X)
           bus mints deadline = Date.now() + remainingTimeout
           handler sees RequestContext.deadline
```

### Routing via hostLocalRequest

When a `hook.handle` subject is wrapped with `hostLocalRequest()`, the bus ensures the request is answered locally by the receiving host — it is never forwarded further across the bus topology. This prevents response-hook round-trips from crossing transport boundaries where caller cancellation cannot propagate.

## Fail-Open Semantics

By default, the bridge fails open:

| Condition | Default (fail-open) | `--fail-close` |
|-----------|-------------------|----------------|
| Bus unavailable (null) | Exit 0, no output | Exit 1, error to stderr |
| Transport failure | Exit 0, no output | Exit 1, error to stderr |
| Request timeout | Exit 0, no output | Exit 1, error to stderr |
| No handler registered | Exit 0, no output | Exit 0, no output |
| Invalid stdin JSON | Emits `{}` payload | Emits `{}` payload |

The no-handler case always exits 0 with no output — `requestOptional` returns `{ handled: false }` immediately without waiting for the timeout. This is the no-handler fast path.

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

### Request/response hooks

For hooks that need to return a response (e.g. blocking a tool use), use `hook handle`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "makaio hook handle claude-code pre_tool_use --timeout 5000"
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

### `hook received`

| Argument | Description |
|----------|-------------|
| `<client>` | Stable lowercase client identifier, e.g. `claude-code`, `codex` |
| `<event-name>` | Hook event name as reported by the native client, e.g. `pre_tool_use`, `session_started` |
| `--metadata-json` | Optional JSON object for pass-through context (e.g. `{ "pid": 1234 }`) |

### `hook handle`

| Argument | Description |
|----------|-------------|
| `<client>` | Stable lowercase client identifier, e.g. `claude-code`, `codex` |
| `<event-name>` | Hook event name as reported by the native client, e.g. `pre_tool_use`, `session_started` |
| `--metadata-json` | Optional JSON object for pass-through context (e.g. `{ "pid": 1234 }`) |
| `--timeout` | Maximum wait time for a bus response in milliseconds (default: 5000) |
| `--fail-close` | On error or timeout: exit non-zero instead of failing open (default: `false`) |

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

### `client:<clientId>.hook.handle` (request/response)

Issued by the `handle` subcommand. The request payload is identical to the `hook.received` event. The response follows the `ClientHookHandleResponseSchema`:

```ts
// Response shape
{
  exitCode: number;  // default: 0
  stdout: string;    // default: ''
  stderr: string;    // default: ''
}
```

### `client.runtime.observe` (best-effort request)

Fired only when `metadata` contains at least one of `pid`, `supervisorSessionId`, or `adapterSessionId`. Missing handlers are silently ignored.

## Response Pipeline

When a hook event declares `responseCapabilities` in the client definition,
the `hook handle` subcommand activates the response pipeline. The bridge
issues a `bus.requestOptional` call, and a downstream handler (the
client-specific composer) collects extension contributions, reduces them,
and serializes the native response format.

The bridge itself is intentionally dumb --- it never inspects, normalizes,
or merges the response. The response pipeline is documented in
[Client Hook Response Pipeline](../../docs/architecture/client-hook-responses.md).

### Authoring contributions

Extensions participate in the response pipeline by declaring
`clientHookResponses` on their `MakaioExtension`:

```ts
import {
  type ContributorDefinition,
  createAppendEffect,
} from '@makaio/contracts/client';

// In your extension's MakaioExtension:
clientHookResponses: {
  createContributors: () => [{
    id: 'my-enricher',
    priority: 100,
    timeoutMs: 3000,
    failurePolicy: 'open',
    selectors: [{ kind: 'event-name', name: 'PreToolUse' }],
    respond: async (ctx) => ({
      canonicalEffects: [createAppendEffect('Context from my extension')],
    }),
  }],
},
```

Contributors are validated at activation time against the active provider
contract catalog. See the
[architecture document](../../docs/architecture/client-hook-responses.md)
for selector kinds, failure policies, timeout behavior, and provider
contract details.

## Installation

```bash
makaio extension install ./extensions/client-hooks
```
