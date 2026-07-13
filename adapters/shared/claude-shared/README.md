# @makaio/ai-adapters-claude-shared

Published shared infrastructure for Claude protocol AI adapter implementations. Provides the
agent layer, turn state machine, content block handlers, and tool approval utilities
used by both `@makaio/adapter-claude-agent-sdk` and
`@makaio/adapter-claude-code-cli`.

This package is a supported dependency of the Claude adapter packages. Most applications should
use those adapters directly; the shared package is public because their exported classes and
types form part of the adapters' declaration contracts.

## Purpose

Both Claude client adapters receive the same event shapes (content blocks, tool use,
result messages). This package holds the shared logic so the `claude-agent-sdk` and
`claude-code-cli` adapters can reuse the full agent layer without duplicating code.

## Key Exports

### Agent layer

```typescript
import { ClaudeCodeAgent } from '@makaio/ai-adapters-claude-shared';
// Base class for adapter-specific agents.
// Wires connector content-block events to global framework subjects.
```

### Turn state machine

```typescript
import { ClaudeConnectorTurn } from '@makaio/ai-adapters-claude-shared';
// Manages a single user/assistant exchange: queuing, streaming, finalization.
```

### Content block handlers

```typescript
import { CONTENT_BLOCK_HANDLERS } from '@makaio/ai-adapters-claude-shared';
// Discriminated handler map dispatched for each content block type.
```

### Tool handling

```typescript
import {
  registerToolApprovalHandler,
  toGlobalToolApproval,
  fromGlobalToolApproval,
  requestToolApproval,
} from '@makaio/ai-adapters-claude-shared';
// Bridges tool approval requests to AgentSubjects.toolApprove on the bus.
```

### Namespace factory

```typescript
import { createClaudeConnectorNamespace } from '@makaio/ai-adapters-claude-shared';
// Factory for creating a scoped Claude protocol bus namespace.
// Both adapters use this with their own namespace name.
```

## File Index

| Directory / File | Purpose |
|-----------------|---------|
| `src/agent/` | Shared agent base class (`ClaudeCodeAgent`) |
| `src/turn/` | Turn state machine (`ClaudeConnectorTurn`) |
| `src/content-block-handlers/` | Per-block-type event handlers (`CONTENT_BLOCK_HANDLERS`) |
| `src/tool-handling/` | Tool approval bridging utilities |
| `src/namespace/` | Bus namespace factory, subjects, schemas |
| `src/provider/` | Provider preset helpers |
| `src/async-query-source.ts` | Async iterable adapter for SDK streams |
| `src/utils/` | Shared utilities |
