---
title: Creating Workflows
description: Build typed, event-driven workflows using the factory pipeline API with stations, parallel delegates, gates, and iterators.
---

Workflows are multi-step automations that combine typed handler functions, agent delegations,
approval gates, and collection iterators into a linear pipeline. Each workflow declares
triggers (bus events, cron, manual) and a sequence of nodes that the workflow engine executes
in order.

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
import { defineWorkflow, ManualWorkflowTrigger } from '@makaio/contracts';
import { z } from 'zod';

const workflow = defineWorkflow('hello', {
  name: 'Hello World',
  triggers: [ManualWorkflowTrigger()],
});

workflow.station('greet', async (ctx) => {
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

## The Seven Primitives

Every workflow is composed from seven building blocks, each expressed as a method on the
fluent builder or as a standalone factory function.

| Primitive | Method / Factory | Purpose |
|-----------|-----------------|---------|
| Station | `.station()` / `station()` | Sequential handler step |
| Delegate (agent) | `.delegateToAgent()` / `delegateToAgent()` | Explicit agent invocation |
| Delegate (role) | `.delegateToRole()` / `delegateToRole()` | Role-resolved agent invocation |
| Parallel | `.parallel()` | Fan-out; runs N branches concurrently |
| Gate | `.gate()` / `gate()` | Human-in-the-loop suspend/resume |
| Iterate | `.iterate()` / `iterate()` | Single handler mapped over a collection |
| Iterate chain | `.iterateChain()` / `iterateChain()` | Static sub-chain mapped over a collection |

Standalone factory functions (`station`, `delegateToAgent`, `delegateToRole`, `gate`,
`iterate`, `iterateChain`) create nodes for embedding inside `.parallel()` or
`.iterateChain()` calls. They carry the same options as their builder-method counterparts.

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

Binds a primary artifact to the workflow. The artifact is loaded before the first station
runs and available as `ctx.artifact` throughout execution. Handlers may update it via
`ctx.artifact.updateArtifact()` and `ctx.artifact.updateStatus()`.

```typescript
workflow.artifact({
  kind: 'implementation-review',
  schemaVersion: '1',
  scope: { level: 'global' },
  statusPath: 'status',
});
```

### `.station(id, handler, options?)`

Appends a sequential work step. The handler receives a `StationContext` and must return a
JSON-serializable value. The return value is available as `ctx.previousSteps[id]` in
subsequent stations.

```typescript
workflow.station('aggregate', async (ctx) => {
  const prev = ctx.previousSteps['reviews'];
  if (prev.status !== 'completed') return { findings: [] };
  return { findings: prev.output.flat() };
});
```

Optional `when` and `skip` jexl expressions control conditional execution:

```typescript
workflow.station('escalate', escalateHandler, {
  when: 'output.blockers.length > 0',
});
```

### `.delegateToAgent(id, agentConfig, options?)`

Appends an explicit agent invocation with fully declared metadata. The GUI can display adapter,
model, and profile without executing the workflow.

```typescript
workflow.delegateToAgent('implement', {
  agentId: 'claude-code-implementer',
  inputExpression: '{ task: input.description, branch: input.branch }',
});
```

### `.delegateToRole(id, role, options?)`

Appends a role-resolved agent invocation. The role name is looked up in the persona registry
at runtime to determine the concrete agent configuration.

```typescript
workflow.delegateToRole('implement', 'implementer', {
  prompt: 'Implement the plan described in {{ input.description }}',
});
```

### `.parallel(id, options, branches)`

Appends a fan-out node. All branches run concurrently; the parallel node completes when all
branches settle. Use the standalone `station()`, `delegateToAgent()`, or `delegateToRole()`
factories to build branch nodes.

```typescript
import { station, delegateToRole } from '@makaio/contracts';

workflow.parallel('reviews', {}, [
  station('spec-review', specReviewHandler),
  delegateToRole('quality-review', 'code-reviewer'),
  station('test-coverage', coverageHandler),
]);
```

Execution mode is controlled by `options.mode`:

- `'all-settled'` (default) — wait for all branches; individual failures captured in results.
- `'fail-fast'` — fail the parallel node as soon as any branch fails.

```typescript
workflow.parallel('providers', { mode: 'fail-fast' }, [
  station('try-primary', primaryHandler),
  station('try-secondary', secondaryHandler),
]);
```

### `.gate(id, options)`

Appends a human-in-the-loop suspend point. The workflow pauses until an external signal
(`workflow.gate.respond`) arrives. The `resume` Zod schema validates the resume payload;
resume data is available in subsequent stations through that gate node's `previousSteps` entry.

```typescript
workflow.gate('approve', {
  prompt: 'Review findings: {{ output.findings.length }} items need attention',
  title: 'Approval Gate',
  autoAction: 'reject',   // action taken on timeout
  timeoutMs: 7 * 24 * 60 * 60 * 1000, // 7 days; null to block indefinitely
  resume: z.object({
    decision: z.enum(['approved', 'rejected']),
    note: z.string().optional(),
  }),
});

workflow.station('post-approval', async (ctx) => {
  const gate = ctx.previousSteps['approve'];
  if (gate?.status !== 'completed') return { verdict: 'rejected' };
  const resume = gate.output as { resumeData?: { decision?: string } };
  return { verdict: resume.resumeData?.decision ?? 'rejected' };
});
```

**Resuming a gate** from outside the workflow:

```typescript
bus.request('workflow.gate.respond', {
  executionId,
  gateId: 'approve',
  action: 'approve',
  resumeData: { decision: 'approved', note: 'LGTM' },
});
```

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
import { station, delegateToRole } from '@makaio/contracts';

workflow.iterateChain('process-findings', [
  delegateToRole('analyze-finding', 'code-reviewer', {
    prompt: 'Analyze this finding: {{ item.description }}',
  }),
  station('validate-analysis', validateAnalysisHandler),
  station('apply-finding', applyFindingHandler),
], {
  collection: 'output.findings',
});
```

Unlike `.iterate()`, the sub-chain topology is fully visible to the GUI and static
introspection without running the workflow.

---

## Real-World Example: Review Workflow

This example shows a review workflow with three parallel delegates (spec, quality, test
coverage), an `apply-findings` station that writes agent output back to the workflow Artifact,
a typed gate for human approval, and an `iterateChain` that processes each finding through a
multi-step sub-pipeline.

```typescript
// .makaio/workflows/review.ts
import {
  BusEventWorkflowTrigger,
  defineWorkflow,
  station,
  delegateToRole,
} from '@makaio/contracts';
import { ArtifactSubjects } from '@makaio/contracts';
import { z } from 'zod';

// ── Schemas ────────────────────────────────────────────────────

const ReviewInputSchema = z.object({
  repository: z.string(),
  branch: z.string(),
  planArtifactId: z.string(),
});

const ReviewConfigSchema = z.object({
  reviewerRole: z.string().default('code-reviewer'),
  autoApprove: z.boolean().default(false),
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
  const branches = ctx.previousSteps['delegate-reviews'];
  if (branches?.status !== 'completed') return { findings: [], hasBlockers: false };

  const allFindings: ReviewFinding[] = (branches.output as Array<PromiseSettledResult<{ findings: ReviewFinding[] }>>).flatMap(
    (r) => r.status === 'fulfilled' ? r.value.findings : [],
  );
  return {
    findings: allFindings,
    hasBlockers: allFindings.some((f) => f.severity === 'blocker'),
  };
}

async function applyFindingsHandler(ctx) {
  // Write agent output back to the bound Artifact
  const finding = ctx.item as ReviewFinding;
  await ctx.artifact?.updateArtifact((current) => {
    const findings = Array.isArray(current.findings) ? current.findings : [];
    return {
      ...current,
      findings: [...findings, { ...finding, appliedAt: Date.now() }],
    };
  });
  return { id: finding.id, applied: true };
}

async function postApprovalHandler(ctx) {
  const gate = ctx.previousSteps['approve'];
  const resume = gate?.status === 'completed'
    ? (gate.output as { resumeData?: { decision?: string } }).resumeData
    : undefined;
  const decision = resume?.decision ?? 'rejected';
  // Promote domain status through the artifact
  await ctx.artifact?.updateStatus(decision === 'approved' ? 'approved' : 'blocked');
  return {
    verdict: decision,
    findingsApplied: ctx.previousSteps['apply-findings']?.output?.length ?? 0,
  };
}

// ── Workflow definition ────────────────────────────────────────

const reviewWorkflow = defineWorkflow('review', {
  name: 'Implementation Review',
  triggers: [
    BusEventWorkflowTrigger({
      subject: ArtifactSubjects['status.changed'],
      filter: { 'artifact.kind': 'implementation-plan', 'event.current': 'ready-for-review' },
    }),
  ],
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

  // Fan out to three parallel reviewer delegates
  .parallel('delegate-reviews', {}, [
    delegateToRole('spec-review', 'spec-reviewer', {
      prompt: 'Review spec compliance for branch {{ input.branch }}',
    }),
    delegateToRole('quality-review', 'code-reviewer', {
      prompt: 'Review code quality for branch {{ input.branch }}',
    }),
    station('test-coverage', async (ctx) => {
      // Automated coverage check — no agent needed
      const coverage = await checkTestCoverage(String(ctx.inputs.branch));
      return { findings: coverage.violations };
    }),
  ])

  // Aggregate parallel results into a flat findings list
  .station('aggregate-findings', aggregateFindingsHandler)

  // Write each finding to the Artifact via a multi-step sub-chain
  .iterateChain('apply-findings', [
    delegateToRole('enrich-finding', 'code-reviewer', {
      prompt: 'Enrich this finding with a suggested fix: {{ item.description }}',
    }),
    station('persist-finding', applyFindingsHandler),
  ], {
    collection: 'output.findings',
  })

  // Human approval gate — auto-rejects after 7 days
  // Gate is skipped when autoApprove is true and there are no blockers
  .gate('approve', {
    prompt: 'Review complete: {{ output.findings.length }} findings, blockers: {{ output.hasBlockers }}',
    title: 'Review Approval',
    autoAction: 'reject',
    timeoutMs: 7 * 24 * 60 * 60 * 1000,
    resume: z.object({
      decision: z.enum(['approved', 'rejected']),
      note: z.string().optional(),
    }),
  })

  // Apply the gate decision to the Artifact status
  .station('finalize', postApprovalHandler);

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
# -> Workflow fires, runs reviews, waits at gate
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

Triggers determine when a workflow executes. A workflow can declare multiple triggers — any
one of them can start an execution.

### Bus Event Trigger

Fires when a typed bus subject emits a matching message.

```typescript
import { BusEventWorkflowTrigger } from '@makaio/contracts';
import { GitSubjects } from '@makaio/services-core/git/namespace';

BusEventWorkflowTrigger({
  subject: GitSubjects.checkout,
  filter: { /* optional structural filter */ },
})
```

The trigger payload type is inferred from the subject's Zod schema — `ctx.trigger` is fully
typed in station handlers.

### Other Triggers

| Trigger | Factory | Notes |
|---------|---------|-------|
| Manual | `ManualWorkflowTrigger()` | Used for `makaio workflow run` without `--payload` |
| Cron | `CronWorkflowTrigger({ schedule: '0 9 * * 1' })` | Standard cron syntax |
| Webhook | `WebhookWorkflowTrigger({ event: 'push' })` | HTTP webhook events |
| Extension | `ExtensionWorkflowTrigger({ extensionType: 'ext:event' })` | Extension-emitted events |

---

## Station Context

Every station handler receives a `StepContext`:

```typescript
interface StepContext {
  readonly workflowId: string;
  readonly executionId: string;
  readonly signal: AbortSignal;

  readonly trigger: TTrigger;
  readonly inputs: Record<string, unknown>;
  readonly env: Record<string, string>;
  readonly repoPath: string;
  readonly makaioHome: string;
  readonly os: 'darwin' | 'linux' | 'win32';
  readonly arch: string;
  readonly worktree?: string;

  // Earlier node outputs keyed by node ID
  readonly previousSteps: TPreviousSteps;

  // Set inside `.iterate()` / `.iterateChain()`
  readonly item?: unknown;
  readonly index?: number;
  readonly previous?: JsonValue;

  // Present when `.artifact()` is declared and initialized
  readonly artifact?: ArtifactContext<TArtifactData>;
}
```

---

## Real-World Example: Worktree Bootstrap

This workflow copies `.env` files from the main worktree into secondary worktrees when a
checkout event arrives. It fires on `git.checkout`: creating a new worktree checks out its
branch, so the trigger payload's `repoPath` is the new worktree path.

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

workflow.station('resolve-worktrees', async (ctx) => {
  const { repoPath } = ctx.trigger as { repoPath: string };
  const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], { cwd: repoPath });
  const worktrees = stdout
    .split('\n\n')
    .map((block) => block.match(/^worktree (.+)$/m)?.[1])
    .filter((p): p is string => p !== undefined);

  const mainWorktree = worktrees[0];
  if (!mainWorktree || mainWorktree === repoPath) {
    return { mainWorktree: mainWorktree ?? repoPath, targetWorktree: repoPath, isNewWorktree: false };
  }
  return { mainWorktree, targetWorktree: repoPath, isNewWorktree: true };
});

workflow.station('copy-files', async (ctx) => {
  const resolved = ctx.previousSteps['resolve-worktrees'];
  if (resolved.status !== 'completed') return { copied: [], skipped: 'resolve step was skipped' };

  const { mainWorktree, targetWorktree, isNewWorktree } = resolved.output as {
    mainWorktree: string;
    targetWorktree: string;
    isNewWorktree: boolean;
  };
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
      // Source does not exist — skip silently
    }
  }
  return { copied };
});

export default workflow;
```

**Prerequisites:** Install native git hooks so checkout events reach the bus:

```bash
makaio git-hooks install
makaio git-hooks status
# -> { "covered": true, "coveredOperations": ["commit", "checkout"] }
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
  │                                     ├─ Gate: checkpoint + bus event
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
| `StationContext`, `ArtifactContext`, `WorkflowContext` | `framework/core/contracts/src/workflow/authoring-context.ts` |
| `defineWorkflowBundle` | `framework/core/contracts/src/workflow/bundle.ts` |
| `defineTransitionRule`, `TransitionEventType` | `framework/core/contracts/src/workflow/transition.ts` |
| WorkLog projection schemas | `framework/core/contracts/src/workflow/worklog.ts` |
| Bus namespace (`WorkflowSubjects`) | `framework/core/contracts/src/workflow/namespace.ts` |
| Workflow definition schemas | `framework/core/contracts/src/workflow/schemas.ts` |
| Workflow executor | `framework/subsystems/workflow-engine/src/workflow-executor.ts` |
| CLI run command | `framework/extensions/workflow/src/run-command.ts` |
| Git event schemas | `framework/services/core/src/git/schemas/event.ts` |
| Git hooks extension | `framework/extensions/git-hooks/` |
