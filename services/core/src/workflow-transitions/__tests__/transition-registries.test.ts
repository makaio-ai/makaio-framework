import { describe, expect, it } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import type {
  ArtifactRevision,
  TransitionActionFactory,
  TransitionEvaluationContext,
  TransitionRuleDefinition,
} from '@makaio/contracts';
import { WorkflowSubjects } from '@makaio/contracts';
import { TransitionActionRegistry, WORKFLOW_START_ACTION_TYPE } from '../transition-action-registry.js';
import { TransitionRuleRegistry } from '../transition-rule-registry.js';

const captureActionFactory: TransitionActionFactory = () => ({
  async execute() {
    return undefined;
  },
});

function makeRule(overrides: Partial<TransitionRuleDefinition> = {}): TransitionRuleDefinition {
  return {
    id: 'pkg-transition.capture-created',
    on: 'artifact.created',
    action: { type: 'pkg-transition.capture' },
    enabled: true,
    ...overrides,
  };
}

function makeArtifact(overrides: Partial<ArtifactRevision> = {}): ArtifactRevision {
  return {
    kind: 'implementation-plan',
    id: 'artifact-1',
    revision: 'rev-1',
    schemaVersion: 1,
    scope: { level: 'global' },
    data: { status: 'draft' },
    relations: [],
    actor: { kind: 'agent', id: 'agent-1' },
    timestamp: 1000,
    ...overrides,
  };
}

describe('TransitionActionRegistry', () => {
  it('forwards workflow start action fields to the workflow start subject', async () => {
    const bus = createBusInstance();
    const registry = new TransitionActionRegistry(bus);
    const artifactRef = { kind: 'implementation-plan', id: 'artifact-1' };
    const scope = { type: 'session' as const, id: 'session-1' };
    const captured = new Promise<unknown>((resolve) => {
      bus.on(WorkflowSubjects.start, (ctx) => {
        resolve(ctx.payload);
        ctx.setResult({ executionId: 'wfx-transition-start' });
      });
    });
    const context = {
      artifact: makeArtifact(),
      _transition: {
        ruleId: 'pkg-transition.start',
        eventType: 'artifact.status.changed',
        depth: 2,
      },
    } satisfies TransitionEvaluationContext;

    await registry.dispatch(
      {
        type: WORKFLOW_START_ACTION_TYPE,
        input: {
          workflowId: 'implementation',
          input: { planId: 'artifact-1' },
          config: { mode: 'fast' },
          artifactRef,
          scope,
        },
      },
      context,
    );

    await expect(captured).resolves.toMatchObject({
      workflowId: 'implementation',
      input: { planId: 'artifact-1' },
      config: { mode: 'fast' },
      artifactRef,
      scope,
      triggerPayload: {
        _transitionRuleId: 'pkg-transition.start',
        _transitionDepth: 2,
        _transitionEventType: 'artifact.status.changed',
      },
    });
  });

  it('evaluates workflow start inputExpression against the transition context', async () => {
    const bus = createBusInstance();
    const registry = new TransitionActionRegistry(bus);
    const captured = new Promise<unknown>((resolve) => {
      bus.on(WorkflowSubjects.start, (ctx) => {
        resolve(ctx.payload);
        ctx.setResult({ executionId: 'wfx-transition-expression' });
      });
    });
    const context = {
      artifact: makeArtifact({
        id: 'plan-1',
        scope: { level: 'project', ids: { projectId: 'workflow-api' } },
        data: { branch: 'workflow-api' },
      }),
      _transition: {
        ruleId: 'pkg-transition.start-from-expression',
        eventType: 'artifact.status.changed',
        depth: 1,
      },
    } satisfies TransitionEvaluationContext;

    await registry.dispatch(
      {
        type: WORKFLOW_START_ACTION_TYPE,
        input: {
          workflowId: 'implementation',
          inputExpression:
            '{ planArtifactId: artifact.id, repository: artifact.scope.ids.projectId, branch: ctx.artifact.data.branch }',
        },
      },
      context,
    );

    await expect(captured).resolves.toMatchObject({
      workflowId: 'implementation',
      input: {
        planArtifactId: 'plan-1',
        repository: 'workflow-api',
        branch: 'workflow-api',
      },
    });
  });

  it('rejects duplicate non-empty source registration', () => {
    const registry = new TransitionActionRegistry(createBusInstance());

    registry.register('pkg-transition', {
      'pkg-transition.capture': captureActionFactory,
    });

    expect(() =>
      registry.register('pkg-transition', {
        'pkg-transition.notify': captureActionFactory,
      }),
    ).toThrow("duplicate source 'pkg-transition'");
    expect(registry.has('pkg-transition.capture')).toBe(true);
    expect(registry.has('pkg-transition.notify')).toBe(false);
  });

  it('keeps empty source registration as a no-op', () => {
    const registry = new TransitionActionRegistry(createBusInstance());

    registry.register('pkg-transition', {
      'pkg-transition.capture': captureActionFactory,
    });
    registry.register('pkg-transition', {});

    expect(registry.has('pkg-transition.capture')).toBe(true);
  });
});

describe('TransitionRuleRegistry', () => {
  it('treats omitted rule enabled as active and filters explicit disabled rules', () => {
    const registry = new TransitionRuleRegistry();

    registry.register('pkg-transition', [
      {
        id: 'pkg-transition.default-enabled',
        on: 'artifact.created',
        action: { type: 'pkg-transition.capture' },
      },
      makeRule({
        id: 'pkg-transition.disabled',
        enabled: false,
      }),
    ]);

    const rules = registry.getRulesForEvent('artifact.created');
    expect(rules).toHaveLength(1);

    const [preparedRule] = rules;
    expect(preparedRule?.rule).toMatchObject({
      id: 'pkg-transition.default-enabled',
      enabled: true,
    });
  });

  it('rejects duplicate non-empty source registration', () => {
    const registry = new TransitionRuleRegistry();

    registry.register('pkg-transition', [makeRule()]);

    expect(() =>
      registry.register('pkg-transition', [
        makeRule({
          id: 'pkg-transition.notify-created',
          action: { type: 'pkg-transition.notify' },
        }),
      ]),
    ).toThrow("duplicate source 'pkg-transition'");
    expect(registry.snapshotSource('pkg-transition')).toEqual({
      ruleIds: ['pkg-transition.capture-created'],
    });
    expect(registry.getRulesForEvent('artifact.created').map(({ rule }) => rule.id)).toEqual([
      'pkg-transition.capture-created',
    ]);
  });

  it('detects duplicate rule IDs inside the incoming batch', () => {
    const registry = new TransitionRuleRegistry();

    expect(() =>
      registry.register('pkg-transition', [
        makeRule(),
        makeRule({
          action: { type: 'pkg-transition.notify' },
        }),
      ]),
    ).toThrow("duplicate rule ID 'pkg-transition.capture-created'");
    expect(registry.snapshotSource('pkg-transition')).toBeUndefined();
    expect(registry.getRulesForEvent('artifact.created')).toEqual([]);
  });

  it('validates all rule conditions before mutating registry state', () => {
    const registry = new TransitionRuleRegistry();

    expect(() =>
      registry.register('pkg-transition', [
        makeRule({
          when: { field: 'data.status', operator: 'ready' },
        }),
        makeRule({
          id: 'pkg-transition.invalid-condition',
          when: { unknown: 'value' },
        }),
      ]),
    ).toThrow();
    expect(registry.snapshotSource('pkg-transition')).toBeUndefined();
    expect(registry.getRulesForEvent('artifact.created')).toEqual([]);
  });
});
