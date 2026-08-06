# @makaio/subsystem-workflow-engine

Workflow definition storage, DAG-based execution, and declarative trigger
consumption.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    WorkflowExecutor                          │
│  DAG step ordering via topological sort                     │
│  Dependency resolution, forEach expansion, step runners     │
└─────────────────────────────────────────────────────────────┘
         │
         └─ WorkflowTriggerReconciler
                  │  one consumer subscription per persisted
                  │  WorkflowAutomationTriggerBinding
                  ▼
         AutomationTriggerBindingRuntime
         (reference-counted trigger activations)
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

### WorkflowTriggerReconciler
`src/workflow-trigger-reconciler.ts`

The engine owns no trigger sources. Every persisted
`WorkflowAutomationTriggerBinding` becomes one consumer subscription on the
automation trigger binding runtime; the runtime decides how many live sources
that requires, so two workflows bound to the same source share one activation.

The reconciler reads the persisted definitions as its source of truth and treats
workflow CRUD events and `automation-triggers.changed` events as refresh signals.
Refreshes acquire the replacement binding before releasing the previous one, so a
shared source is never torn down mid-refresh.

`filter` and `filterExpression` are consumer-owned: they narrow an event a trigger
has already validated, and are compiled by
`src/workflow-trigger-binding-consumer.ts` (also exported from the
`@makaio/subsystem-workflow-engine/workflow-trigger-binding-consumer` subpath so the
worker's await mode applies identical semantics).

## Usage

```typescript
import { WorkflowSubjects } from '@makaio/contracts';
import { workflowEnginePackage } from '@makaio/subsystem-workflow-engine';

// Register workflowEnginePackage with the node package runtime.
const { executionId } = await bus.request(WorkflowSubjects.start, {
  workflowId: 'workflow-123',
  inputs: {},
});
```

The main package export also exposes `WorkflowExecutor`, `WorkflowStorageSubjects`,
and `registerDrizzleWorkflowStorage` for runtime composition and tests. Workflow
contracts live in `@makaio/contracts`; the package manifest is available from the
`@makaio/subsystem-workflow-engine/package` subpath.

## Dependencies

- `@makaio/expression` — expression evaluation for conditions and trigger filters
- `@makaio/services-core` — automation trigger binding runtime
- `@makaio/storage-core`, `@makaio/storage-handlers`
