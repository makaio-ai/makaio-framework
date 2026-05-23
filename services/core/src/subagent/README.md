# @makaio/services-subagent

Orchestrates subagent execution lifecycle including session creation, adapter startup, message routing, and cleanup.

## Features

- **Session creation** - Creates child sessions for subagents
- **Adapter startup** - Starts AI adapters for subagent execution
- **RPC handlers** - State operations exposed via bus RPCs
- **Message routing** - Routes messages between parent and child sessions
- **Lifecycle management** - Handles completion, cancellation, and failures

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      SubagentService                             │
│                                                                 │
│  bus: IMakaioBus    manager: SubagentManager    cleanups: []     │
├─────────────────────────────────────────────────────────────────┤
│  Event Handlers (fire-and-forget):                              │
│    subagent.spawned   → handleSpawned() → session + adapter     │
│    subagent.toChild   → handleToChild() → route to child        │
│    subagent.completed → handleCompleted() → cleanup             │
│    subagent.cancelled → handleCancelled() → cleanup             │
├─────────────────────────────────────────────────────────────────┤
│  RPC Handlers (request/response):                               │
│    subagent.execute   → Create and execute subagent             │
│    subagent.getStatus → Query subagent state                    │
│    subagent.spawn     → Validate + track + emit spawned         │
│    subagent.await     → Wait for terminal state                 │
│    subagent.send      → Send message to subagent                │
│    subagent.kill      → Terminate subagent                      │
│    subagent.reportProgress → Child reports progress             │
│    subagent.requestInput   → Child requests input               │
│    subagent.completeTask   → Child signals completion           │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ delegates to
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      SubagentManager                             │
│                                                                 │
│  Tracks subagent state, constraints, awaiters, pending requests │
│  (owned by @makaio/services-core/subagent)                       │
└─────────────────────────────────────────────────────────────────┘
```

## Installation

Add the service package to your dependencies:

```json
{
  "dependencies": {
    "@makaio/services-subagent": "workspace:*"
  }
}
```

## Usage

### Basic Setup

```typescript
import { MakaioBus } from '@makaio/bus-core';
import { SubagentService } from '@makaio/services-subagent';

// Create service
const subagentService = new SubagentService(MakaioBus);

// Initialize (registers all handlers)
await subagentService.init();

// Later: cleanup
subagentService.destroy();
```

### Custom Constraints

```typescript
import { SubagentService } from '@makaio/services-subagent';
import type { SubagentConstraints } from '@makaio/contracts';

const constraints: SubagentConstraints = {
  maxDepth: 3,
  maxConcurrentPerSession: 5,
  maxTotalActive: 20,
  defaultAwaitTimeoutMs: 300000,
  defaultRequestTimeoutMs: 60000,
  allowedAdapters: ['claude-code', 'openai'],
  allowedModels: ['sonnet', 'gpt-4'],
};

const service = new SubagentService(MakaioBus, constraints);
await service.init();
```

### Spawning a Subagent

```typescript
import { SubagentSubjects } from '@makaio/contracts';

// Via spawn RPC (recommended - validates constraints)
const { subagentId, status } = await MakaioBus.request(SubagentSubjects.spawn, {
  parentSessionId: 'parent-session-123',
  config: {
    task: 'Analyze the codebase',
    adapterName: 'claude-code',
    model: 'sonnet',
    contextMode: 'fork',
    onRequestTimeout: 'continue',
  },
  depth: 1,
});

// Await completion
const result = await MakaioBus.request(SubagentSubjects.await, {
  subagentId,
  timeoutMs: 60000,
});

console.log(result.status); // 'completed' | 'failed' | 'waiting_input' | 'timeout' | 'cancelled'
```

### Interacting with Subagents

```typescript
// Send message to subagent
await MakaioBus.request(SubagentSubjects.send, {
  subagentId,
  content: 'Please continue with the next step',
});

// Respond to input request
await MakaioBus.request(SubagentSubjects.send, {
  subagentId,
  content: 'Yes, proceed with that approach',
  inResponseTo: 'msg-123', // messageId from pending request
});

// Query status
const { status, progress, pendingRequest } = await MakaioBus.request(
  SubagentSubjects.getStatus,
  { subagentId }
);

// Kill subagent
await MakaioBus.request(SubagentSubjects.kill, {
  subagentId,
  reason: 'User cancelled',
});
```

### Listening for Events

```typescript
// Progress updates
MakaioBus.on(SubagentSubjects.toParent, (ctx) => {
  if (ctx.payload.type === 'progress') {
    console.log(`[${ctx.payload.subagentId}] ${ctx.payload.content}`);
  }
});

// Completion
MakaioBus.on(SubagentSubjects.completed, (ctx) => {
  const { subagentId, success, result, error } = ctx.payload;
  console.log(`Subagent ${subagentId} ${success ? 'completed' : 'failed'}`);
});

// Execution failures
MakaioBus.on(SubagentSubjects.executionFailed, (ctx) => {
  const { subagentId, phase, error } = ctx.payload;
  console.error(`Subagent ${subagentId} failed during ${phase}: ${error}`);
});
```

## RPC Reference

### spawn

Validates constraints, tracks subagent, and emits `spawned` event.

| Request Field | Type | Description |
|---------------|------|-------------|
| `parentSessionId` | `string` | Parent session ID |
| `config` | `SubagentConfig` | Subagent configuration |
| `depth` | `number` | Nesting depth (1 = direct child) |

| Response Field | Type | Description |
|----------------|------|-------------|
| `subagentId` | `string` | Generated subagent ID |
| `status` | `'spawning'` | Initial status |

### execute

Directly executes a subagent (bypasses spawn event).

| Request Field | Type | Description |
|---------------|------|-------------|
| `subagentId` | `string` | Pre-generated subagent ID |
| `parentSessionId` | `string` | Parent session ID |
| `task` | `string` | Task to execute |
| `config` | `SubagentConfig` | Configuration |
| `depth` | `number` | Nesting depth |

| Response Field | Type | Description |
|----------------|------|-------------|
| `success` | `boolean` | Whether execution started |
| `error?` | `string` | Error message if failed |

### getStatus

Query current subagent state.

| Request Field | Type | Description |
|---------------|------|-------------|
| `subagentId` | `string` | Subagent to query |

| Response Field | Type | Description |
|----------------|------|-------------|
| `status` | `SubagentStatus` | Current status |
| `childSessionId?` | `string` | Child session ID |
| `pendingRequest?` | `object` | Pending input request |
| `progress` | `string[]` | Progress updates |
| `result?` | `string` | Completion result |
| `summary?` | `string` | Result summary |
| `error?` | `string` | Error message |

### await

Wait for subagent to reach terminal state.

| Request Field | Type | Description |
|---------------|------|-------------|
| `subagentId` | `string` | Subagent to await |
| `timeoutMs?` | `number` | Timeout in milliseconds |

| Response Field | Type | Description |
|----------------|------|-------------|
| `status` | `'completed' \| 'failed' \| 'waiting_input' \| 'timeout' \| 'cancelled'` | Final status |
| `result?` | `string` | Completion result |
| `error?` | `string` | Error message |
| `pendingRequest?` | `object` | Input request details |

### send

Send message to subagent.

| Request Field | Type | Description |
|---------------|------|-------------|
| `subagentId` | `string` | Target subagent |
| `content` | `string` | Message content |
| `inResponseTo?` | `string` | Message ID if responding to request |

| Response Field | Type | Description |
|----------------|------|-------------|
| `sent` | `boolean` | Whether message was sent |
| `resolvedPending` | `boolean` | Whether a pending request was resolved |

### kill

Terminate a running subagent.

| Request Field | Type | Description |
|---------------|------|-------------|
| `subagentId` | `string` | Subagent to kill |
| `reason?` | `string` | Cancellation reason |

| Response Field | Type | Description |
|----------------|------|-------------|
| `killed` | `boolean` | Whether subagent was killed |

### reportProgress

Child reports progress update.

| Request Field | Type | Description |
|---------------|------|-------------|
| `subagentId` | `string` | Reporting subagent |
| `update` | `string` | Progress message |
| `percentComplete?` | `number` | Optional percentage |

### requestInput

Child requests input from parent.

| Request Field | Type | Description |
|---------------|------|-------------|
| `subagentId` | `string` | Requesting subagent |
| `question` | `string` | Question for parent |
| `context?` | `string` | Additional context |
| `timeoutMs?` | `number` | Response timeout |

| Response Field | Type | Description |
|----------------|------|-------------|
| `responded` | `boolean` | Whether parent responded |
| `response?` | `string` | Parent's response |
| `timedOut` | `boolean` | Whether request timed out |

### completeTask

Child signals task completion.

| Request Field | Type | Description |
|---------------|------|-------------|
| `subagentId` | `string` | Completing subagent |
| `result` | `string` | Task result |
| `summary?` | `string` | Optional summary |

## Execution Flow

```
spawn RPC                    SubagentService
    │                              │
    ├──► Validate constraints      │
    ├──► Track in manager          │
    ├──► Emit spawned event ──────►│
    │                              │
    │                    handleSpawned()
    │                              │
    │              ┌───────────────┴───────────────┐
    │              │                               │
    │              ▼                               ▼
    │    SessionSubjects.create          AdapterSubjects.startAgent
    │              │                               │
    │              └───────────────┬───────────────┘
    │                              │
    │                    Agent runs async
    │                              │
    │                    ┌─────────┴─────────┐
    │                    │                   │
    │                    ▼                   ▼
    │              toParent events    completeTask RPC
    │              (progress,               │
    │               request_input)          │
    │                                       ▼
    │                              Emit completed event
    │                                       │
    └──────────────────────────────────────►│
                  await RPC resolves
```

## File Structure

```
src/subagent/
├── index.ts                 # Export SubagentService
├── subagent-service.ts      # Main service class
├── rpc-handlers.ts          # RPC handler implementations
├── manager/
├── utils/
├── __tests__/
│   ├── subagent-service.test.ts
│   ├── rpc-handlers.test.ts
│   └── rpc-handlers-complete-request.test.ts
└── README.md
```

## Dependencies

- `@makaio/bus-core` - Bus for events and RPCs
- `@makaio/contracts` - Typed subjects and schemas
- `@makaio/service-base` - Service lifecycle and handler cleanup

## Error Handling

Execution failures emit `SubagentSubjects.executionFailed`:

| Phase | Description |
|-------|-------------|
| `session_create` | Failed to create child session |
| `adapter_start` | Failed to start adapter/agent |

## License

MIT
