# @makaio/subsystem-workflow-engine

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

Drizzle-backed storage for workflow definitions, executions, spans, and execution links.

| Table | Purpose |
|-------|---------|
| `workflowDefinitions` | Workflow templates |
| `workflowExecutions` | Execution history and state |
| `workflowStepSpans` | Step-level telemetry spans |
| `workflowExecutionLinks` | Cross-execution trace links |

**Subjects:** `storage:workflow.*` (get/set/delete/list for each table)

### Trigger Evaluators

| Class | Trigger type |
|-------|-------------|
| `BusEventTriggerEvaluator` | Bus subject events |
| `CronTriggerEvaluator` | Cron expressions via `croner` |
| `RelayCronFiredHandler` | Relay-side cron fired events |

## Usage

```typescript
import { WorkflowSubjects, workflowEnginePackage } from '@makaio/subsystem-workflow-engine';

// Register workflowEnginePackage with the node package runtime.
const { executionId } = await bus.request(WorkflowSubjects.start, {
  workflowId: 'workflow-123',
  inputs: {},
});
```

The main package export also exposes `WorkflowExecutor`, workflow and storage
namespace definitions, `WorkflowStorageSubjects`, and `registerDrizzleWorkflowStorage`
for runtime composition and tests. The package manifest is available from the
`@makaio/subsystem-workflow-engine/package` subpath.

## Dependencies

- `croner` — cron scheduling
- `@makaio/expression` — expression evaluation for conditions
- `@makaio/storage-core`, `@makaio/storage-handlers`
