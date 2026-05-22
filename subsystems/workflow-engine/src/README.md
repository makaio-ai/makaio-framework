# @makaio/services/workflow

Workflow definition storage, DAG-based execution, and trigger evaluation.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    WorkflowExecutor                          │
│  DAG step ordering via topological sort                     │
│  Dependency resolution, forEach expansion, step runners     │
└─────────────────────────────────────────────────────────────┘
         │
         ├─ BusEventTriggerEvaluator  — `on: { subject: '...' }`
         ├─ CronTriggerEvaluator      — `on: { cron: '...' }`
         └─ RelayCronFiredHandler     — receives cron events from relay
                  │
                  ▼
         WorkflowTriggerTypeRegistry
         (extensible trigger types)
```

## Components

### WorkflowExecutor
`src/workflow-executor.ts`

Executes workflow definitions. Steps can be:
- `agent` — run a persona or profile
- `shell` — execute a shell command
- `gate` — conditional branch
- `forEach` — dynamic fan-out via `for-each-expander.ts`

Dependencies between steps are resolved topologically. Parallel-ready steps
execute concurrently.

### DAG Utilities
`src/dag-utils.ts`

- `topologicalSort(steps)` — sort workflow steps by dependency order
- `areDependenciesMet(step, completedIds)` — check if all deps are done
- `groupByTopoLevel(steps)` — group for parallel execution tiers

### Storage
`src/storage/`

Drizzle-backed storage for `WorkflowDefinition` and `WorkflowExecution` entities.

| Table | Purpose |
|-------|---------|
| `workflowDefinitions` | Workflow templates |
| `workflowExecutions` | Execution history and state |

**Subjects:** `storage:workflow.*` (get/set/delete/list for each table)

### Trigger Evaluators

| Class | Trigger type |
|-------|-------------|
| `BusEventTriggerEvaluator` | Bus subject events |
| `CronTriggerEvaluator` | Cron expressions via `croner` |
| `RelayCronFiredHandler` | Relay-side cron fired events |

## Usage

```typescript
import { WorkflowExecutor, WorkflowStorageSubjects } from '@makaio/services/workflow';

const executor = new WorkflowExecutor(bus, config);

// Storage is registered via Drizzle handler
registerDrizzleWorkflowStorage(db);

// Execute a workflow
await executor.execute(workflowDefinition, inputs);
```

## Dependencies

- `croner` — cron scheduling
- `@makaio/expression` — expression evaluation for conditions
- `@makaio/storage-core`, `@makaio/storage-handlers`
