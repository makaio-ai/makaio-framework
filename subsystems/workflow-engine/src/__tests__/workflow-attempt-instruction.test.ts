import { describe, expect, it } from 'vitest';
import {
  WorkflowRunContextSchema,
  WorkflowWorkerConfigSchema,
  type WorkflowRunContext,
  type WorkflowWorkerConfig,
} from '@makaio/contracts';
import {
  buildWorkflowAttemptInstruction,
  parseWorkflowAttemptInstruction,
  WorkflowInvocationInputSchema,
} from '../workflow-attempt-instruction.js';

function config(overrides: Partial<WorkflowWorkerConfig> = {}): WorkflowWorkerConfig {
  return WorkflowWorkerConfigSchema.parse({
    executionId: 'execution-1',
    workflowId: 'workflow-1',
    source: { kind: 'source', filename: 'workflow.ts', source: 'export default workflow;' },
    coordinatorSessionId: 'session-1',
    cancelSubject: 'workflow.execution-1.cancel',
    ...overrides,
  });
}

function context(overrides: Partial<WorkflowRunContext> = {}): WorkflowRunContext {
  return WorkflowRunContextSchema.parse({
    ...config(),
    createdAt: 123,
    ...overrides,
  });
}

function build(workerConfig = config(), runContext?: WorkflowRunContext) {
  return buildWorkflowAttemptInstruction({
    id: 'instruction-1',
    revision: 'revision-1',
    config: workerConfig,
    ...(runContext !== undefined ? { runContext } : {}),
    preservation: { required: [] },
  });
}

describe('workflow Attempt instruction', () => {
  it('freezes a self-contained workflow without requiring a project Workspace', () => {
    const instruction = build();
    expect(instruction.workspace).toBeUndefined();
    expect(instruction.workload).toMatchObject({ kind: 'workflow', version: '1' });
    expect(parseWorkflowAttemptInstruction(instruction)).toMatchObject({
      executionId: 'execution-1',
      source: { kind: 'source', filename: 'workflow.ts' },
      terminalAuthority: 'authority',
    });
  });

  it('selects immutable workload semantics without transport, environment, or runtime selection', () => {
    const workerConfig = config({
      busAuth: { kind: 'hmac', secret: 'test-only-transport-value' },
      busUrl: 'ws://test-only.invalid',
      env: { TEST_PRIVATE_VALUE: 'test-only-environment-value' },
      terminalAuthority: 'worker',
    });
    const runContext = context({
      env: { TEST_PRIVATE_VALUE: 'test-only-context-value' },
      suspensionStrategy: 'exit-and-redispatch',
      dispatchMetadata: { resume: true, providerId: 'provider-1' },
      inputs: { repository: 'repo-1' },
      config: { testCommand: 'yarn test' },
      triggerPayload: { decision: 'continue' },
      triggerMode: 'await-trigger',
    });
    const instruction = build(workerConfig, runContext);
    const input = parseWorkflowAttemptInstruction(instruction);
    expect(input).toMatchObject({
      inputs: { repository: 'repo-1' },
      config: { testCommand: 'yarn test' },
      triggerPayload: { decision: 'continue' },
      triggerMode: 'await-trigger',
      coordinatorSessionId: 'session-1',
      cancelSubject: 'workflow.execution-1.cancel',
      terminalAuthority: 'authority',
    });
    for (const excluded of [
      'busAuth',
      'busUrl',
      'env',
      'workerManifest',
      'suspensionStrategy',
      'createdAt',
      'dispatchMetadata',
    ]) {
      expect(input).not.toHaveProperty(excluded);
    }
    expect(JSON.stringify(instruction)).not.toContain('test-only-');
    if (typeof runContext.inputs === 'object' && runContext.inputs !== null && 'repository' in runContext.inputs) {
      runContext.inputs.repository = 'mutated';
    }
    if (runContext.config !== undefined) runContext.config['testCommand'] = 'mutated';
    expect(parseWorkflowAttemptInstruction(instruction).inputs).toEqual({ repository: 'repo-1' });
    expect(parseWorkflowAttemptInstruction(instruction).config).toEqual({ testCommand: 'yarn test' });
  });

  it('retains the frozen definition used by a definition-backed invocation', () => {
    const definition = {
      id: 'workflow-1',
      name: 'Test workflow',
      root: { type: 'sequence' as const, id: 'root', nodes: [] },
      scope: { type: 'global' as const },
    };
    const instruction = build(config({ source: { kind: 'definition', workflowId: 'workflow-1' }, definition }));
    expect(parseWorkflowAttemptInstruction(instruction).definitionSnapshot).toMatchObject(definition);
    definition.name = 'Changed after dispatch';
    expect(parseWorkflowAttemptInstruction(instruction).definitionSnapshot?.name).toBe('Test workflow');
  });

  it('requires a portable run context for a path-backed workflow', () => {
    const workerConfig = config({ source: { kind: 'path', path: '/host/repo/workflow.ts' } });
    expect(() => build(workerConfig)).toThrow('portable run context');
    const instruction = build(
      workerConfig,
      context({
        source: { kind: 'path', path: 'workflows/implementation.ts' },
        materializationSpec: {
          kind: 'local-directory',
          workspaceId: 'executable-1',
          rootDigest: 'revision-1',
          sourcePath: 'workflows/implementation.ts',
        },
      }),
    );
    expect(parseWorkflowAttemptInstruction(instruction).source).toEqual({
      kind: 'path',
      path: 'workflows/implementation.ts',
    });
    expect(instruction.workspace).toBeUndefined();
    expect(JSON.stringify(instruction)).not.toContain('/host/repo');
  });

  it('normalizes absent optional definition fields after validating the typed workflow', () => {
    const definition = {
      id: 'workflow-1',
      inputSchema: undefined,
      configSchema: undefined,
      executableSource: undefined,
      successFinalizerId: undefined,
      root: { type: 'sequence' as const, id: 'root', nodes: [], name: undefined },
      scope: { type: 'global' as const },
    };
    const instruction = build(config({ source: { kind: 'definition', workflowId: 'workflow-1' }, definition }));
    const snapshot = parseWorkflowAttemptInstruction(instruction).definitionSnapshot;
    expect(snapshot).toEqual({
      id: 'workflow-1',
      root: { type: 'sequence', id: 'root', nodes: [] },
      scope: { type: 'global' },
    });
    expect(snapshot).not.toHaveProperty('inputSchema');
    expect(snapshot?.root).not.toHaveProperty('name');
  });

  it.each([
    undefined,
    () => 'runtime-only',
    NaN,
    Infinity,
  ])('rejects non-JSON opaque input before optional-field normalization: %s', (invalid) => {
    expect(() => build({ ...config(), inputs: { invalid } })).toThrow();
    expect(() => build({ ...config(), config: { invalid } })).toThrow();
    expect(() =>
      build({
        ...config(),
        source: { kind: 'definition', workflowId: 'workflow-1' },
        definition: {
          id: 'workflow-1',
          root: { type: 'sequence', id: 'root', nodes: [] },
          scope: { type: 'global' },
          inputSchema: { nested: { invalid } },
        },
      }),
    ).toThrow();
  });

  it('keeps an explicit project Workspace independent of executable source', () => {
    const instruction = buildWorkflowAttemptInstruction({
      id: 'instruction-1',
      revision: 'revision-1',
      config: config(),
      workspace: {
        provisioning: 'bind',
        custody: 'external',
        sourceRoots: [{ id: 'target', path: 'target' }],
        setup: [],
      },
      preservation: { required: ['source-state', 'diagnostics'] },
    });
    expect(instruction.workspace?.sourceRoots).toEqual([{ id: 'target', path: 'target' }]);
    expect(instruction.preservation.required).toEqual(['source-state', 'diagnostics']);
    expect(parseWorkflowAttemptInstruction(instruction).source.kind).toBe('source');
  });

  it('rejects owner identity mismatches instead of borrowing another execution context', () => {
    expect(() => build(config(), context({ executionId: 'another-execution' }))).toThrow('dispatched execution');
    expect(() => build(config(), context({ workflowId: 'another-workflow' }))).toThrow('dispatched execution');
  });

  it('rejects unknown adapter versions and executable path traversal', () => {
    const instruction = build();
    expect(() =>
      parseWorkflowAttemptInstruction({ ...instruction, workload: { ...instruction.workload, version: '2' } }),
    ).toThrow('supported workflow');
    expect(() =>
      parseWorkflowAttemptInstruction({ ...instruction, workload: { ...instruction.workload, kind: 'other' } }),
    ).toThrow('supported workflow');
    const input = parseWorkflowAttemptInstruction(instruction);
    for (const path of [
      '../workflow.ts',
      'nested/../../workflow.ts',
      'C:workflow.ts',
      '\\host\\workflow.ts',
      '/tmp/workflow.ts',
      '/',
      '//host/workflow.ts',
    ]) {
      expect(
        WorkflowInvocationInputSchema.safeParse({
          ...input,
          source: { kind: 'path', path },
          materializationSpec: {
            kind: 'local-directory',
            workspaceId: 'executable-1',
            rootDigest: 'revision-1',
            sourcePath: path,
          },
        }).success,
      ).toBe(false);
    }
  });

  it.each([
    '/tmp/workflow.ts',
    '/',
    '//host/workflow.ts',
  ])('rejects absolute source %s independently of materialization validation', (path) => {
    const parsed = WorkflowInvocationInputSchema.shape.source.safeParse({ kind: 'path', path });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toEqual(expect.arrayContaining([expect.objectContaining({ path: ['path'] })]));
    }
  });

  it('retains the existing definition and materialization consistency rules', () => {
    const input = parseWorkflowAttemptInstruction(build());
    expect(
      WorkflowInvocationInputSchema.safeParse({ ...input, source: { kind: 'definition', workflowId: 'workflow-1' } })
        .success,
    ).toBe(false);
    expect(
      WorkflowInvocationInputSchema.safeParse({ ...input, source: { kind: 'path', path: 'workflow.ts' } }).success,
    ).toBe(false);
    expect(
      WorkflowInvocationInputSchema.safeParse({
        ...input,
        source: { kind: 'path', path: 'workflow.ts' },
        materializationSpec: {
          kind: 'local-directory',
          workspaceId: 'executable-1',
          rootDigest: 'revision-1',
          sourcePath: 'other.ts',
        },
      }).success,
    ).toBe(false);
  });

  it('rejects runtime fields in the frozen adapter payload instead of silently consuming them', () => {
    const input = parseWorkflowAttemptInstruction(build());
    expect(WorkflowInvocationInputSchema.safeParse({ ...input, env: { TEST_VALUE: 'unexpected' } }).success).toBe(
      false,
    );
    expect(
      WorkflowInvocationInputSchema.safeParse({ ...input, suspensionStrategy: 'exit-and-redispatch' }).success,
    ).toBe(false);
    expect(WorkflowInvocationInputSchema.safeParse({ ...input, terminalAuthority: 'worker' }).success).toBe(false);
  });
});
