import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  StoredWorkflowRunContextSchema,
  WorkflowRunContextSchema,
  requireExecutableRunContext,
  type StoredWorkflowRunContext,
  type WorkflowRunContext,
} from '../run-context.js';
import type { WorkflowDefinition } from '../schemas.js';
import type { WorkerMaterializationSpec } from '../../capabilities/worker/types.js';

type RunContextInvariantCase = {
  readonly name: string;
  readonly overrides: Partial<z.input<typeof WorkflowRunContextSchema>>;
  readonly issuePath: readonly string[];
};

type InvalidSnapshotCase = {
  readonly name: string;
  readonly snapshot: NonNullable<StoredWorkflowRunContext['definitionSnapshot']>;
  readonly issuePattern: RegExp;
};

type RunContextSchemaCase = {
  readonly name: string;
  readonly schema: typeof StoredWorkflowRunContextSchema | typeof WorkflowRunContextSchema;
};

const schemaCases: readonly RunContextSchemaCase[] = [
  { name: 'stored', schema: StoredWorkflowRunContextSchema },
  { name: 'executable', schema: WorkflowRunContextSchema },
];

const definition: WorkflowDefinition = {
  id: 'workflow-1',
  scope: { type: 'global' },
  root: { id: 'root', type: 'sequence', nodes: [{ id: 'compute', type: 'code-step' }] },
};

const context: WorkflowRunContext = {
  executionId: 'execution-1',
  workflowId: definition.id,
  source: { kind: 'definition', workflowId: definition.id },
  definitionSnapshot: definition,
  workerManifest: { contributionRefs: [] },
  inputs: {},
  scope: { type: 'global' },
  triggerPayload: {},
  coordinatorSessionId: 'coordinator-1',
  cancelSubject: 'workflow.cancel.execution-1',
  env: {},
  createdAt: 1,
};

const materializationSpec: WorkerMaterializationSpec = {
  kind: 'local-directory',
  workspaceId: 'workspace-1',
  rootDigest: 'digest-1',
  sourcePath: 'workflows/example.ts',
};

const invalidSnapshots: readonly InvalidSnapshotCase[] = [
  {
    name: 'a legacy delegate snapshot',
    snapshot: {
      ...definition,
      root: {
        ...definition.root,
        nodes: [{ id: 'delegate', type: 'delegate-agent', agentId: 'agent-1', prompt: 'Do the work' }], // legacy-input
      },
    },
    issuePattern: /definitionSnapshot/,
  },
  {
    name: 'a legacy Gate snapshot',
    snapshot: {
      ...definition,
      root: {
        ...definition.root,
        nodes: [
          {
            id: 'approval',
            type: 'gate', // legacy-input
            prompt: 'Approve the run',
            autoAction: 'reject',
            timeoutMs: null,
          },
        ],
      },
    },
    issuePattern: /definitionSnapshot\.root\.nodes\.0\.type/,
  },
  {
    name: 'a legacy canvas layout snapshot',
    snapshot: { ...definition, canvasLayout: { compute: { x: 1, y: 2 } } }, // legacy-input
    issuePattern: /definitionSnapshot: .*canvasLayout/,
  },
  { name: 'undecodable snapshot text', snapshot: '{', issuePattern: /definitionSnapshot/ },
];

const invariantCases: readonly RunContextInvariantCase[] = [
  {
    name: 'a definition source without a snapshot',
    overrides: { definitionSnapshot: undefined },
    issuePath: ['definitionSnapshot'],
  },
  {
    name: 'a path source without a materialization spec',
    overrides: { source: { kind: 'path', path: materializationSpec.sourcePath } },
    issuePath: ['materializationSpec'],
  },
  {
    name: 'a path source with a mismatched materialization source path',
    overrides: { source: { kind: 'path', path: 'workflows/other.ts' }, materializationSpec },
    issuePath: ['materializationSpec', 'sourcePath'],
  },
  {
    name: 'a definition source with a materialization spec',
    overrides: { materializationSpec },
    issuePath: ['materializationSpec'],
  },
  {
    name: 'an inline source with a materialization spec',
    overrides: {
      source: { kind: 'source', filename: 'example.ts', source: 'export default {};' },
      materializationSpec,
    },
    issuePath: ['materializationSpec'],
  },
];

describe('stored and executable workflow run contexts', () => {
  it.each(invalidSnapshots)('keeps $name readable but rejects execution', ({ snapshot }) => {
    const candidate = { ...context, definitionSnapshot: snapshot };

    expect(StoredWorkflowRunContextSchema.parse(candidate)).toEqual(candidate);
    expect(WorkflowRunContextSchema.safeParse(candidate).success).toBe(false);
  });

  it.each(invalidSnapshots)('requires an executable snapshot for $name', ({ snapshot, issuePattern }) => {
    const stored = StoredWorkflowRunContextSchema.parse({ ...context, definitionSnapshot: snapshot });

    expect(() => requireExecutableRunContext(stored)).toThrowError(
      expect.objectContaining({
        code: 'WORKFLOW_DEFINITION_INVALID',
        message: expect.stringContaining(stored.executionId),
      }),
    );
    expect(() => requireExecutableRunContext(stored)).toThrowError(issuePattern);
  });

  it('returns a valid executable context unchanged', () => {
    const stored = StoredWorkflowRunContextSchema.parse(context);

    expect(requireExecutableRunContext(stored)).toEqual(context);
    expect(stored).toEqual(context);
  });
});

describe.each(schemaCases)('$name run-context invariants', ({ schema }) => {
  it('accepts a definition source with its snapshot', () => {
    expect(schema.parse(context)).toEqual(context);
  });

  it('strips retired dispatch fields', () => {
    const candidate = {
      ...context,
      suspensionStrategy: 'exit-and-redispatch', // legacy-input
      dispatchMetadata: { target: 'worker-1' }, // legacy-input
    };

    expect(schema.parse(candidate)).toEqual(context);
  });

  it('accepts a path source with a matching materialization spec', () => {
    const candidate = {
      ...context,
      source: { kind: 'path', path: materializationSpec.sourcePath },
      definitionSnapshot: undefined,
      materializationSpec,
    };

    expect(schema.parse(candidate)).toEqual(candidate);
  });

  it('accepts an inline source without a materialization spec or snapshot', () => {
    const candidate = {
      ...context,
      source: { kind: 'source', filename: 'example.ts', source: 'export default {};' },
      definitionSnapshot: undefined,
    };

    expect(schema.parse(candidate)).toEqual(candidate);
  });

  it.each(invariantCases)('rejects $name', ({ overrides, issuePath }) => {
    const result = schema.safeParse({ ...context, ...overrides });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(expect.arrayContaining([expect.objectContaining({ path: issuePath })]));
    }
  });
});
