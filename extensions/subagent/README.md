# @makaio/extension-subagent

Parent-child agent communication infrastructure for Makaio Framework. Enables agents to spawn isolated subagents, manage their lifecycle, and establish bidirectional messaging.

## Quick Start

```typescript
import { ToolRegistry } from '@makaio/services-core/tools';
import { createParentSubagentToolset, createChildSubagentToolset } from '@makaio/extension-subagent';

// Parent agent setup
const parentToolset = createParentSubagentToolset();
const registry = new ToolRegistry();
await registry.register(parentToolset);

// Spawn a subagent
const spawnResult = await registry.execute(
  'spawn_subagent',
  {
    task: 'Analyze the codebase and report findings',
    adapterName: 'claude-code',
  },
  { contextOverrides: { sessionId: 'parent-session' } },
);

if (spawnResult.success) {
  const { subagentId } = spawnResult.data;

  // Check status
  const status = await registry.execute('check_subagent', { subagentId });

  // Wait for completion
  const result = await registry.execute('await_subagent', { subagentId });
}
```

## Architecture

The package provides two separate stateless toolsets:

- **Parent toolset** (5 tools): For spawning and managing subagents
- **Child toolset** (3 tools): For subagents to communicate with parent

The tools call `SubagentSubjects.*` RPCs through `context.bus`. State coordination is owned by the service layer's
`SubagentManager`; toolset factories do not create or return a manager.

Hosts must register the `SubagentSubjects.*` RPC handlers before exposing these toolsets. The
framework package provides the stateless tools plus the `SubagentManager` state engine seam; the
host service decides how child sessions are spawned, tracked, and connected to adapters.

## Parent Tools

### spawn_subagent

Spawns a new subagent to perform a delegated task.

```typescript
// Input
{
  task: string;                              // Task description
  adapterName?: string;                      // Adapter driver name (default: inherit)
  providerConfigId?: string;                 // Provider configuration identifier
  harnessId?: string;                        // Harness ID (default: inherit)
  model?: string;                            // Model ID (default: inherit)
  contextMode?: 'fork' | 'fresh';           // 'fork' inherits history
  tools?: string[];                          // Tool allowlist
  disallowedTools?: string[];                // Tools to block
  systemPrompt?: string;                     // Additional instructions
  maxDepth?: number;                         // Max nesting depth
  responseSchema?: Record<string, unknown>;  // JSON Schema for structured output
  executionTargetId?: string;                // Execution target override
}

// Output
{
  subagentId: string;       // Unique identifier
  status: 'spawning';       // Initial status; child session is created asynchronously
}

// Annotations: { destructive: true }
```

### check_subagent

Checks current status of a spawned subagent.

```typescript
// Input
{
  subagentId: string;
}

// Output
{
  status: 'spawning' | 'running' | 'waiting_input' | 'hung' | 'completed' | 'failed' | 'cancelled';
  childSessionId?: string;  // Session ID of child agent (set after session creation)
  pendingRequest?: { messageId: string; question: string; context?: string };
  progress: string[];       // Recent progress updates
  result?: string;          // If completed
  summary?: string;         // Summary of result (if provided on completion)
  error?: string;           // If failed
}

// Annotations: { readOnly: true }
```

### send_to_subagent

Sends a message to a subagent (can respond to pending requests).

```typescript
// Input
{
  subagentId: string;
  content: string;
  inResponseTo?: string;    // Message ID of pending request
}

// Output
{
  sent: boolean;
  resolvedPending: boolean; // True when inResponseTo resolved a pending request_input
}
```

### await_subagent

Blocks until subagent reaches terminal state or needs input.

```typescript
// Input
{
  subagentId: string;
  timeoutMs?: number;
}

// Output
{
  status: 'completed' | 'failed' | 'waiting_input' | 'timeout' | 'cancelled';
  result?: string;
  pendingRequest?: { messageId: string; question: string; context?: string };
  error?: string;
}
```

### kill_subagent

Terminates a running subagent.

```typescript
// Input
{
  subagentId: string;
  reason?: string;
}

// Output
{
  killed: boolean;
}
```

## Child Tools

### report_progress

Reports progress update to parent agent.

```typescript
// Input
{
  update: string;
  percentComplete?: number;  // 0-100
}

// Output
{
  reported: boolean;
}
```

### request_input

Asks parent a blocking question and waits for response.

```typescript
// Input
{
  question: string;
  context?: string;
  timeoutMs?: number;
}

// Output
{
  responded: boolean;
  response?: string;
  timedOut: boolean;
}
```

### complete_task

Signals task completion with final result.

```typescript
// Input
{
  result: string;
  summary?: string;
}

// Output
{
  completed: boolean;
}
```

## Constraints

Default constraints from `@makaio/contracts`:

```typescript
{
  maxDepth: 3,                    // Max nesting levels
  maxConcurrentPerSession: 10,    // Max active per parent session
  maxTotalActive: 50,             // Max across all sessions
  defaultRequestTimeoutMs: 60000, // request_input timeout
  defaultAwaitTimeoutMs: 300000,  // await_subagent timeout
  stateRetentionMs: 1800000,      // 30min cleanup TTL
  inactivityTimeoutMs: 0,         // Hung detection disabled by default
  sweepIntervalMs: 60000,         // Periodic maintenance interval
  allowedAdapters: [],            // Empty = all adapters allowed
  allowedModels: [],              // Empty = all models allowed
}
```

`hung` is non-terminal. `check_subagent` reports it so the coordinator can decide whether to kill, retry, or abort;
`await_subagent` does not resolve just because a subagent is marked hung.

## File Index

| File | Purpose |
|------|---------|
| `src/toolset.ts` | Factory functions for toolsets |
| `src/tools/parent/*.ts` | Parent-side tool implementations |
| `src/tools/child/*.ts` | Child-side tool implementations |
| `src/manager/subagent-manager.ts` | Service-owned state engine used by subagent RPC handlers |
| `src/utils/ring-buffer.ts` | Bounded progress history buffer |
