# @makaio/services-core/session

Session lifecycle management, orchestration, and event persistence.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                   MakaioSessionService                        │
│  Core CRUD (create/get/list/close/agent.added/agent.removed) │
│  Delegates to storage:session.* bus subjects                 │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│                   SessionOrchestrator                         │
│  session.sendMessage handler, turn lifecycle, agent routing   │
│  Composes: SessionTurnManager + AdapterRegistry              │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│                      SessionBridge                            │
│  Agent message persistence: accumulates blocks per agent,    │
│  stores assistant messages on agent.complete                 │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│                     SessionLogger                             │
│  Lifecycle events → storage:sessionEvent.append              │
│  (agent.added, turn.started, turn.completed)                 │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│                    Storage Handlers                           │
│  Memory (dev/test) or Drizzle (production) per domain        │
└──────────────────────────────────────────────────────────────┘
```

## Key Components

### MakaioSessionService

Bus-native session service. Registers core handlers: `session.create`, `session.get`, `session.list`, `session.close`, `session.agent.added`, `session.agent.removed`. Storage fully decoupled via `storage:session.*` subjects.

### SessionOrchestrator

Framework-level `session.sendMessage` handler. Resolves or starts agents, manages turns via `SessionTurnManager`, stores user messages, and routes to agents via `routeToAgentsCore`. Host applications can layer additional orchestration through their own composition root and selection seams.

### SessionTurnManager

Composable turn lifecycle manager. Tracks active turns per session, accumulates usage, guards against concurrent completion writes, and emits `session.turn.completed`.

### AdapterRegistry

Resolves `adapterName` to `adapterId` via bus requests and `adapter.initialized` event caching.

### SessionBridge

Persists agent responses. Maintains `agentId` to `sessionId`/`turnId` mapping, accumulates message blocks from `agent.*` events, and stores them as assistant messages on `agent.complete`.

### SessionLogger

Bridges lifecycle events to the session event storage layer. Supports an optional `EventTransform` for PII redaction (return `null` to skip storage).

### TurnContextEnricher

Loads messages already persisted in the current turn to provide turn-so-far context for immediate delivery to newly-routed agents.

### Context Assembly (`context/`)

Projection-based conversation reconstruction:
- `buildSessionContext()` — build context for a single session, respecting squash boundaries
- `getFullConversation()` — traverse `parentSessionId` chain, apply `forkTransforms` to ancestors
- `assembleForkContext()` — assemble fork-specific first-turn context

### Context Window Tracking (`context-window/`)

Per-session aggregation of token usage across turns for context window management.
`ContextWindowTracker` is opt-in: call `start()` to subscribe to `agent.contextWindow.updated` and `stop()` during
shutdown. The framework-core `session.close` handler does not clear tracker state; host lifecycle code should call
`ContextWindowTracker.clearSession()` when a tracker is part of the composition root.

### Adapter Sessions (`adapter-sessions/`)

Tracks external adapter session IDs linked to Makaio sessions. Used for log-import deduplication and parent session resolution.
Fork and branch lineage is represented on sessions with `parentSessionId`, `rootSessionId`, `forkPointMessageId`,
`branchKind`, and optional `forkTransforms`; context assembly traverses that chain instead of copying parent messages.

## Storage Domains

All storage is bus-decoupled. Register handlers before creating the service. The core CRUD service only needs session
storage for a minimal example; orchestration, logging, and normalized messages should also register the agent, event,
message, and turn storage handlers they use. Message routing currently has a Drizzle handler only, and framework
orchestration treats those writes as optional.

| Domain | Namespace | Memory Handler | Drizzle Handler |
|--------|-----------|----------------|-----------------|
| Sessions | `SessionStorageSubjects` | `registerMemorySessionStorage` | `registerDrizzleSessionStorage` |
| Agents | `AgentStorageSubjects` | `registerMemoryAgentStorage` | `registerDrizzleAgentStorage` |
| Events | `SessionEventStorageSubjects` | `registerMemorySessionEventStorage` | `registerDrizzleSessionEventStorage` |
| Messages | `MessageStorageSubjects` | `registerMemoryMessageStorage` | `registerDrizzleMessageStorage` |
| Turns | `TurnStorageSubjects` | `registerMemoryTurnStorage` | `registerDrizzleTurnStorage` |
| Message Routing | `MessageRoutingSubjects` | - | `registerDrizzleMessageRoutingStorage` |

## Usage

```typescript
import { MakaioBus } from '@makaio/bus-core';
import { SessionSubjects } from '@makaio/contracts';
import {
  MakaioSessionService,
  registerMemorySessionStorage,
} from '@makaio/services-core/session';

// 1. Register storage handlers
const storageCleanup = registerMemorySessionStorage(MakaioBus);

// 2. Create service
const sessionService = new MakaioSessionService(MakaioBus);
await sessionService.init();

// 3. Interact via bus
const { sessionId } = await MakaioBus.request(SessionSubjects.create, {});
const { session } = await MakaioBus.request(SessionSubjects.get, { sessionId });

// Cleanup
await sessionService.destroy();
storageCleanup();
```

`session.sendMessage` is owned by `SessionOrchestrator` and uses the current agent-selection shape:

```typescript
const { messageId, turnId } = await MakaioBus.request(SessionSubjects.sendMessage, {
  sessionId,
  agent: { kind: 'adapter', adapterName: 'claude-code' },
  message: 'Hello!',
});
```

When constructing the orchestration stack directly, destroy each component that owns subscriptions:

```typescript
bridge.destroy();
orchestrator.destroy();
logger.destroy();
await sessionService.destroy();
```

## File Structure

```
session/
├── index.ts                          # Public barrel
├── session-service.ts                # Bus-native CRUD service
├── session-orchestrator.ts           # Framework sendMessage orchestrator
├── session-orchestrator-helpers.ts   # Host/orchestrator helper exports
├── session-orchestrator-helpers-core.ts
├── session-service-handlers-core.ts  # Core bus handler registration
├── session-service-agent-handlers.ts
├── session-bridge.ts                 # Agent message persistence
├── session-logger.ts                 # Lifecycle event → storage bridge
├── session-turn-manager.ts           # Turn lifecycle manager
├── turn-context-enricher.ts          # Turn-so-far context loading
├── turn-usage-accumulator.ts         # Per-turn usage aggregation
├── adapter-registry.ts              # adapterName → adapterId resolution
├── selection-utils.ts                # Adapter/selection normalization
├── fallback-runtime-options.ts       # Fallback model/runtime selection
├── attachment-artifacts.ts           # Attachment artifact creation
├── capability-expansion.ts           # Capability expansion logic
├── extension-context.ts              # Extension runtime integration
├── constants.ts                      # Shared constants
├── schema.ts                         # Top-level schema re-exports
├── handlers/                         # Bus subject handlers
│   ├── route-to-agents.ts            # Full message routing
│   ├── route-to-agents-core.ts       # Core routing (framework-only)
│   ├── fork-handler.ts               # Session forking
│   ├── merge-handler.ts              # Session merging
│   ├── compress-handler.ts           # Context compression
│   ├── abandon-handler.ts            # Session abandonment
│   ├── attach-handler.ts             # Agent attachment
│   └── lifecycle-handlers.ts         # Status counts, resume
├── context/                          # Projection-based context assembly
├── context-window/                   # Per-session token tracking
├── storage/                          # Session + agent CRUD storage
├── session-events/                   # Append-only event storage
├── messages/                         # Normalized message storage
├── turns/                            # Turn storage
├── message-routing/                  # Message routing records
├── adapter-sessions/                 # External adapter session tracking
├── import-cursors/                   # Log-import deduplication cursors
├── entities/                         # Domain entities (Turn, MakaioSession)
├── session-editor/                   # Action registry + list handler
├── search/                           # FTS5 schema (SQL-driven, no runtime exports)
├── embeddings/                       # Embedding schema (not yet wired)
├── client-account-linking/           # Client account linking
├── orchestrator-testing/             # Test utilities for orchestrator
├── testing/                          # Shared test helpers
└── __tests__/                        # Unit tests
```
