# @makaio/agent-sdk

Drop-in replacement for `@anthropic-ai/claude-agent-sdk` that routes to any
provider Makaio supports. Same `query()`, same `tool()`, same `canUseTool`,
same message types — switch one import, gain access to every adapter in the
framework.

> [!IMPORTANT]
> This package is experimental and unpublished. The API surface may change
> without notice until the first stable release.

## Why

The Claude Agent SDK locks you into a single provider with API-token billing.
This package gives you the same programmatic surface with two extras:

1. **Any provider** — route to Claude, Gemini, Codex, Qwen, or any other
   Makaio adapter through canonical model names.
2. **Subscription-powered Claude** — combine with the
   [`claude-code-tmux`](../../adapters/implementations/claude-code-tmux/README.md)
   adapter to drive Claude Code with your existing Pro/Max subscription. No API
   tokens required — same `query()` interface, backed by an interactive Claude
   Code session under the hood.

## Quick Start

### Embedded runtime (no server needed)

```typescript
import { query, startup, shutdown } from '@makaio/agent-sdk/runtime';

await startup();

const q = query({ prompt: 'Summarise this file', options: { model: 'sonnet' } });
for await (const message of q) {
  console.log(message);
}

await shutdown();
```

### Connected to a running Makaio instance

```typescript
import { query, startup } from '@makaio/agent-sdk/core';

await startup(); // connects to ws://127.0.0.1:6252/bus (or MAKAIO_BUS_URL)

const q = query({ prompt: 'Explain this codebase', options: { model: 'openai-node::gpt-4o' } });
for await (const message of q) {
  console.log(message);
}
```

## Two Entry Points

| Entry | Import | Runtime |
|-------|--------|---------|
| `/runtime` | `@makaio/agent-sdk/runtime` | Boots a full Makaio runtime in-process (bus, adapters, storage, tools). No external server needed. |
| `/core` | `@makaio/agent-sdk/core` | Lightweight WebSocket client. Connects to a running `makaio serve` or Makaio.app instance. |

Both expose the identical API surface. Choose `/runtime` for standalone scripts
and CI pipelines. Choose `/core` when Makaio is already running and you want
minimal overhead (~50KB framework code).

## Provider Selection

Canonical model names route to the right adapter automatically:

| Input | Resolution |
|-------|------------|
| `"sonnet"` | Bare model — scan all enabled adapters |
| `"anthropic-sdk::sonnet"` | Explicit adapter + model |
| `"openai-node::gpt-4o"` | OpenAI via API |
| `"claude-code-tmux::sonnet"` | Claude Code via subscription (tmux adapter) |
| `"gemini-sdk::gemini-2.5-pro"` | Gemini via API |
| `"openai-node/openrouter::deepseek/deepseek-r1"` | Adapter + provider config + model |

## Query API

```typescript
function query(params: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: MakaioOptions;
}): MakaioQuery;
```

`MakaioQuery` is an `AsyncGenerator<SDKMessage>` with control methods:

| Method | Description |
|--------|-------------|
| `interrupt()` | Interrupt the current turn |
| `setModel(model)` | Switch model mid-session (staged for next turn if mid-turn) |
| `setMaxThinkingTokens(n)` | Adjust reasoning budget (mapped to effort levels) |
| `setMcpServers(servers)` | Hot-swap MCP servers mid-session |
| `supportedModels()` | List all available models across all providers |
| `mcpServerStatus()` | Status of configured MCP servers for this session |
| `accountInfo()` | Provider account information |
| `close()` | End the session and release resources |

### Message Types

The generator yields `SDKMessage` — a discriminated union compatible with
Claude Agent SDK message shapes:

| Type | Description |
|------|-------------|
| `SDKSystemMessage` | Session init (model, cwd, available tools) |
| `SDKAssistantMessage` | Text, thinking, tool_use, and tool_result blocks |
| `SDKResultMessage` | Terminal result with usage, cost, duration |
| `SDKCompactBoundaryMessage` | Context window pressure level changes |

## Tool Definition

```typescript
import { tool, query } from '@makaio/agent-sdk/runtime';
import { z } from 'zod';

const searchTool = tool(
  'search_codebase',
  'Search for patterns in the codebase',
  { pattern: z.string(), path: z.string().optional() },
  async ({ pattern, path }) => {
    // your implementation
    return { results: ['...'] };
  }
);

const q = query({
  prompt: 'Find all TODO comments',
  options: { model: 'sonnet', tools: [searchTool] },
});
```

## Tool Approval

```typescript
const q = query({
  prompt: 'Refactor the auth module',
  options: {
    model: 'sonnet',
    canUseTool: async (toolName, input) => {
      if (toolName === 'write_file') {
        return { behavior: 'deny', message: 'Read-only mode.' };
      }
      return { behavior: 'allow' };
    },
  },
});
```

## MCP Servers

```typescript
import { query, createSdkMcpServer } from '@makaio/agent-sdk/runtime';
import { z } from 'zod';

// In-process MCP server (same as Claude Agent SDK)
const myServer = createSdkMcpServer({
  name: 'my-tools',
  version: '1.0.0',
  tools: [{
    name: 'lookup',
    description: 'Look something up',
    inputSchema: { query: z.string() },
    handler: async ({ query }) => ({ answer: '42' }),
  }],
});

const q = query({
  prompt: 'Use the lookup tool',
  options: {
    model: 'sonnet',
    mcpServers: {
      'my-tools': myServer,
      'external': { type: 'stdio', command: 'npx', args: ['-y', 'some-mcp-server'] },
    },
  },
});
```

## Multi-Turn Conversations

```typescript
import { query } from '@makaio/agent-sdk/runtime';

const input = new AsyncQueue<SDKUserMessage>(); // any AsyncIterable
const q = query({ prompt: input, options: { model: 'sonnet' } });

input.push({ type: 'user', content: 'What is 2+2?' });

for await (const msg of q) {
  if (msg.type === 'result' && msg.subtype === 'success') {
    input.push({ type: 'user', content: 'Now multiply that by 10' });
  }
}
```

## Session Management

```typescript
import { listSessions, getSessionMessages, deleteSession } from '@makaio/agent-sdk/runtime';

const sessions = await listSessions({ status: 'active', limit: 10 });
const messages = await getSessionMessages(sessions[0].id);
await deleteSession(sessions[0].id);
```

| Function | Description |
|----------|-------------|
| `listSessions(options?)` | List sessions with optional status/limit filters |
| `getSessionInfo(sessionId)` | Get metadata for a single session |
| `getSessionMessages(sessionId)` | Retrieve full conversation history |
| `forkSession(sessionId, options?)` | Fork from an optional branch point |
| `deleteSession(sessionId)` | Permanently remove (close → archive → purge) |
| `renameSession(sessionId, title)` | Update session display title |

## Hooks

```typescript
import { query, registerRuntimeHooks } from '@makaio/agent-sdk/runtime';

const cleanup = await registerRuntimeHooks(sessionId, {
  SessionStart: [(data) => console.log('started', data)],
  PostToolUse: [(data) => console.log('tool done', data)],
});

// later
cleanup();
```

Supported hook events: `SessionStart`, `SessionEnd`, `Stop`, `PreToolUse`,
`PostToolUse`, `Notification`. Hook events without a Makaio bus equivalent
are silently ignored.

## Options Reference

```typescript
interface MakaioOptions {
  model: string;              // Required. Canonical model name.
  cwd?: string;               // Working directory (default: process.cwd())
  systemPrompt?: string;      // System prompt for the agent
  tools?: MakaioToolDefinition[];
  allowedTools?: string[];    // Whitelist tool names
  disallowedTools?: string[]; // Blacklist tool names
  canUseTool?: CanUseToolCallback;
  mcpServers?: Record<string, McpServerConfig>;
  maxTurns?: number;          // Limit follow-up turns in multi-turn mode
  env?: Record<string, string>;
  abortController?: AbortController;
  effort?: string;            // Reasoning effort level
  outputFormat?: object;      // Response schema (structured output)
  sessionId?: string;         // Reuse an existing session
  hooks?: HookConfig;         // Hook callbacks

  // /core mode only:
  websocketUrl?: string;      // Override bus URL
  websocketAuth?: TransportAuth;
}
```

## Warm Startup

Both entry points support pre-warming to avoid cold-start latency on the
first `query()`:

```typescript
// /runtime — boots the embedded runtime ahead of time
import { startup, shutdown } from '@makaio/agent-sdk/runtime';
await startup();

// /core — establishes the WebSocket connection ahead of time
import { startup } from '@makaio/agent-sdk/core';
await startup();
```

## Error Types

| Error | Thrown When |
|-------|------------|
| `MakaioModelError` | Model not found, ambiguous, or unparseable. Includes `suggestions` for disambiguation. |
| `MakaioCredentialError` | No API key found. Message includes the expected env var name. |
| `MakaioConnectionError` | WebSocket connection to Makaio bus failed (`/core` mode). |
| `MakaioUnsupportedFeatureError` | Feature not yet supported: `resume`, `credentials` override, `persistSession: false`. |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `MAKAIO_BUS_URL` | WebSocket URL for `/core` mode (default: `ws://127.0.0.1:6252/bus`) |
| `MAKAIO_BUS_SECRET` | HMAC shared secret when the bus server requires authentication |
| `ANTHROPIC_API_KEY` | API key for Anthropic adapters |
| `OPENAI_API_KEY` | API key for OpenAI adapters |
| `GOOGLE_API_KEY` | API key for Gemini adapter |

## Migrating from Claude Agent SDK

```diff
-import { query, tool } from '@anthropic-ai/claude-agent-sdk';
+import { query, tool } from '@makaio/agent-sdk/runtime';

 const q = query({
   prompt: 'Review this code',
-  options: { model: 'sonnet' }
+  options: { model: 'sonnet' }  // same canonical names work
 });
```

To use Claude via subscription instead of API tokens:

```typescript
const q = query({
  prompt: 'Review this code',
  options: { model: 'claude-code-tmux::sonnet' },
});
```

## Installation

This package is not yet published. Reference it locally via workspace
protocol while the project is in pre-release:

```json
{
  "dependencies": {
    "@makaio/agent-sdk": "workspace:*"
  }
}
```

The Claude Agent SDK is an optional peer dependency — used for type
compatibility validation in tests but not required at runtime:

```json
{
  "peerDependencies": {
    "@anthropic-ai/claude-agent-sdk": ">=0.2.50"
  },
  "peerDependenciesMeta": {
    "@anthropic-ai/claude-agent-sdk": { "optional": true }
  }
}
```

## Testing

```bash
# Unit + conformance tests (no credentials needed)
yarn test

# Integration tests with live runtime
MAKAIO_TEST_RUNTIME=1 yarn test
```

22 test files covering unit, integration, and conformance layers including
wire-format snapshot tests and compile-time type compatibility checks against
the Claude Agent SDK.
