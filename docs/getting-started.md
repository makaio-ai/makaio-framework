---
title: Getting Started
description: Walk through running the Makaio Framework, understanding its architecture, and building your first extension.
---

This guide walks you through running the Makaio Framework, understanding its
core concepts, and writing your first extension.

## Prerequisites

- **Node.js 22+**
- **Yarn 4** (or npm — Yarn is used throughout this guide)

## Starting the Server

The framework ships a headless CLI server and desktop host shells. The CLI
server is the simplest way to start:

```bash
makaio serve
```

This boots the full runtime:

1. Creates a Hono HTTP server with a `/health` endpoint
2. Attaches the WebSocket bus transport to the HTTP server
3. Opens (or creates) the SQLite database and runs migrations
4. Loads machine identity (keypair for device identification)
5. Starts framework services (session, tools, capabilities)
6. Discovers and loads extensions and their adapter/provider/tool contributions
7. Prints `MAKAIO_PORT=6252` to stdout when the full runtime is ready (default port; override with `--port`)

Verify it is running:

```bash
curl http://127.0.0.1:6252/health
# { "ok": true, "auth": false }
```

The bus is now accepting WebSocket connections at `ws://127.0.0.1:6252/bus`.

### Server Options

```bash
makaio serve                      # Default port: 6252
makaio serve --port 3000          # Fixed port
makaio serve --port 0             # Ask the OS to assign a free port
makaio serve --host 0.0.0.0      # Bind to all interfaces (default: loopback)
```

For non-loopback access from the standalone CLI, set `MAKAIO_BUS_SECRET` and use
`--host`. The `--lan-bind` E2E pairing path is host-composition wiring and requires a
peer-signing-key resolver supplied by the embedding host.

## Core Concepts in 2 Minutes

**Bus** — A typed pub/sub + RPC system. Every service, adapter, and tool talks
through the bus. Subjects are defined with Zod schemas. Events are
fire-and-forget; requests are RPC with typed responses.

**Adapters** — Three-layer bridges to AI providers (AIAdapter > AIAgent >
AIAgentConnector). Each adapter registers on the bus and participates in the
session lifecycle.

**Sessions** — Turn-based conversations. A session tracks messages, agents, and
context windows. Send `session.sendMessage` on the bus to start or continue a
conversation.

**Tools** — Typed function definitions with Zod input/output schemas. Tools
register on the bus and are available to all agents via `tool.list` and
`tool.execute`.

**Extensions** — Runtime extensions that contribute services, storage, CLI
commands, HTTP routes, windows, or browser bundles. Each extension is a
`MakaioExtension` loaded by the `ExtensionCoordinator`.

**Storage** — Bus-mediated and backend-agnostic. Storage handlers are namespace-specific
bus request handlers such as `SessionStorageSubjects.get`; the backend (memory or SQLite)
is invisible to callers.

## Your First Bus Interaction

The bus is the foundation of everything. Here is a minimal example that
registers a namespace, subscribes to events, and emits:

```ts
import { MakaioBus } from '@makaio/framework/bus';
import { z } from 'zod';

// 1. Define schemas
const GreeterSchemas = {
  greeted: z.object({
    name: z.string(),
    timestamp: z.number(),
  }),
  greet: {
    request: z.object({ name: z.string() }),
    response: z.object({ greeting: z.string() }),
  },
};

// 2. Register a namespace
const GreeterNamespace = MakaioBus.registerNamespace('greeter', GreeterSchemas);
const GreeterSubjects = GreeterNamespace.subjects;

// 3. Subscribe to events
MakaioBus.on(GreeterSubjects.greeted, (ctx) => {
  console.info(`${ctx.payload.name} was greeted at ${ctx.payload.timestamp}`);
});

// 4. Handle requests
MakaioBus.on(GreeterSubjects.greet, (ctx) => {
  const greeting = `Hello, ${ctx.payload.name}!`;
  ctx.setResult({ greeting });
});

// 5. Emit an event
await MakaioBus.emit(GreeterSubjects.greeted, {
  name: 'World',
  timestamp: Date.now(),
});

// 6. Wait for the next matching event (promise-based, with timeout)
const ctx = await MakaioBus.once(GreeterSubjects.greeted, {
  filter: { name: 'World' },
  timeoutMs: 5_000,
});
console.info(ctx.payload.timestamp);

// 7. Make a request
const { greeting } = await MakaioBus.request(
  GreeterSubjects.greet,
  { name: 'Developer' },
);
console.info(greeting); // "Hello, Developer!"
```

Everything is typed end-to-end. `ctx.payload` in the event handler is
`{ name: string; timestamp: number }`. The `request()` return type is
`{ greeting: string }`. No manual type annotations needed — they flow from the
Zod schemas. `once()` returns a promise that resolves on the next matching
event — use `filter` to narrow by payload fields and `timeoutMs` to avoid
hanging indefinitely.

See [`docs/bus/`](./architecture/bus/index.md) for the full bus architecture guide.

## Writing a Tool

Tools are the lowest-barrier contribution point. Define a tool with
`defineTool()`, group it into a toolset with `defineToolset()`, and register
it with the `ToolRegistry`:

```ts
import { defineTool, defineToolset, toolSuccess } from '@makaio/framework/tools';
import { z } from 'zod';

// 1. Define the tool
const currentTimeTool = defineTool({
  name: 'current_time',
  description: 'Returns the current UTC time as an ISO string.',
  inputSchema: z.object({}),
  outputSchema: z.object({ time: z.string() }),
  execute: async () => {
    return toolSuccess({ time: new Date().toISOString() });
  },
});

// 2. Group into a toolset
export const clockToolset = defineToolset({
  name: 'clock',
  description: 'Time-related tools',
  version: '0.1.0',
  tools: [currentTimeTool],
});

// 3. Register (at runtime, after ToolRegistry is available)
await toolRegistry.register(clockToolset);
```

Once registered, the tool is discoverable by all agents via `ToolSubjects.list`
and executable via `ToolSubjects.execute`. Any code holding the bus can also
call tools directly:

```ts
import { ToolSubjects } from '@makaio/framework/contracts';

const result = await bus.request(ToolSubjects.execute, {
  toolName: 'current_time',
  input: {},
});
// result: { success: true, data: { time: '2026-04-12T...' } }
```

For a real example, see `../extensions/filesystem/src/tools/read-file.ts` — the
framework's built-in file read tool with path validation, encoding support,
and size constraints.

## Writing an Extension

Extensions are the main way to add functionality to the framework. A
`MakaioExtension` declares what it contributes and the coordinator handles
lifecycle, dependency ordering, and failure isolation. Non-critical extension
failures are isolated; critical extension failures abort boot because the host
declared them mandatory.

### Minimal Extension

```ts
import type { IMakaioBus } from '@makaio/framework/bus';
import type { MakaioExtension } from '@makaio/framework/contracts';
import { KernelSubjects } from '@makaio/framework/kernel';
import { BaseService } from '@makaio/framework/service-base';

// 1. Implement the service
class HealthMonitorService extends BaseService {
  private interval: ReturnType<typeof setInterval> | undefined;

  public constructor(bus: IMakaioBus) {
    super(bus);
  }

  protected async onInit(): Promise<void> {
    this.interval = setInterval(async () => {
      const result = await this.bus.requestOptional(
        KernelSubjects.isReady,
        {},
      );
      if (result.handled) {
        console.info('Runtime ready:', result.data.ready);
      }
    }, 30_000);
  }

  protected async onDestroy(): Promise<void> {
    clearInterval(this.interval);
  }
}

// 2. Export the extension manifest
export const healthMonitorExtension: MakaioExtension = {
  name: 'health-monitor',
  displayName: 'Health Monitor',
  surface: 'any',

  create(ctx) {
    return new HealthMonitorService(ctx.bus);
  },
};
```

The coordinator calls `create(ctx)` during boot, then `service.init()`. On
shutdown, it calls `service.destroy()` in reverse dependency order.

### What Extensions Can Contribute

| Surface | Manifest field | Purpose |
|---------|---------------|---------|
| Background service | `create(ctx)` | Long-running service with bus handlers |
| Storage | `storage.registerHandlers(bus, db, ctx)` | Drizzle storage handler registration |
| CLI commands | `cli: CliContribution` | Commands runnable via `makaio <command>` |
| HTTP routes | `http: { prefix, mount }` | Hono sub-app mounted on the server |
| Windows | `windows: WindowManifest[]` | Desktop windows |
| Tray menu | `tray: TrayManifest` | System tray entry |
| Browser bundle | `browser: { entrypoint }` | Renderer-side code loaded in the shell |

For dependencies, surface gating, CLI authoring, scaffolding, and the
build/publish workflow, see
[Creating Extensions](./creating-extensions).

## Sessions and Agents

To start a conversation, send `session.sendMessage` on the bus:

```ts
import { AgentSubjects, SessionSubjects } from '@makaio/framework/contracts';

const sessionId = crypto.randomUUID();

// This auto-creates the session and attaches an agent
const { messageId, turnId } = await bus.request(
  SessionSubjects.sendMessage,
  {
    sessionId,
    agent: {
      kind: 'canonical-model',
      model: 'sonnet',
      // See docs/architecture/adapters/models-and-providers for the canonical model name format.
      // Examples: 'gpt-5.2', 'anthropic::sonnet', 'openai-node/openai::gpt-5.2'
    },
    message: 'What files are in the current directory?',
  },
);
```

The session orchestrator handles the rest:

1. Creates the session if `sessionId` is new
2. Attaches an agent via `adapter.startAgent` if none is active
3. Routes the message to the agent's connector
4. The connector calls the provider API and streams events back through the bus

Listen for the response:

```ts
// Stream text deltas
bus.on(AgentSubjects.message_delta, (ctx) => {
  process.stdout.write(ctx.payload.text);
}, { filter: { sessionId } });

// Wait for completion
const completion = await bus.once(AgentSubjects.complete, {
  filter: { sessionId, messageId },
  timeoutMs: 120_000,
});

console.info('\nDone:', completion.payload.message);
```

For lower-level control, resolve an adapter name to an adapter instance ID and
then call `adapter.startAgent` directly:

```ts
import { AdapterSubjects } from '@makaio/framework/contracts';
import { AdapterRuntimeSubjects } from '@makaio/framework/services';

const { adapterId } = await bus.request(AdapterRuntimeSubjects.resolveId, {
  adapterName: 'openai-node',
});

const result = await bus.request(AdapterSubjects.startAgent, {
  adapterId,
  role: 'lead',
  mode: 'create',
  initialMessage: 'Hello!',
});

if (!result.success) {
  throw new Error(result.message);
}

const { agentId } = result;
```

## Running Tests

The commands below assume the repository root.

```bash
# All framework tests
yarn test

# Specific package
yarn test packages/bus-core

# Specific test file
yarn test packages/bus-core/src/__tests__/hierarchical-namespace.test.ts

# Full validation (types + lint + format)
yarn validate
```

The test runner uses a token-efficient reporter optimized for AI consumption.
Do not override the reporter with `--reporter`.

## Where to Go Next

| Topic | Document |
|-------|----------|
| Bus architecture | [Architecture: Bus](./architecture/bus/index.md) |
| Adapters overview | [Architecture: Adapters](./architecture/adapters/) |
| Models, providers, credentials | [Architecture: Models & Providers](./architecture/adapters/models-and-providers) |
| Building a new adapter | [Guide: Creating Adapters](./creating-adapters) |
| Extension model | [Architecture: Extensions](./architecture/extensions/) |
| CLI commands and server | [Guide: CLI](./cli.md) |

Package-level READMEs:

| Package | README |
|---------|--------|
| Bus core | [`@makaio/bus-core`](/packages/bus-core/) |
| Contracts | [`@makaio/contracts`](/packages/contracts/) |
| Kernel | [`@makaio/kernel`](/packages/kernel/) |
| Adapter contracts | [`@makaio/ai-adapters-core`](/packages/adapters/core/) |
| Tools core | [`@makaio/tools-core`](/packages/tools-core/) |
| Storage core | [`@makaio/storage-core`](/packages/core/) |
