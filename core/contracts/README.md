# @makaio/contracts

Shared type contracts, Zod schemas, and bus subject namespaces for the Makaio
framework. Every service domain — sessions, agents, tools, providers, and more —
is defined here so consumers get a single, authoritative import path.

## Installation

This is a private workspace package. Add it to a consuming workspace package with the workspace
protocol:

```json
{
  "dependencies": {
    "@makaio/contracts": "workspace:*"
  }
}
```

## Usage

Import domain schemas and bus subjects by domain. Most consumers use the root
barrel, but granular sub-paths are available for selective imports.

```typescript
import {
  MakaioSessionSchema,
  SessionSubjects,
  AdapterSubjects,
  type IMakaioSession,
} from '@makaio/contracts';
import { MakaioBus } from '@makaio/bus-core';

// Listen for session lifecycle events
MakaioBus.on(SessionSubjects.created, ({ payload }) => {
  const session: IMakaioSession = MakaioSessionSchema.parse(payload);
  console.log('Session created:', session.id);
});

// Parse incoming data against the canonical schema
const session = MakaioSessionSchema.parse(rawData);
```

Sub-path exports are also available for contract domains:

```typescript
import { SessionSubjects } from '@makaio/contracts/session';
import { ConfigSubjects } from '@makaio/contracts/config';
```

Boot progress subjects are runtime-owned:

```typescript
import { BootSubjects, BootNamespace } from '@makaio/kernel';
```

## API overview

| Export | Description |
|--------|-------------|
| `SessionSubjects` / `SessionNamespace` | Bus subjects for session lifecycle RPCs and events |
| `MakaioSessionSchema` | Zod schema for the canonical session object |
| `AdapterSubjects` / `AdapterNamespace` | Bus subjects for adapter lifecycle (startAgent, initialized, …) |
| `AgentSubjects` / `AgentNamespace` | Bus subjects for agent events plus RPCs such as `sendMessage`, `toolApprove`, `getCapabilities`, `cwd.change`, `credential.change`, `model.change`, and `validateModelChange` |
| `ToolSubjects` | Bus subjects for tool approval and execution lifecycle |
| `ConfigSubjects` / `ConfigSchema` | Bus subjects and schema for runtime config access |
| `type IMakaioSession` | Core session interface |
| `type SessionContext` | Contextual data attached to a running session |
| `type Turn` / `TurnSchema` | Message-level turn model with usage metrics |
| `SessionMessageSchema` | Normalized stored-message model |
| `type AgentRole` / `AgentRoleSchema` | Agent role enumeration (`lead`, `member`) |
| `MessageBlockSchema` | `text`, `image`, `document`, `attachment`, `reasoning`, `tool_call`, and `tool_output` block schemas |
| `SubagentSubjects` | Bus subjects for subagent spawning and communication |
