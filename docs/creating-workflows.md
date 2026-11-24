---
title: Creating Workflows
description: Build typed, event-driven workflows using the factory pipeline API with code steps, agent steps, loops, and iterators.
---

Workflows are multi-step automations that combine typed handler functions, agent delegations,
convergence loops, and collection iterators into a linear pipeline. Each workflow declares
automation trigger bindings (bus events, schedules, or any extension-contributed trigger type) and
a sequence of nodes that the workflow engine executes in order.

Workflows are authored as TypeScript files using the `defineWorkflow()` builder API. The
builder produces two outputs:

- **`definition`** — a fully serializable JSON structure safe to store and display in the UI.
- **`runtimeHandlers`** — an in-memory map of handler functions consumed by the executor.

Multiple related workflows can be packaged together using `defineWorkflowBundle()`.

**Execution environment:** The workflow engine dispatches each workflow execution to a Piscina
worker thread. The worker `import()`s the workflow file, builds the runtime context, and
executes the node pipeline in-process.

---

## Quick Start

Create a workflow file anywhere in your project. `.makaio/personal/workflows/` is the
convention for developer-local workflows (gitignored); `.makaio/workflows/` is for shared
team workflows.

```typescript
// .makaio/personal/workflows/hello.ts
import { defineWorkflow } from '@makaio/contracts';
import { z } from 'zod';

// No declared triggers: this workflow is only ever started by invoking it
// directly — `makaio workflow run`, or a `workflow.start` bus request.
const workflow = defineWorkflow('hello', {
  name: 'Hello World',
  triggers: [],
});

workflow.codeStep('greet', async (ctx) => {
  return { message: `Hello from workflow ${ctx.workflowId}!` };
});

export default workflow;
```

Run it:

```bash
# One-shot with inline payload
makaio workflow run .makaio/personal/workflows/hello.ts --payload '{}'

# Or pass the payload through stdin
echo '{}' | makaio workflow run .makaio/personal/workflows/hello.ts
```

---

## The Six Primitives

Every workflow is composed from six building blocks, each expressed as a method on the
fluent builder or as a standalone factory function.

| Primitive | Method / Factory | Purpose |
|-----------|-----------------|---------|
| Code Step | `.codeStep()` / `codeStep()` | Sequential handler step |
| Agent Step | `.agentStep()` / `agentStep()` | Agent invocation for a named role |
| Parallel | `.parallel()` | Fan-out; runs N branches concurrently |
| Loop | `.loop()` / `loop()` | Repeat a body until a check passes |
| Iterate | `.iterate()` / `iterate()` | Single handler mapped over a collection |
| Iterate chain | `.iterateChain()` / `iterateChain()` | Static sub-chain mapped over a collection |

Standalone factory functions (`codeStep`, `agentStep`, `iterate`, `iterateChain`, `loop`)
create nodes for embedding inside `.parallel()` or `.iterateChain()` calls. They carry the
same options as their builder-method counterparts.

Code-step-owned child sessions that are not semantically subagents should use the existing
session branch semantics. Use `branchKind: 'branch'` for generic workflow/code-step child
sessions and identify the owning workflow frame through `WorkflowSubjects.frame.sessionLinked`
or explicit session metadata. `BranchKind` describes session lifecycle semantics;
product-specific step identity belongs in frame links or metadata rather than a new branch
kind.

---

## Authoring API

### `defineWorkflow(id, options?)`

Creates a workflow builder. The `id` is a stable identifier used in bus events, storage, and
chain rules. `name` is the display name; `description` is shown in the UI.

```typescript
import { defineWorkflow, BusEventWorkflowTrigger } from '@makaio/contracts';

const workflow = defineWorkflow('my-workflow', {
  name: 'My Workflow',
  description: 'Does useful things',
  triggers: [/* trigger definitions */],
});

export default workflow;
```

#### `extensions`: declarations addressed to extensions

`options.extensions` is a record keyed by extension name. Each value is JSON that belongs to
the extension named by its key; the workflow core stores the record unchanged and interprets
none of it. An extension that understands its entry reads it from `definition.extensions`.

```typescript
const workflow = defineWorkflow('my-workflow', {
  name: 'My Workflow',
  extensions: {
    '@acme/review': { requiredApprovals: 2 },
  },
});
```

- A key must be a valid extension name: a plain identifier or an npm-scoped name
  (`@scope/pkg`). `defineWorkflow` throws on an invalid key.
- A value must be plain JSON. A record that could not be stored unchanged is rejected rather than
  altered: an own `__proto__` key at any depth, an object that is not a plain object, a symbol or
  non-enumerable key, an extra property on an array.
- A definition without declarations omits the field. An empty record (`{}`) is kept as an empty record.
- Saving a definition replaces the whole stored record: an entry that is not sent is removed,
  and a save without `extensions` removes the record.

### `.input(schema)` / `.config(schema)` / `.output(schema)`

Declare Zod schemas for the workflow's input parameters, static configuration, and primary
output. JSON Schema equivalents are written into the serializable definition.

```typescript
import { z } from 'zod';

workflow
  .input(z.object({
    repository: z.string(),
    branch: z.string(),
  }))
  .config(z.object({
    reviewerRole: z.string().default('code-reviewer'),
  }))
  .output(z.object({
    verdict: z.enum(['approved', 'blocked']),
  }));
```

### `.artifact(options)`

Binds a primary artifact to the workflow before execution. Pass any artifact reference a Code Step needs in its inputs. The step reads or revises that reference through a registered request.

```typescript
workflow.artifact({
  kind: 'implementation-review',
  schemaVersion: '1',
  scope: { level: 'global' },
  statusPath: 'status',
});
```

### `.codeStep(id, handler, options?)`

Appends a sequential work step. The handler receives a `StepContext` and must return a
JSON-serializable value. The return value is available as `ctx.previousSteps[id]` in
subsequent steps.

```typescript
workflow.codeStep('aggregate', async (ctx) => {
  const prev = ctx.previousSteps['reviews'];
  if (prev.status !== 'completed') return { findings: [] };
  return { findings: prev.output.flat() };
});
```

Optional `when` and `skip` jexl expressions control conditional execution:

```typescript
workflow.codeStep('escalate', escalateHandler, {
  when: 'output.blockers.length > 0',
});
```

### `.agentStep(id, role, options?)`

Appends an agent invocation for a named role. The role is resolved at runtime through the
`resolveRole` bus RPC to determine the concrete agent configuration.

The `prompt` supports `{{ expr }}` placeholders: a structured value (object or array) renders
as JSON, a path that resolves to nothing renders as an empty string, and a placeholder whose
expression fails to evaluate fails the step visibly rather than rendering silently empty.

```typescript
workflow.agentStep('implement', 'implementer', {
  prompt: 'Implement the plan described in {{ input.description }}',
  outputSchema: {
    type: 'object',
    properties: { summary: { type: 'string' } },
    required: ['summary'],
  },
  timeoutMs: 300_000,
  completion: 'turn',
});
```

`outputSchema` is a JSON Schema record forwarded to structured-output capable adapters.
`timeoutMs` bounds the agent step execution. `completion: 'turn'` completes when the
agent's first turn finishes; omit it to use the default tool-completion contract.

### `.parallel(id, options, branches)`

Appends a fan-out node. All branches run concurrently; the parallel node completes when all
branches settle. Use the standalone `codeStep()` or `agentStep()` factories to build branch
nodes.

```typescript
import { codeStep, agentStep } from '@makaio/contracts';

workflow.parallel('reviews', {}, [
  codeStep('spec-review', specReviewHandler),
  agentStep('quality-review', 'code-reviewer'),
  codeStep('test-coverage', coverageHandler),
]);
```

Execution mode is controlled by `options.mode`:

- `'all-settled'` (default) — wait for all branches; individual failures captured in results.
- `'fail-fast'` — fail the parallel node as soon as any branch fails.

```typescript
workflow.parallel('providers', { mode: 'fail-fast' }, [
  codeStep('try-primary', primaryHandler),
  codeStep('try-secondary', secondaryHandler),
]);
```

### `.loop(id, bodyNodes, options)`

A loop definition names an executable step from its body in `check`. Each round
must complete exactly one occurrence of that step with output `{ done: boolean }`.
The loop reads that result after the body finishes. It returns
`{ passed: true, rounds, bodyOutputs }` when the check returns `done: true`.
If the limit is reached, the default behavior is to fail. Set `onExhausted: 'complete'`
to return `{ passed: false, rounds, bodyOutputs }` and continue.

### `.iterate(id, handler, options)`

Appends a node that maps a single handler over a collection expression. The `collection` jexl
expression is evaluated at runtime to produce an array. The handler is invoked once per item;
`ctx.item` carries the current element.

```typescript
workflow.iterate('apply-findings', async (ctx) => {
  const finding = ctx.item as ReviewFinding;
  await applyFix(finding);
  return { id: finding.id, applied: true };
}, {
  collection: 'output.findings',
  concurrency: 3,
});
```

`ctx.index` carries the zero-based item index. `concurrency` controls parallel item
execution (default: sequential).

### `.iterateChain(id, chain, options)`

Appends a node that maps a static sub-chain over a collection expression. Use when each item
requires multiple sequential steps. The sub-chain is a list of nodes built with standalone
factory functions; all nodes see `ctx.item` bound to the current collection element.

```typescript
import { codeStep, agentStep } from '@makaio/contracts';

workflow.iterateChain('process-findings', [
  agentStep('analyze-finding', 'code-reviewer', {
    prompt: 'Analyze this finding: {{ item.description }}',
  }),
  codeStep('validate-analysis', validateAnalysisHandler),
  codeStep('apply-finding', applyFindingHandler),
], {
  collection: 'output.findings',
});
```

Unlike `.iterate()`, the sub-chain topology is fully visible to the GUI and static
introspection without running the workflow.

---

## Real-World Example: Review Workflow

This example shows a review workflow with three parallel steps (spec, quality, test
coverage), an `iterateChain` that processes each finding through a multi-step
sub-pipeline, and a final step that returns the review verdict.

```typescript
// .makaio/workflows/review.ts
import {
  defineWorkflow,
  codeStep,
  agentStep,
} from '@makaio/contracts';
import { z } from 'zod';

// ── Schemas ────────────────────────────────────────────────────

const ReviewInputSchema = z.object({
  repository: z.string(),
  branch: z.string(),
  planArtifactId: z.string(),
});

const ReviewConfigSchema = z.object({
  reviewerRole: z.string().default('code-reviewer'),
});

const ReviewFindingSchema = z.object({
  id: z.string(),
  category: z.enum(['spec', 'quality', 'test-coverage']),
  severity: z.enum(['blocker', 'warning', 'info']),
  description: z.string(),
});
type ReviewFinding = z.infer<typeof ReviewFindingSchema>;

const ReviewOutputSchema = z.object({
  verdict: z.enum(['approved', 'blocked']),
  findingsApplied: z.number(),
});

// ── Handlers ───────────────────────────────────────────────────

async function aggregateFindingsHandler(ctx) {
  const parallel = ctx.previousSteps['delegate-reviews'];
  if (parallel?.status !== 'completed') return { findings: [], hasBlockers: true };

  const output = parallel.output as {
    branches: Record<string, PromiseSettledResult<{ findings: ReviewFinding[] }> | { status: 'cancelled' }>;
  };
  const results = Object.values(output.branches);
  const findings = results.flatMap((result) =>
    result.status === 'fulfilled' ? result.value.findings : [],
  );
  return {
    findings,
    hasBlockers: results.some((result) => result.status !== 'fulfilled')
      || findings.some((finding) => finding.severity === 'blocker'),
  };
}

async function applyFindingsHandler(ctx) {
  const finding = ReviewFindingSchema.parse(ctx.item);
  return { id: finding.id, finding };
}

async function finalizeReviewHandler(ctx) {
  const review = ctx.previousSteps['aggregate-findings']?.output as
    | { hasBlockers: boolean }
    | undefined;
  const verdict = review?.hasBlockers === false ? 'approved' : 'blocked';
  return {
    verdict,
    findingsApplied: ctx.previousSteps['apply-findings']?.output?.length ?? 0,
  };
}

// ── Workflow definition ────────────────────────────────────────

const reviewWorkflow = defineWorkflow('review', {
  name: 'Implementation Review',
  // No declared triggers: started directly (`makaio workflow run`, `workflow.start`).
  triggers: [],
})
  .input(ReviewInputSchema)
  .config(ReviewConfigSchema)
  .output(ReviewOutputSchema)
  .artifact({
    kind: 'implementation-review',
    schemaVersion: '1',
    scope: { level: 'global' },
    statusPath: 'status',
  })

  // Fan out to three parallel reviewer steps
  .parallel('delegate-reviews', {}, [
    agentStep('spec-review', 'spec-reviewer', {
      prompt: 'Review spec compliance for branch {{ input.branch }}',
    }),
    agentStep('quality-review', 'code-reviewer', {
      prompt: 'Review code quality for branch {{ input.branch }}',
    }),
    codeStep('test-coverage', async (ctx) => {
      // Automated coverage check — no agent needed
      const { branch } = ReviewInputSchema.parse(ctx.inputs);
      const coverage = await checkTestCoverage(branch);
      return { findings: coverage.violations };
    }),
  ])

  // Aggregate parallel results into a flat findings list
  .codeStep('aggregate-findings', aggregateFindingsHandler)

  // Enrich and collect each finding via a multi-step sub-chain
  .iterateChain('apply-findings', [
    agentStep('enrich-finding', 'code-reviewer', {
      prompt: 'Enrich this finding with a suggested fix: {{ item.description }}',
    }),
    codeStep('persist-finding', applyFindingsHandler),
  ], {
    collection: 'output.findings',
  })

  // Return the verdict
  .codeStep('finalize', finalizeReviewHandler);

export default reviewWorkflow;
```

### Running It

**One-shot test:**

```bash
makaio workflow run .makaio/workflows/review.ts \
  --payload '{"repository":"my-repo","branch":"feature/x","planArtifactId":"art-123"}'
```

**Automatic — wait for a matching artifact status event:**

```bash
makaio workflow run .makaio/workflows/review.ts
# -> "Awaiting trigger for workflow..."
# Set an implementation-plan artifact status to 'ready-for-review':
# -> Workflow runs the reviews and records the verdict
```

---

## Workflow Bundles

Group related workflows together using `defineWorkflowBundle()`.

```typescript
// .makaio/workflows/review-bundle.ts
import { defineWorkflowBundle } from '@makaio/contracts';
import reviewWorkflow from './review.js';
import applyFindingsWorkflow from './apply-findings.js';

export const bundle = defineWorkflowBundle({
  workflows: [reviewWorkflow, applyFindingsWorkflow],
});
```

For workflow-to-workflow coordination driven by Artifact status events, use the Transition
Pipeline.

### Transition Rules

Transition Rules react to `artifact.status.changed` (and other artifact events) to start
workflows or trigger other actions. They are purely serializable — no functions. Rules are
contributed via extension manifests and registered by the Transition Pipeline service.

Co-locate Transition Rules with their related workflow exports in the same file:

```typescript
// .makaio/workflows/review-transitions.ts
import type { TransitionRuleDefinition } from '@makaio/contracts';

export const startReviewOnPlanReady: TransitionRuleDefinition = {
  id: 'review.start-on-plan-ready',
  description: 'Start the review workflow when an implementation plan is ready for review',
  on: 'artifact.status.changed',
  when: {
    '$expr': 'artifact.kind === "implementation-plan" && current === "ready-for-review"',
  },
  action: {
    type: 'workflow.start',
    input: {
      workflowId: 'review',
      inputExpression: '{ planArtifactId: artifact.id, repository: artifact.scope.ids.projectId, branch: artifact.data.branch }',
    },
  },
  enabled: true,
};

export const blockPlanOnRejection: TransitionRuleDefinition = {
  id: 'review.block-plan-on-rejection',
  description: 'Block the parent implementation plan when a review is rejected',
  on: 'artifact.status.changed',
  when: {
    '$expr': 'artifact.kind === "implementation-review" && current === "blocked"',
  },
  action: {
    type: 'workflow.start',
    input: {
      workflowId: 'apply-plan-block',
      inputExpression: '{ reviewArtifactId: artifact.id }',
    },
  },
  enabled: true,
};
```

---

## Triggers

A declared trigger says which *automation trigger* starts the workflow. A workflow can
declare several — any one of them can start an execution — and a workflow that declares none
is started only by invoking it directly.

Every declared trigger is a binding onto a registered automation trigger type: the type owns
the live source (a bus subscription, a schedule, a webhook listener) and validates the
binding's `params`, while the optional `when` condition stays with the workflow. Two
workflows binding the same type with the same params share one source.

### Bus Event Trigger

Fires when a typed bus subject emits a matching message.

```typescript
import { BusEventWorkflowTrigger } from '@makaio/contracts';
import { GitSubjects } from '@makaio/services-core/git/namespace';

BusEventWorkflowTrigger({
  subject: GitSubjects.checkout,
  when: { field: 'payload.currentBranch', operator: { $startsWith: 'release/' } },
})
```

Trigger matching uses the subject's payload schema. Supply values that steps must consume through workflow inputs.

### Cron Trigger

Fires on a schedule. The trigger occurrence is available to the workflow trigger binding.

```typescript
import { CronWorkflowTrigger } from '@makaio/contracts';

CronWorkflowTrigger({ schedule: '0 9 * * 1', timezone: 'Europe/Berlin' })
```

### Extension-Contributed Triggers

Any other trigger type — webhooks, provider events, anything an extension contributes —
is bound with `AutomationWorkflowTrigger`, using the trigger definition the contributing
extension exports. Params and payload are typed from that definition's schemas.

```typescript
import { AutomationWorkflowTrigger } from '@makaio/contracts';
import { GithubWebhookTrigger } from 'some-extension/triggers';

AutomationWorkflowTrigger(GithubWebhookTrigger, {
  params: { event: 'push' },
  when: { $expr: 'payload.ref == "refs/heads/main"' },
})
```

### Manual Invocation

There is no manual trigger type: a workflow with `triggers: []` is simply one that nothing
starts on its own. Run it with `makaio workflow run`, or start it over the bus with
`workflow.start`.

### Conditions (`when`)

Every authoring helper except `CronWorkflowTrigger` accepts an optional `when`, a `Condition`
from `@makaio/rules` (field comparisons, `$and` / `$or` / `$not`, and `$expr` jexl expressions).
The workflow engine evaluates it after the source has emitted, so it never changes what the
shared source observes. A binding without `when` fires on every event the trigger emits.

The evaluation context is `{ payload }`, where `payload` is the emitted event payload, so field
paths and expressions start with `payload.` (`payload.currentBranch`, not `currentBranch`).

```typescript
BusEventWorkflowTrigger({
  subject: GitSubjects.checkout,
  when: {
    $and: [
      { field: 'payload.currentBranch', operator: { $startsWith: 'release/' } },
      { field: 'payload.worktree', operator: { $exists: true } },
    ],
  },
})
```

Inside a plain `Condition` the `field` is an untyped string. `payloadField<TPayload>(path, operator)`
builds the same field condition with the path checked against the payload type, so a typo fails
at compile time. Take the payload type from the binding with `ExtractTriggerPayload`:

```typescript
import { BusEventWorkflowTrigger, payloadField } from '@makaio/contracts';
import type { ExtractTriggerPayload } from '@makaio/contracts';

const checkout = BusEventWorkflowTrigger({ subject: GitSubjects.checkout });
type CheckoutPayload = ExtractTriggerPayload<typeof checkout>;

BusEventWorkflowTrigger({
  subject: GitSubjects.checkout,
  when: payloadField<CheckoutPayload>('currentBranch', 'main'),
})
```

The condition is also checked against the trigger's event schema: when the reconciler installs the
binding, and when `makaio workflow run` awaits the trigger. A condition that cannot hold for that
schema (for example a field path the event does not have) is rejected at that point. If a
condition cannot be evaluated against a particular event, the engine logs the failing node and
the trigger does not fire for that event.

The former `filter` and `filterExpression` keys no longer exist. A persisted binding that still
carries either one is rejected with an error that names `when`; the replacement for
`filterExpression` is `when: { $expr: '...' }`.

---

## Step Context

Every Code Step receives the same data and capability interface on the local runner and in a worker.

- Run data contains `workflowId`, `executionId`, `inputs`, `config`, and `previousSteps`.
- Iterations can supply `item`, `index`, and `previous`.
- Use `signal` to stop work when the runtime requests cancellation. The local runner stops waiting for a pending handler on cancellation and closes its managed process scope.
- `request({ subject, payload })` returns a typed success or refusal. The local runner validates locally registered requests and forwards them under the caller's authority. File handlers on the standard host-connected local worker can use host-only subjects and receive JSON responses without subject-schema validation in the thread. An isolated step process can refuse requests.
- `launchProcess({ program, args, cwd, stdin })` returns a typed refusal or a portable handle with process completion and available pipes. The runtime supplies the environment and execution bounds. Relative paths resolve from the verified workspace when the runner materialized one.

## Example: Run a managed process

```typescript
import { defineWorkflow } from '@makaio/contracts';

export default defineWorkflow('git-status')
  .codeStep('status', async (ctx) => {
    const started = await ctx.launchProcess({
      program: 'git',
      args: ['status', '--short'],
      cwd: '.',
      stdin: 'none',
    });
    if (!started.ok) throw new Error(started.code);

    const result = await started.handle.result;
    if (result.status !== 'completed') throw new Error(result.status);
    return { exitCode: result.exitCode ?? null };
  })
  .build();
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

The CLI and its file reruns execute handlers in the caller's local runtime. A worker runs code steps in separate processes from a prepared checkout.

**Trigger resolution order:**

1. `--payload` flag → run immediately with provided payload
2. Piped stdin (non-TTY) → parse as JSON, run immediately
3. Neither → await bus-event triggers when the file declares them; otherwise run with an
   empty trigger payload

---

## Workflow File Locations

| Path | Scope | Tracked |
|------|-------|---------|
| `{repoPath}/.makaio/workflows/` | Team workflows | Yes |
| `{repoPath}/.makaio/personal/workflows/` | Personal workflows | No (gitignored) |
| `{makaioHome}/workflows/` | Global user workflows | N/A (outside repo) |

Add this to your repo's `.gitignore`:

```gitignore
.makaio/personal/
```

Host applications and extensions may also register workflow definitions programmatically.
Those extension-specific discovery conventions are documented by the extension that owns them.

---

## Execution Model

Workflow execution runs in a Piscina worker thread. The worker imports the workflow file,
builds the runtime context, and executes the node pipeline sequentially:

```
Main Process                          Piscina Worker
─────────────                         ──────────────
WorkflowExecutor                      import(workflowFile)
  │                                     │
  ├─ runFile(file, payload)            ├─ Pipeline: sequential nodes
  │    → spawn worker ─────────────►   ├─ Parallel: Promise.allSettled branches
  │                                     ├─ Loop: repeat body and evaluate check
  ├─ lifecycle events ◄──── bus ◄──────├─ Iterate: per-item handler
  │                                     └─ return result
  └─ result ◄───────────────────────────
```

**Lifecycle events** are emitted over the bus for each node and for the execution as a whole
(`workflow.node.started`, `workflow.node.completed`, `workflow.execution.completed`, etc.).
The `--verbose` CLI flag subscribes to these in real time.

**WorkLog projection:** A subscriber-side service listens to lifecycle events and builds
denormalized read models (`WorkLogExecutionSummary`, `WorkLogFrameEntry`, etc.) for dashboards
and billing. WorkLog is an observability cache — it is never required for the runtime to make
progress.

---

## File References

| Concept | File |
|---------|------|
| `defineWorkflow`, standalone factories, trigger helpers | `framework/core/contracts/src/workflow/authoring.ts` |
| Builder interface, `GateOptions`, `IterateOptions`, `ParallelOptions` | `framework/core/contracts/src/workflow/authoring-builder.ts` |
| `StepContext` | `framework/core/contracts/src/workflow/authoring-context.ts` |
| `defineWorkflowBundle` | `framework/core/contracts/src/workflow/bundle.ts` |
| `defineTransitionRule`, `TransitionEventType` | `framework/core/contracts/src/workflow/transition.ts` |
| WorkLog projection schemas | `framework/core/contracts/src/workflow/worklog.ts` |
| Bus namespace (`WorkflowSubjects`) | `framework/core/contracts/src/workflow/namespace.ts` |
| Workflow definition schemas | `framework/core/contracts/src/workflow/schemas.ts` |
| Workflow executor | `framework/subsystems/workflow-engine/src/workflow-executor.ts` |
| CLI run command | `framework/extensions/workflow/src/run-command.ts` |
| Git event schemas | `framework/services/core/src/git/schemas/event.ts` |
| Git hooks extension | `framework/extensions/git-hooks/` |
