import { describe, expect, it } from 'vitest';
import {
  WorkflowFinalizationClaimSchema,
  WorkflowFinalizationIntentSchema,
  WorkflowDelegateResultFinalizationRequestSchema,
  createWorkflowDelegateResultFinalizerNamespace,
  createWorkflowFinalizerNamespace,
} from '../finalization.js';

describe('workflow finalization contracts', () => {
  it('creates an isolated namespace keyed by finalizer ID', () => {
    const result = createWorkflowFinalizerNamespace('audit.lifecycle');

    expect(result.namespaceDomain).toBe('workflow-finalizer:audit.lifecycle');
    expect(result.subjects.finalize.subject).toBe('finalize');
  });

  it('validates durable claims and intended terminal state', () => {
    const intent = WorkflowFinalizationIntentSchema.parse({ status: 'completed', completedAt: 42 });

    expect(
      WorkflowFinalizationClaimSchema.parse({
        executionId: 'exec-1',
        workflowId: 'workflow-1',
        finalizerId: 'audit.lifecycle',
        transitionKey: 'exec-1:terminal',
        claimToken: 'claim-1',
        intent,
        claimedAt: 40,
      }),
    ).toEqual(expect.objectContaining({ transitionKey: 'exec-1:terminal', intent }));
  });

  it('rejects invalid dynamic finalizer IDs', () => {
    expect(() => createWorkflowFinalizerNamespace('Audit Lifecycle')).toThrow('Invalid workflow finalizer ID');
  });

  it('defines a serializable authority request for delegate result finalization', () => {
    const finalizer = createWorkflowDelegateResultFinalizerNamespace('artifact.read-wrap');
    const request = WorkflowDelegateResultFinalizationRequestSchema.parse({
      executionId: 'exec-1',
      workflowId: 'workflow-1',
      frameId: 'frame-1',
      nodeId: 'read-artifact',
      nodeType: 'delegate-role',
      rawResult: { summary: 'Read complete' },
      toolObservations: [
        {
          toolName: 'artifacts_get',
          outcome: 'success',
          artifact: { kind: 'solution-design', id: 'design-1', revision: '3' },
        },
      ],
      economics: {
        durationMs: 12,
        inputTokens: 3,
        outputTokens: 2,
        binding: {
          adapterName: 'codex-app-server',
          providerConfigId: 'codex-subscription',
          providerDefinitionId: 'openai-codex',
          model: 'gpt-5.4',
          auth: { mode: 'inferred', owner: 'client', methodId: 'native-account' },
        },
      },
    });

    expect(finalizer.namespaceDomain).toBe('workflow-delegate-finalizer:artifact.read-wrap');
    expect(request.toolObservations[0]?.artifact).toEqual({ kind: 'solution-design', id: 'design-1', revision: '3' });
    expect(request.economics?.binding.providerConfigId).toBe('codex-subscription');
    expect(
      WorkflowDelegateResultFinalizationRequestSchema.safeParse({
        ...request,
        economics: { ...request.economics, credential: 'forbidden' },
      }).success,
    ).toBe(false);
    expect(
      WorkflowDelegateResultFinalizationRequestSchema.safeParse({
        ...request,
        toolObservations: [
          {
            toolName: 'artifacts_get',
            outcome: 'failure',
            artifact: { kind: 'solution-design', id: 'design-1', revision: '3' },
          },
        ],
      }).success,
    ).toBe(false);
  });
});
