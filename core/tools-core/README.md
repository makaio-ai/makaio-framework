# @makaio/tools-core

Tool execution primitives for Makaio Framework. This package defines tool and toolset contracts, typed results,
errors, and format exporters; the bus-native `ToolRegistry` lives in `@makaio/services-core/tools`.

## Quick Start

```typescript
import { z } from 'zod';
import { defineTool, defineToolset, toolSuccess } from '@makaio/tools-core';
import { ToolRegistry } from '@makaio/services-core/tools';

// 1. Define a tool
const echoTool = defineTool({
  name: 'echo',
  description: 'Echoes the input message',
  annotations: { readOnly: true },
  inputSchema: z.object({ message: z.string() }),
  outputSchema: z.object({ echo: z.string() }),
  execute: async (input, context) => {
    return toolSuccess({ echo: input.message });
  },
});

// 2. Create a toolset
const utilsToolset = defineToolset({
  name: 'utils',
  description: 'Utility tools',
  version: '1.0.0',
  tools: [echoTool],
});

// 3. Register and execute
const registry = new ToolRegistry();
await registry.register(utilsToolset);

const result = await registry.execute('echo', { message: 'Hello' });
if (result.success) {
  console.log(result.data.echo); // 'Hello'
}
```

## Key Concepts

### ToolDefinition

Pure function with a Zod-validated input contract and typed output contract:

```typescript
interface ToolDefinition<TInput, TOutput> {
  metadata: { name, description, annotations? };
  inputSchema: TInput;   // Zod schema validated by ToolRegistry before execution
  outputSchema: TOutput; // Zod schema for TypeScript inference and export/introspection contracts
  execute: (input: z.infer<TInput>, context: ToolExecutionContext) => Promise<ToolResult<z.infer<TOutput>>>;
}
```

`ToolRegistry` validates `inputSchema` before calling `execute()`. It does not validate returned data against
`outputSchema`; tool implementations remain responsible for returning data that matches their declared output type.

### AnyToolDefinition

Type-erased version for collections. Use when storing heterogeneous tools:

```typescript
// ToolDefinition<SomeInput, SomeOutput> extends AnyToolDefinition
const tools: Record<string, AnyToolDefinition> = { ... };
```

### ToolResult

Discriminated union - always check `success`:

```typescript
type ToolResult<T> =
  | { success: true; data: T }
  | { success: false; error: ToolError };
```

### ToolExecutionContext

Execution context passed to every tool (extends `MakaioContext` from `@makaio/core`):

```typescript
interface ToolExecutionContext {
  cwd: string;                           // Working directory
  env: Record<string, string>;           // Sanitized env vars (no secrets)
  platform: 'posix' | 'windows';         // Auto-detected
  signal?: AbortSignal;                  // Cancellation
  constraints?: Record<string, unknown>; // Toolset-specific limits
  sessionId?: string;                    // Session correlation
  subagentId?: string;                   // Current subagent, if any
  subagentDepth?: number;                // Current subagent nesting depth
  agentId?: string;                      // Agent attribution
  adapterId?: string;                    // Concrete adapter instance
  adapterName?: string;                  // Stable adapter driver name
  turnId?: string;                       // Turn attribution
  turnContext?: Record<string, unknown>; // Turn-scoped context contributed by PreUserMessage hooks.
  toolCallId?: string;                   // Originating structured tool call ID
  bus?: BusLike;                         // Bus for event emission
}
```

## Error Handling

```typescript
import { toolError, toolSuccess, ToolErrorCodes } from '@makaio/tools-core';

execute: async (input, context) => {
  if (!exists(input.path)) {
    return toolError(ToolErrorCodes.RESOURCE_NOT_FOUND, `File not found: ${input.path}`);
  }
  return toolSuccess({ content: '...' });
}
```

Standard error codes: `TOOL_NOT_FOUND`, `VALIDATION_FAILED`, `PERMISSION_DENIED`, `TIMEOUT`, `ABORTED`,
`EXECUTION_ERROR`, `INVALID_OUTPUT`, `RESOURCE_NOT_FOUND`, `RESOURCE_EXHAUSTED`, `INTERNAL_ERROR`.

## Registry & Bus Integration

The services-core `ToolRegistry` handles RPCs and emits lifecycle events to the `tool.*` namespace:

| Subject | Type | When |
|---------|------|------|
| `tool.list` | RPC | List available tools |
| `tool.execute` | RPC | Execute tool via bus |
| `tool.registered` | Event | Toolset registered |
| `tool.registryChanged` | Event | Toolset or plugin lifecycle changed the registered tool list |
| `tool.started` | Event | Execution begins |
| `tool.completed` | Event | Execution succeeded |
| `tool.error` | Event | Execution failed |

```typescript
import { ToolRegistry } from '@makaio/services-core/tools';

// Optional bus injection for testing
const registry = new ToolRegistry({ bus: mockBus });

// Subscribe to events
MakaioBus.on(ToolSubjects.completed, (ctx) => {
  console.log(`${ctx.payload.toolName} completed in ${ctx.payload.durationMs}ms`);
});
```

## MCP / OpenAI Export

```typescript
import { toMcpTool, toOpenAIFunction, toolsetToMcpTools, toolsetToOpenAIFunctions } from '@makaio/tools-core';

// Single tool
const mcpTool = toMcpTool(echoTool);
const openAIFunc = toOpenAIFunction(echoTool);

// Entire toolset
const mcpTools = toolsetToMcpTools(utilsToolset);
const functions = toolsetToOpenAIFunctions(utilsToolset);
```

## File Index

| File | Purpose |
|------|---------|
| `types.ts` | Core interfaces (ToolDefinition, Toolset, ToolResult, ToolExecutionContext) |
| `define-tool.ts` | `defineTool()` builder |
| `define-toolset.ts` | `defineToolset()` builder |
| `errors.ts` | Error codes and helpers |
| `export.ts` | MCP/OpenAI conversion utilities |
| `memory-store.ts` | `MemoryStore` — session-keyed in-memory store utility |
| `tool-utils.ts` | Shared helpers: `validateSessionId`, `emitEvent`, `executeCrudOperation` |

> **Note:** `@makaio/tools-core` intentionally defines primitives only. Use `@makaio/services-core/tools` for registry,
> bus RPC handlers, policy filtering, and lifecycle events.
