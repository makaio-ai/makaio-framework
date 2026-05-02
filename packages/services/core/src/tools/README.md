# @makaio/services-core/tools

Central registry for tools and toolsets with bus-native execution and policy enforcement.

## What This Is

- **Tool Registry** - Central registration and lookup for tools organized into toolsets
- **Bus Integration** - Handles `tool.list` and `tool.execute` requests via MakaioBus
- **Policy Enforcement** - Adapter-based access control and per-tool disabling
- **Lifecycle Events** - Emits `tool.registered`, `tool.registryChanged`, `tool.started`, `tool.completed`, `tool.error` for observability
- **Schema Conversion** - Converts Zod input/config schemas to JSON Schema for tool/toolset introspection

## Quick Start

```typescript
import { MakaioBus } from '@makaio/bus-core';
import { ToolRegistry } from '@makaio/services-core/tools';
import { defineToolset, defineTool, toolSuccess } from '@makaio/tools-core';
import { ToolSubjects } from '@makaio/contracts';
import { z } from 'zod';

// 1. Define a tool
const echoTool = defineTool({
  name: 'echo',
  description: 'Echoes input back',
  inputSchema: z.object({ message: z.string() }),
  outputSchema: z.object({ echo: z.string() }),
  execute: async (input) => toolSuccess({ echo: input.message }),
});

// 2. Define a toolset (optional config schema)
const toolset = defineToolset({
  name: 'utilities',
  description: 'Utility tools',
  version: '1.0.0',
  tools: [echoTool],
  configSchema: z.object({
    timeout: z.number().default(30000),
  }),
});

// 3. Create registry and register
const registry = new ToolRegistry({ bus: MakaioBus });
await registry.register(toolset);

// 4. Execute via bus
const result = await MakaioBus.request(ToolSubjects.execute, {
  toolName: 'echo',
  input: { message: 'hello' },
});
// result: { success: true, data: { echo: 'hello' } }

// 5. List tools and toolsets
const { tools, toolsets } = await MakaioBus.request(ToolSubjects.list, {});

// Cleanup
registry.dispose();
```

## Architecture Principles

```
┌─────────────────────────────────────────────────────────────┐
│                       ToolRegistry                           │
│  - Registers toolsets and indexes tools                      │
│  - Handles tool.list and tool.execute bus requests           │
│  - Validates input against tool's Zod schema                 │
│  - Emits lifecycle events for observability                  │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                   Policy Filter (SEAM)                       │
│  - ToolsetPolicyProvider for adapter-based access control    │
│  - Filters toolsets by allowedAdapters                       │
│  - Filters tools by disabledTools                            │
└─────────────────────────────────────────────────────────────┘
```

**Bus Subjects Handled:**
- `tool.list` - Returns tools and toolsets with optional filtering
- `tool.execute` - Executes a tool by name with validated input

**Bus Events Emitted:**
- `tool.registered` - When a toolset is registered
- `tool.registryChanged` - When toolset/plugin lifecycle changes invalidate cached tool lists
- `tool.started` - Before tool execution begins
- `tool.completed` - After successful execution
- `tool.error` - On validation or execution failure

The registry validates tool input before execution. It does not validate returned data against the tool's
`outputSchema`; `outputSchema` is the typed/export contract owned by the tool definition.

## Key Exports

### Classes

| Export | Description |
|--------|-------------|
| `ToolRegistry` | Central registry for tools and toolsets |

### Types

| Export | Description |
|--------|-------------|
| `ToolRegistryOptions` | Configuration: bus, handlerPriority, policyProvider |
| `ListToolsFilter` | Filter by toolsetName, adapterId, adapterName |
| `ToolsetInfo` | Toolset metadata returned from listToolsets |
| `ToolsetPolicy` | Policy config: allowedAdapters, disabledTools |
| `ToolsetPolicyProvider` | SEAM: async function returning policy for toolset |
| `ToolsWithToolsetsResult` | Combined tools + toolsets listing result |

## Design Philosophy

**SEAM: Policy Provider** - The `ToolsetPolicyProvider` is an extension point for toolset configuration. Implement it with any host-owned settings source:

```typescript
const toolsetConfigsByName = new Map<string, ToolsetPolicy & { enabled?: boolean }>();

const policyProvider: ToolsetPolicyProvider = async (toolsetName) => {
  const config = toolsetConfigsByName.get(toolsetName);
  if (!config || config.enabled === false) return null;
  return { allowedAdapters: config.allowedAdapters, disabledTools: config.disabledTools };
};

const registry = new ToolRegistry({ bus: MakaioBus, policyProvider });
```

**Policy Enforcement:**
- `allowedAdapters: []` (empty) = all adapters allowed
- `allowedAdapters: ['claude-code']` = only claude-code adapter can access
- `disabledTools: ['shell_kill']` = specific tools blocked within toolset

**Context Injection:** Tools receive a `ToolExecutionContext` with:
- Standard `MakaioContext` properties (cwd, env, platform, signal)
- `bus` - for emitting events during execution
- `sessionId` - for multi-session task correlation
- `agentId`, `adapterId`, `adapterName`, `turnId`, `turnContext`, `toolCallId` when supplied by the caller

---

*Part of the [Makaio AI Framework](https://github.com/makaio-ai/makaio-framework)*
