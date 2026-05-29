---
title: Creating Workflows
description: Build typed, event-driven workflows that automate multi-step tasks with shell commands, agent steps, and approval gates.
---

Workflows are multi-step automations that combine shell commands, agent steps, approval
gates, and typed function steps into a DAG. Each workflow declares triggers (bus events,
cron, manual) and steps that the workflow engine schedules and executes.

Workflows can be authored in two ways:

- **TypeScript files** — using the `defineWorkflow()` builder API with typed triggers
  and function steps. This is the primary authoring surface covered in this guide.
- **JSON definitions** — stored in the database via `WorkflowSubjects.setDefinition`,
  typically created through the workflow editor UI. These use string-template expressions
  (`{{ steps.id.result }}`) for inter-step data flow instead of typed function references.

Both formats share the `WorkflowDefinitionInput` shape, but persisted JSON definitions
use the stricter persisted schema and cannot contain runtime-only function steps.
TypeScript file workflows keep those functions in `workflow.runtimeSteps` and execute
through the file workflow runner.

**Execution environments:** The workflow engine dispatches execution through pluggable
runners at two levels. `IWorkflowRunner` dispatches a whole workflow execution; CLI-served
runtimes default this to Piscina worker threads with bus access. If no workflow runner is
configured, the engine falls back to the in-process DAG scheduler. `IStepRunner` remains
the lower-level step execution seam used by the in-process scheduler for executable steps.

---

## Quick Start

Create a workflow file anywhere — `.makaio/personal/workflows/` is the convention for
developer-local workflows (gitignored), `.makaio/workflows/` for shared team workflows.

```typescript
// .makaio/personal/workflows/hello.ts
import { defineWorkflow, ManualWorkflowTrigger } from '@makaio/contracts';

const workflow = defineWorkflow('hello', {
  name: 'Hello World',
  triggers: [ManualWorkflowTrigger()],
});

workflow.addStep('greet', async () => {
  return { message: 'Hello from a workflow!' };
}, { needs: [] });

export default workflow;
```

Run it:

```bash
# One-shot with inline payload
makaio workflow run .makaio/personal/workflows/hello.ts --payload '{}'

# Or pass the payload through stdin
echo '{}' | makaio workflow run .makaio/personal/workflows/hello.ts
```

The `workflow run` command connects to a running Makaio server. Installed builds expose
the command as `makaio`; source checkouts can run the same CLI entrypoint through their
host surface.

---

## Authoring API

### `defineWorkflow(id, options?)`

Creates a workflow builder. The `id` is a stable identifier; `name` is the display name.

```typescript
import { defineWorkflow, BusEventWorkflowTrigger } from '@makaio/contracts';

const workflow = defineWorkflow('my-workflow', {
  name: 'My Workflow',
  description: 'Does useful things',
  triggers: [/* trigger definitions */],
});

export default workflow;
```

The default export is what the runtime `import()`s. The builder produces two outputs:
`workflow.definition` (serializable JSON for storage/UI) and `workflow.runtimeSteps`
(in-memory function map for the worker executor).

### `workflow.addStep(id, fn, options)`

Registers a typed function step. Returns a `StepRef` that carries the inferred output
type — downstream steps receive it via `ctx.previousSteps`.

```typescript
const fetchStep = workflow.addStep('fetch-data', async (ctx) => {
  const data = await loadSomething(ctx.repoPath);
  return { items: data, count: data.length };
}, { needs: [] });

workflow.addStep('process', (ctx) => {
  // ctx.previousSteps['fetch-data'] is fully typed:
  //   { status: 'completed', output: { items: ..., count: number } }
  //   | { status: 'skipped' }
  const prev = ctx.previousSteps['fetch-data'];
  if (prev.status !== 'completed') return { processed: 0 };
  return { processed: prev.output.count };
}, { needs: [fetchStep] });
```

**Constraints:**
- Step return types must satisfy `JsonValue` (serializable for persistence and bus events).
- Step IDs must be unique within a workflow.
- `needs` declares the DAG — steps run as soon as their dependencies complete.

**Step options:**

| Option | Type | Description |
|--------|------|-------------|
| `needs` | `StepRef[]` | Predecessor steps (empty array for root steps) |
| `if` | `string` | Optional jexl expression; falsy skips the step |

### `workflow.addBusRequestStep(id, config, options)`

Registers a typed bus RPC step. Unlike `addStep`, there is no function to register —
the step is entirely schema-driven and executed inline by the scheduler. Returns a
`StepRef` that carries the inferred response type from the subject definition.
See [Bus Request Steps](#bus-request-steps) for a full example and runtime semantics.

---

## Bus Request Steps

Use `bus-request` when a workflow step should call an existing typed bus RPC.
The TypeScript authoring helper accepts a typed `SubjectDefinition`, while the
stored workflow definition contains the full subject string.

```ts
import { ArtifactSubjects, BusEventWorkflowTrigger, BusRequestStep, defineWorkflow } from '@makaio/contracts';

const workflow = defineWorkflow('publish-plan-artifact', {
  name: 'Publish plan artifact',
  triggers: [
    BusEventWorkflowTrigger({
      subject: ArtifactSubjects.created,
      filter: { 'artifact.kind': 'implementation-plan' },
    }),
  ],
});

workflow.addBusRequestStep(
  'publish-plan',
  BusRequestStep({
    subject: ArtifactSubjects.create,
    payload: {
      kind: 'published-plan',
      schemaVersion: '1',
      scope: { level: 'global' },
      data: { content: '{{ trigger.artifact.data.content }}' },
      relations: [],
      actor: { kind: 'system', id: 'workflow' },
    },
    timeoutMs: 10_000,
  }),
  { needs: [] },
);

export default workflow;
```

**How it works:**

- `BusRequestStep()` accepts a typed `SubjectDefinition` for compile-time payload and
  response type checking. It serializes the subject to its full string form
  (e.g. `'github:app.issue.create'`) in the stored definition, keeping persisted
  workflow definitions serializable.
- String payload values support `{{ }}` template expressions. A lone expression
  (`'{{ inputs.count }}'`) returns the native type (number, boolean, etc.); mixed
  strings (`'count: {{ inputs.count }}'`) remain strings.
- `timeoutMs` is configured on `BusRequestStep({ ... })`, alongside the request
  subject and payload. It is forwarded to the bus RPC as the request timeout.
- At runtime, the subject must be registered and must be a request subject. If the
  subject is missing or not a request, the step fails with a descriptive error.
- `bus-request` steps are compatible with persisted workflow definitions (unlike
  `function` steps, which are file-workflow-only).

**Step options:**

| Option | Type | Description |
|--------|------|-------------|
| `needs` | `StepRef[]` | Predecessor steps (empty array for root steps) |
| `if` | `string` | Optional jexl expression; falsy skips the step |

---

## Triggers

Triggers determine when the workflow executes. A workflow can declare multiple triggers —
any one of them can start an execution. The trigger payload is available as `ctx.trigger`
in every step.

### Bus Event Trigger

Fires when a typed bus subject emits a matching message.

```typescript
import { BusEventWorkflowTrigger } from '@makaio/contracts';
import { GitSubjects } from '@makaio/services-core/git/namespace';

BusEventWorkflowTrigger({
  subject: GitSubjects.checkout,
  filter: { /* optional structural filter */ },
  filterExpression: '...', // optional jexl expression
})
```

The trigger payload type is inferred from the subject's Zod schema — `ctx.trigger` is
fully typed in step functions.

For persisted workflows, bus-event trigger evaluation honors the subject, structural
`filter`, and `filterExpression`. For ad-hoc file workflows run with
`makaio workflow run <file>` and no payload, await-trigger mode currently waits on
bus-event triggers using the subject and structural `filter`.

### Other Triggers

| Trigger | Factory | Payload |
|---------|---------|---------|
| Manual | `ManualWorkflowTrigger()` | `void` |
| Cron | `CronWorkflowTrigger({ schedule: '0 9 * * 1' })` | `{ firedAt, triggerIndex }` |
| Webhook | `WebhookWorkflowTrigger({ event: 'push' })` | `{ event, branch?, repo?, body }` |
| Extension | `ExtensionWorkflowTrigger({ extensionType: 'ext:event' })` | `Record<string, unknown>` |

---

## Step Context

Every step function receives a `StepContext` with platform info, trigger data, and
predecessor outputs:

```typescript
interface StepContext<TTrigger, TPreviousSteps> {
  // Platform
  readonly repoPath: string;
  readonly makaioHome: string;
  readonly os: 'darwin' | 'linux' | 'win32';
  readonly arch: string;
  readonly worktree?: string;

  // Execution
  readonly executionId: string;
  readonly workflowId: string;
  readonly inputs: Record<string, unknown>;
  readonly env: Record<string, string>;
  readonly signal: AbortSignal;

  // Typed from triggers and needs
  readonly trigger: TTrigger;
  readonly previousSteps: TPreviousSteps;

  // For-each context (when inside a for-each expansion)
  readonly item?: unknown;
  readonly index?: number;
}
```

---

## Real-World Example: Worktree Bootstrap

This workflow copies `.env` files from the main worktree into secondary worktrees
when a checkout event arrives from that worktree. It intentionally listens to
`git.checkout`: creating a new worktree checks out its branch, so the event payload's
`repoPath` is the new worktree path. The workflow then compares that path with
`git worktree list` to decide whether it is running in the main worktree or a
secondary one. Later branch checkouts in a secondary worktree can also re-run it;
the copy step is idempotent.

```typescript
// .makaio/personal/workflows/worktree-bootstrap.ts
import { defineWorkflow, BusEventWorkflowTrigger } from '@makaio/contracts';
import { GitSubjects } from '@makaio/services-core/git/namespace';
import { execFile } from 'node:child_process';
import { access, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const workflow = defineWorkflow('worktree-bootstrap', {
  name: 'Copy gitignored files to new worktrees',
  triggers: [BusEventWorkflowTrigger({ subject: GitSubjects.checkout })],
});

const resolveWorktrees = workflow.addStep(
  'resolve-worktrees',
  async (ctx) => {
    const { repoPath } = ctx.trigger;

    const { stdout } = await execFileAsync(
      'git', ['worktree', 'list', '--porcelain'], { cwd: repoPath },
    );
    const worktrees = stdout
      .split('\n\n')
      .map((block) => block.match(/^worktree (.+)$/m)?.[1])
      .filter((p): p is string => p !== undefined);

    const mainWorktree = worktrees[0];
    if (!mainWorktree || mainWorktree === repoPath) {
      return { mainWorktree: mainWorktree ?? repoPath, targetWorktree: repoPath, isNewWorktree: false };
    }

    return { mainWorktree, targetWorktree: repoPath, isNewWorktree: true };
  },
  { needs: [] },
);

workflow.addStep(
  'copy-files',
  async (ctx) => {
    const resolved = ctx.previousSteps['resolve-worktrees'];
    if (resolved.status !== 'completed') return { copied: [], skipped: 'resolve step was skipped' };

    const { mainWorktree, targetWorktree, isNewWorktree } = resolved.output;
    if (!isNewWorktree) return { copied: [], skipped: 'not a secondary worktree' };

    const filesToCopy = ['.env', '.env.local'];
    const copied: string[] = [];

    for (const file of filesToCopy) {
      const src = join(mainWorktree, file);
      const dst = join(targetWorktree, file);
      try {
        await access(src);
        await copyFile(src, dst);
        copied.push(file);
      } catch {
        // Source doesn't exist — skip silently
      }
    }

    return { copied };
  },
  { needs: [resolveWorktrees] },
);

export default workflow;
```

### Running It

**Prerequisites:** Install native git hooks so checkout events reach the bus:

```bash
makaio git-hooks install
makaio git-hooks status
# -> { "covered": true, "reason": "covered", "coveredOperations": ["commit", "checkout"] }
```

**One-shot test with inline payload:**

```bash
makaio workflow run .makaio/personal/workflows/worktree-bootstrap.ts \
  --payload '{"repoPath":"/path/to/worktree","currentBranch":"feature","timestamp":"2026-01-01T00:00:00Z"}'
```

**Automatic — await a single trigger, then exit:**

```bash
makaio workflow run .makaio/personal/workflows/worktree-bootstrap.ts
# -> "Awaiting trigger for workflow..."
# Create a worktree in another terminal:
#   git worktree add ../my-feature -b my-feature develop
# -> Workflow fires, copies .env, exits
```

**Continuous watch — re-await after each execution:**

```bash
makaio workflow run .makaio/personal/workflows/worktree-bootstrap.ts --watch
# -> Re-runs on matching checkout events, keeps running until Ctrl-C
```

---

## CLI Reference

```
makaio workflow run [options] <file>

Arguments:
  file                 Workflow TS/JS file path

Options:
  --payload <json>     Trigger payload as inline JSON
  --watch              Keep running after completion, re-await triggers
  --dry-run            Validate payload shape, then report unsupported dry-run mode
  --timeout <ms>       Max wait time in milliseconds
  --verbose            Stream step lifecycle events to stderr
```

**Trigger resolution order:**

1. `--payload` flag → run immediately with provided payload
2. Piped stdin (non-TTY) → parse as JSON, run immediately
3. Neither → await bus-event triggers when the file declares them; otherwise run
   with an empty trigger payload

The CLI writes human-readable status lines to stdout. Lifecycle events go to stderr
with `--verbose`.

---

## Workflow File Locations

| Path | Scope | Tracked |
|------|-------|---------|
| `{repoPath}/.makaio/workflows/` | Team workflows | Yes |
| `{repoPath}/.makaio/personal/workflows/` | Personal workflows | No (gitignored) |
| `{makaioHome}/workflows/` | Global user workflows | N/A (outside repo) |

Personal workflows live in `.makaio/personal/` which is gitignored. Add this to your
repo's `.gitignore`:

```gitignore
.makaio/personal/
```

---

## Execution Model

The workflow engine separates scheduling from execution through pluggable runners:

| Runner | Interface | Isolation | Use case |
|--------|-----------|-----------|----------|
| Piscina (CLI serve default) | `IWorkflowRunner` | Worker thread | File workflows and storage-backed workflows when configured |
| In-process scheduler | internal | None | Embedded/test runtimes or boot configs without a workflow runner |
| Step runner seam | `IStepRunner` | Runner-defined | Executable steps inside the in-process scheduler |

For TypeScript file workflows (`workflow.runFile`), the configured workflow runner dispatches
the entire workflow to a worker thread in the default CLI-served runtime. The worker
`import()`s the file, runs the DAG scheduler, and executes function steps in-process
within the worker — no serialization boundary between those functions.

```
Main Process                          Piscina Worker
─────────────                         ──────────────
WorkflowExecutor                      import(workflowFile)
  │                                     │
  ├─ runFile(file, payload)            ├─ Scheduler: DAG resolution
  │    → spawn worker ─────────────►   ├─ Orchestrator: Promise mgmt
  │                                     │   ├─ Step A: in-process fn()
  ├─ lifecycle events ◄──── bus ◄──────│   ├─ Step B: fs/shell calls
  │                                     │   └─ Step C: bus RPC
  └─ result ◄──────────────────────────└─ return result
```

For storage-backed workflows (`workflow.start`), the engine uses the configured
`IWorkflowRunner` when one is present. Without one, it runs the DAG scheduler in the
host process with the in-process step runner.

**Lifecycle events** are emitted over the bus for each step and for the execution as a
whole (`workflow.step.started`, `workflow.step.completed`, `workflow.execution.completed`,
etc.). The `--verbose` CLI flag subscribes to these in real time.

---

## File References

| Concept | File |
|---------|------|
| Authoring API (`defineWorkflow`, triggers, step types) | `framework/core/contracts/src/workflow/authoring.ts` |
| Workflow schemas (`WorkflowDefinitionInput`, step types) | `framework/core/contracts/src/workflow/schemas.ts` |
| Bus namespace (`WorkflowSubjects`) | `framework/core/contracts/src/workflow/namespace.ts` |
| Workflow executor | `framework/subsystems/workflow-engine/src/workflow-executor.ts` |
| CLI run command | `framework/extensions/workflow/src/run-command.ts` |
| Worker entry point | `framework/runtimes/node/src/workflow-worker/` |
| Git event schemas | `framework/services/core/src/git/schemas/event.ts` |
| Git hooks extension | `framework/extensions/git-hooks/` |
