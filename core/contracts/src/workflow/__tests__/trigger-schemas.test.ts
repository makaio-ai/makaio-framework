import { describe, expect, it } from 'vitest';
import { WorkflowAutomationTriggerBindingSchema, WorkflowDefinitionSchema } from '../schemas.js';
import type { WorkflowAutomationTriggerBinding } from '../schemas.js';
import { BusEventWorkflowTrigger } from '../authoring-triggers.js';
import { createBusNamespace } from '@makaio/core';
import { z } from 'zod';

const GitNamespace = createBusNamespace('git', {
  checkout: z.object({ isNewWorktree: z.boolean(), worktreePath: z.string() }),
});

/**
 * Legacy discriminated-union trigger shapes that predate automation trigger
 * bindings. They must fail parsing so no persisted workflow can silently keep
 * a pre-migration trigger.
 */
const legacyTriggerShapes = [
  { type: 'manual' },
  { type: 'webhook', event: 'push' },
  { type: 'extension', extensionType: 'github:pr.opened', config: {} },
  { type: 'bus-event', subject: 'github.issues.opened' },
  { type: 'cron', schedule: '0 * * * *' },
] as const;

describe('WorkflowAutomationTriggerBindingSchema', () => {
  it('accepts a binding without consumer-owned filter fields', () => {
    const result = WorkflowAutomationTriggerBindingSchema.safeParse({
      kind: 'makaio.bus-event',
      params: { subject: 'git.checkout' },
    });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ kind: 'makaio.bus-event', params: { subject: 'git.checkout' } });
  });

  it('accepts consumer-owned filter and filterExpression fields', () => {
    const result = WorkflowAutomationTriggerBindingSchema.safeParse({
      kind: 'makaio.bus-event',
      params: { subject: 'git.checkout' },
      filter: { isNewWorktree: true, worktreePath: { $startsWith: '/repos/' } },
      filterExpression: "payload.worktreePath == '/repos/makaio'",
    });

    expect(result.success).toBe(true);
    expect(result.data?.filter).toEqual({
      isNewWorktree: true,
      worktreePath: { $startsWith: '/repos/' },
    });
    expect(result.data?.filterExpression).toBe("payload.worktreePath == '/repos/makaio'");
  });

  it('exposes a parse output that satisfies the declared binding interface', () => {
    const parsed = WorkflowAutomationTriggerBindingSchema.parse({
      kind: 'makaio.cron',
      params: { schedule: '0 9 * * 1', timezone: 'UTC' },
    });

    // Compile-time check: the inferred parse output is the declared contract.
    const binding: WorkflowAutomationTriggerBinding = parsed;

    expect(binding.kind).toBe('makaio.cron');
  });

  it('strips the compile-time-only phantom payload carrier', () => {
    const authored = BusEventWorkflowTrigger({ subject: GitNamespace.subjects.checkout });
    const parsed = WorkflowAutomationTriggerBindingSchema.parse({
      ...authored,
      __payload: { isNewWorktree: true, worktreePath: '/repos/makaio' },
    });

    expect(parsed).not.toHaveProperty('__payload');
    expect(parsed).toEqual({ kind: 'makaio.bus-event', params: { subject: 'git.checkout' } });
  });

  it.each(legacyTriggerShapes)('rejects the legacy trigger shape %o', (legacy) => {
    expect(WorkflowAutomationTriggerBindingSchema.safeParse(legacy).success).toBe(false);
  });

  it('rejects a non-canonical kind', () => {
    expect(WorkflowAutomationTriggerBindingSchema.safeParse({ kind: 'github:pr.opened', params: {} }).success).toBe(
      false,
    );
  });

  it('rejects non-JSON params', () => {
    expect(
      WorkflowAutomationTriggerBindingSchema.safeParse({
        kind: 'makaio.bus-event',
        params: { emit: () => undefined },
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown filter operator', () => {
    expect(
      WorkflowAutomationTriggerBindingSchema.safeParse({
        kind: 'makaio.bus-event',
        params: { subject: 'git.checkout' },
        filter: { worktreePath: { $regex: '^/repos/' } },
      }).success,
    ).toBe(false);
  });
});

describe('WorkflowDefinitionSchema triggers', () => {
  const baseDefinition = {
    id: 'wf-triggers',
    name: 'Trigger bindings',
    scope: { type: 'global' },
    root: { id: 'root', type: 'sequence', nodes: [] },
  };

  it('persists authored automation trigger bindings', () => {
    const result = WorkflowDefinitionSchema.safeParse({
      ...baseDefinition,
      triggers: [BusEventWorkflowTrigger({ subject: GitNamespace.subjects.checkout })],
    });

    expect(result.success).toBe(true);
    expect(result.data?.triggers).toEqual([{ kind: 'makaio.bus-event', params: { subject: 'git.checkout' } }]);
  });

  it('rejects a definition carrying a legacy trigger', () => {
    const result = WorkflowDefinitionSchema.safeParse({
      ...baseDefinition,
      triggers: [{ type: 'manual' }],
    });

    expect(result.success).toBe(false);
  });
});
