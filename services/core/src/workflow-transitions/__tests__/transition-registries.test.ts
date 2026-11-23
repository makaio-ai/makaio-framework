import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import type {
  ArtifactRevision,
  TransitionActionFactory,
  TransitionEvaluationContext,
  TransitionRuleDefinition,
} from '@makaio/contracts';
import { WorkflowSubjects } from '@makaio/contracts';
import { createTestCall } from '@makaio/test-utils';
import { ZodError } from 'zod';
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
    slug: 'artifact-1',
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
      createTestCall(),
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
      createTestCall(),
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
  afterEach(() => {
    vi.restoreAllMocks();
  });

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
          when: { field: 'artifact.data.status', operator: 'ready' },
        }),
        makeRule({
          id: 'pkg-transition.invalid-condition',
          when: JSON.parse('{"unknown":"value"}'),
        }),
      ]),
    ).toThrow();
    expect(registry.snapshotSource('pkg-transition')).toBeUndefined();
    expect(registry.getRulesForEvent('artifact.created')).toEqual([]);
  });

  it('replaces a source atomically, reusing its own rule IDs', () => {
    const registry = new TransitionRuleRegistry();

    registry.register('pkg-transition', [makeRule(), makeRule({ id: 'pkg-transition.retired' })]);
    registry.replace('pkg-transition', [
      makeRule({ when: { field: 'artifact.data.status', operator: 'ready' } }),
      makeRule({ id: 'pkg-transition.added', on: 'artifact.revised' }),
    ]);

    expect(registry.snapshotSource('pkg-transition')).toEqual({
      ruleIds: ['pkg-transition.capture-created', 'pkg-transition.added'],
    });
    expect(registry.getRulesForEvent('artifact.created').map(({ rule }) => rule.when)).toEqual([
      { field: 'artifact.data.status', operator: 'ready' },
    ]);
    expect(registry.getRulesForEvent('artifact.revised').map(({ rule }) => rule.id)).toEqual(['pkg-transition.added']);
  });

  it('keeps the last good rules of a source when its replacement is rejected', () => {
    const registry = new TransitionRuleRegistry();

    registry.register('other-source', [makeRule({ id: 'other-source.owned' })]);
    registry.register('pkg-transition', [makeRule()]);

    expect(() =>
      registry.replace('pkg-transition', [
        makeRule({ id: 'pkg-transition.next', when: JSON.parse('{"unknown":"value"}') }),
      ]),
    ).toThrow(ZodError);
    expect(() => registry.replace('pkg-transition', [makeRule({ id: 'other-source.owned' })])).toThrow(
      "duplicate rule ID 'other-source.owned' from source 'pkg-transition'",
    );
    expect(registry.snapshotSource('pkg-transition')).toEqual({ ruleIds: ['pkg-transition.capture-created'] });
    expect(registry.getRulesForEvent('artifact.created').map(({ rule }) => rule.id)).toEqual([
      'other-source.owned',
      'pkg-transition.capture-created',
    ]);
  });

  it('validates a replacement without touching the registered rules', () => {
    const registry = new TransitionRuleRegistry();

    registry.register('other-source', [makeRule({ id: 'other-source.owned' })]);
    registry.register('pkg-transition', [makeRule()]);

    registry.validateReplacement('pkg-transition', [makeRule(), makeRule({ id: 'pkg-transition.added' })]);
    expect(() => registry.validateReplacement('pkg-transition', [makeRule({ id: 'other-source.owned' })])).toThrow(
      "duplicate rule ID 'other-source.owned' from source 'pkg-transition'",
    );
    expect(registry.snapshotSource('pkg-transition')).toEqual({ ruleIds: ['pkg-transition.capture-created'] });
    expect(registry.snapshotSource('other-source')).toEqual({ ruleIds: ['other-source.owned'] });
  });

  it('removes a source when replacing it with no rules', () => {
    const registry = new TransitionRuleRegistry();

    registry.register('pkg-transition', [makeRule()]);
    registry.replace('pkg-transition', []);

    expect(registry.snapshotSource('pkg-transition')).toBeUndefined();
    expect(registry.getRulesForEvent('artifact.created')).toEqual([]);
  });

  it('loads a rule with a plain condition without findings or warnings', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const registry = new TransitionRuleRegistry();

    registry.register('pkg-transition', [makeRule({ when: { field: 'artifact.data.status', operator: 'ready' } })]);

    expect(registry.getRulesForEvent('artifact.created').map(({ findings }) => findings)).toEqual([[]]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('loads a rule with a $expr condition, carries one expression-unchecked finding and warns with the rule ID', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const registry = new TransitionRuleRegistry();

    registry.register('pkg-transition', [makeRule({ when: { $expr: 'artifact.data.status == "ready"' } })]);

    const [prepared] = registry.getRulesForEvent('artifact.created');
    expect(prepared?.findings).toHaveLength(1);
    expect(prepared?.findings[0]).toMatchObject({ severity: 'warning', code: 'expression-unchecked', path: '$expr' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('pkg-transition.capture-created');
    expect(String(warn.mock.calls[0]?.[0])).toContain('expression-unchecked');
  });

  it('rejects a rule whose $expr does not parse', () => {
    const registry = new TransitionRuleRegistry();

    expect(() => registry.register('pkg-transition', [makeRule({ when: { $expr: '(' } })])).toThrow(
      /invalid condition in rule 'pkg-transition.capture-created': expression-syntax at '\$expr'/,
    );
    expect(registry.snapshotSource('pkg-transition')).toBeUndefined();
  });

  it('rejects a rule whose field sits under an unknown root', () => {
    const registry = new TransitionRuleRegistry();

    expect(() =>
      registry.register('pkg-transition', [makeRule({ when: { field: 'data.status', operator: 'ready' } })]),
    ).toThrow(/invalid condition in rule 'pkg-transition.capture-created': unknown-root at '/);
    expect(registry.getRulesForEvent('artifact.created')).toEqual([]);
  });

  it('loads a rule reading _transition fields', () => {
    const registry = new TransitionRuleRegistry();

    registry.register('pkg-transition', [makeRule({ when: { field: '_transition.depth', operator: { $lt: 3 } } })]);

    expect(registry.getRulesForEvent('artifact.created')).toHaveLength(1);
  });

  it('rejects a negation on a key that is not always present, and loads it behind an $exists guard', () => {
    const registry = new TransitionRuleRegistry();
    const revised = { on: 'artifact.revised' } as const;

    expect(() =>
      registry.register('pkg-transition', [
        makeRule({ ...revised, when: { field: 'previousArtifact.slug', operator: { $ne: 'draft' } } }),
      ]),
    ).toThrow(/invalid condition in rule 'pkg-transition.capture-created': unguarded-negation at '/);

    registry.register('pkg-transition', [
      makeRule({
        ...revised,
        when: {
          $and: [
            { field: 'previousArtifact.slug', operator: { $exists: true } },
            { field: 'previousArtifact.slug', operator: { $ne: 'draft' } },
          ],
        },
      }),
    ]);
    expect(registry.getRulesForEvent('artifact.revised')).toHaveLength(1);
  });

  it('accepts a guard on an optional ancestor when the nested field is required, and rejects it when the nested field is optional', () => {
    const registry = new TransitionRuleRegistry();
    const revised = { on: 'artifact.revised' } as const;

    registry.register('pkg-transition', [
      makeRule({
        ...revised,
        when: {
          $and: [
            { field: 'previousArtifact', operator: { $exists: true } },
            { field: 'previousArtifact.kind', operator: { $ne: 'x' } },
          ],
        },
      }),
    ]);
    expect(registry.getRulesForEvent('artifact.revised')).toHaveLength(1);

    expect(() =>
      new TransitionRuleRegistry().register('pkg-transition', [
        makeRule({
          ...revised,
          when: {
            $and: [
              { field: 'previousArtifact', operator: { $exists: true } },
              { field: 'previousArtifact.createdAt', operator: { $ne: 5 } },
            ],
          },
        }),
      ]),
    ).toThrow(/unguarded-negation at '/);
  });

  it('rejects a typo of a top-level artifact field and accepts any field under artifact.data', () => {
    const registry = new TransitionRuleRegistry();

    expect(() =>
      registry.register('pkg-transition', [makeRule({ when: { field: 'artifact.knd', operator: 'plan' } })]),
    ).toThrow(/invalid condition in rule 'pkg-transition.capture-created': unknown-path at '/);

    registry.register('pkg-transition', [
      makeRule({ when: { field: 'artifact.data.anything.nested', operator: 'x' } }),
    ]);
    expect(registry.getRulesForEvent('artifact.created')).toHaveLength(1);
  });

  it.each([
    'current',
    'previous',
  ] as const)('rejects an unguarded negation on %s of a status-changed rule, and loads it behind an $exists guard', (field) => {
    const registry = new TransitionRuleRegistry();
    const changed = { on: 'artifact.status.changed' } as const;

    expect(() =>
      registry.register('pkg-transition', [makeRule({ ...changed, when: { field, operator: { $ne: 'draft' } } })]),
    ).toThrow(/invalid condition in rule 'pkg-transition.capture-created': unguarded-negation at '/);

    registry.register('pkg-transition', [
      makeRule({
        ...changed,
        when: {
          $and: [
            { field, operator: { $exists: true } },
            { field, operator: { $ne: 'draft' } },
          ],
        },
      }),
    ]);
    expect(registry.getRulesForEvent('artifact.status.changed')).toHaveLength(1);
  });

  it('loads { $exists: false } on previous and a positive match on current of a status-changed rule', () => {
    const registry = new TransitionRuleRegistry();

    registry.register('pkg-transition', [
      makeRule({ on: 'artifact.status.changed', when: { field: 'previous', operator: { $exists: false } } }),
    ]);
    registry.register('pkg-other', [
      makeRule({
        id: 'pkg-other.approved',
        on: 'artifact.status.changed',
        when: { field: 'current', operator: 'approved' },
      }),
    ]);
    expect(registry.getRulesForEvent('artifact.status.changed')).toHaveLength(2);
  });

  it('rejects status-changed fields on a created rule', () => {
    const registry = new TransitionRuleRegistry();

    expect(() =>
      registry.register('pkg-other', [
        makeRule({ id: 'pkg-other.created', when: { field: 'current', operator: { $ne: 'draft' } } }),
      ]),
    ).toThrow(/invalid condition in rule 'pkg-other.created': unknown-root at '/);
  });

  it('checks _transition.eventType as a string, not against its enum values', () => {
    const registry = new TransitionRuleRegistry();

    expect(() =>
      registry.register('pkg-transition', [makeRule({ when: { field: '_transition.eventType', operator: 3 } })]),
    ).toThrow(/type-mismatch/);

    // The check compares operand types with field types only; a wrong enum literal passes.
    registry.register('pkg-transition', [
      makeRule({ when: { field: '_transition.eventType', operator: 'artifact.craeted' } }),
    ]);
    expect(registry.getRulesForEvent('artifact.created')).toHaveLength(1);
  });

  it('logs condition warnings once per replace and not in validateReplacement', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const registry = new TransitionRuleRegistry();
    const rules = [makeRule({ when: { $expr: 'artifact.data.status == "ready"' } })];

    registry.validateReplacement('pkg-transition', rules);
    expect(warn).not.toHaveBeenCalled();

    registry.replace('pkg-transition', rules);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
