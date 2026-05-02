# Stream Session Adapter Utilities

Shared infrastructure for stream-based AI adapter implementations. Provides pure utility
functions and types extracted from stream-driven adapters (Anthropic SDK, OpenAI) to
eliminate duplication across connector implementations.

Within the framework source workspace, adapter packages import this private workspace package as
`@makaio/ai-adapters-stream-session`. In the assembled framework distribution, public imports
should use `@makaio/framework/adapters/stream-session`.

## Purpose

Stream-based connectors share patterns for session management, connector lifecycle,
tool handling, and agent structure. This package extracts those cross-cutting concerns
into one place with no adapter-specific dependencies.

## Key Exports

### Session

```typescript
import { BaseStreamSession } from '@makaio/framework/adapters/stream-session';
// Abstract base session class for managing the state of a single streaming agent run.
```

### Connector

```typescript
import { BaseStreamConnector } from '@makaio/framework/adapters/stream-session';
// Abstract base connector class providing streaming lifecycle management.
```

### Agent

```typescript
import { BaseStreamAgent } from '@makaio/framework/adapters/stream-session';
// Abstract base agent class wiring connector events to framework bus subjects.
```

### Tool handling

```typescript
import {
  extractToolCallPayload,
  toGlobalToolApproval,
  loadToolsFromRegistry,
  executeTool,
} from '@makaio/framework/adapters/stream-session';
// Utilities for routing tool calls through the bus approval flow and execution.
```

### Shared schemas

```typescript
import { /* schema exports */ } from '@makaio/framework/adapters/stream-session';
// Shared Zod schemas for turn state, reasoning, tool calls, and lifecycle events.
```

## File Index

| Directory | Purpose |
|-----------|---------|
| `src/session/` | `BaseStreamSession` abstract class and session types |
| `src/connector/` | `BaseStreamConnector` abstract class |
| `src/agent/` | `BaseStreamAgent` abstract class |
| `src/tool-handling/` | Tool approval, execution, and registry utilities |
| `src/namespaces/` | Shared Zod schemas for stream-session bus events |
