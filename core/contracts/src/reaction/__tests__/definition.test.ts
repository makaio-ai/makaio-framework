import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineReaction } from '../definition.js';
import { createReactionRuleRef } from '../execution.js';
import type { ReactionExecutionContext } from '../execution.js';
import { ReactionDescriptorSchema, ReactionOutcomeSchema } from '../schemas.js';

const parameterSchema = z.object({
  channel: z.string(),
  message: z.string(),
});

/**
 * Create a minimal execution context fixture.
 * @param overrides - Fields to override on the base fixture.
 * @returns Execution context fixture.
 */
function makeContext(overrides: Partial<ReactionExecutionContext> = {}): ReactionExecutionContext {
  return {
    invocationId: 'inv-1',
    ruleRef: undefined,
    eventKind: 'test.event',
    eventPayload: { id: 'evt-1' },
    hostContext: { tenant: 'acme' },
    correlationId: undefined,
    signal: new AbortController().signal,
    deadlineEpochMs: undefined,
    ...overrides,
  };
}

describe('defineReaction', () => {
  it('preserves identity fields and the live parameter schema', () => {
    const reaction = defineReaction({
      kind: 'my-extension.notify-owner',
      description: 'Notifies the owning user.',
      parameterSchema,
      handler: async () => {},
    });

    expect(reaction.kind).toBe('my-extension.notify-owner');
    expect(reaction.description).toBe('Notifies the owning user.');
    expect(reaction.parameterSchema).toBe(parameterSchema);
    expect(reaction.parameterSchema.parse({ channel: 'email', message: 'hi' })).toEqual({
      channel: 'email',
      message: 'hi',
    });
  });

  it('forwards validated parameters and the execution context to the typed handler', async () => {
    const received: { parameters?: unknown; context?: ReactionExecutionContext } = {};
    const reaction = defineReaction({
      kind: 'my-extension.notify-owner',
      description: 'Notifies the owning user.',
      parameterSchema,
      handler: async (parameters, context) => {
        received.parameters = parameters;
        received.context = context;
      },
    });

    const context = makeContext({
      ruleRef: createReactionRuleRef({ ruleId: 'rule-7' }),
      correlationId: 'corr-1',
      deadlineEpochMs: 1700000005000,
    });
    const parameters = parameterSchema.parse({ channel: 'email', message: 'hi' });
    await reaction.handler(parameters, context);

    expect(received.parameters).toEqual({ channel: 'email', message: 'hi' });
    expect(received.context).toBe(context);
    // Intersection contract: branded ref still exposes host-side fields
    expect((received.context?.ruleRef as { ruleId: string } | undefined)?.ruleId).toBe('rule-7');
  });

  it('derives a serializable descriptor with a JSON Schema parameter shape', () => {
    const reaction = defineReaction({
      kind: 'my-extension.notify-owner',
      description: 'Notifies the owning user.',
      parameterSchema,
      handler: async () => {},
    });

    const descriptor = reaction.toDescriptor();
    expect(ReactionDescriptorSchema.parse(descriptor)).toEqual(descriptor);
    expect(descriptor.kind).toBe('my-extension.notify-owner');
    expect(descriptor.parameterSchema).not.toHaveProperty('$schema');
    expect(descriptor.parameterSchema).toMatchObject({
      type: 'object',
      properties: {
        channel: { type: 'string' },
        message: { type: 'string' },
      },
    });
    expect(() => JSON.stringify(descriptor)).not.toThrow();
  });

  it('advertises a transform schema’s raw input shape', () => {
    const reaction = defineReaction({
      kind: 'my-extension.parse-priority',
      description: 'Parses an incoming priority.',
      parameterSchema: z.object({ priority: z.string() }).transform(({ priority }) => ({
        priority: Number.parseInt(priority, 10),
      })),
      handler: async () => {},
    });

    expect(() => reaction.toDescriptor()).not.toThrow();
    expect(reaction.toDescriptor().parameterSchema).toMatchObject({
      type: 'object',
      properties: { priority: { type: 'string' } },
    });
  });

  it('rejects unrepresentable parameter schemas at definition time', () => {
    expect(() =>
      defineReaction({
        kind: 'my-extension.schedule-notification',
        description: 'Schedules a notification.',
        parameterSchema: z.object({ at: z.date() }),
        handler: async () => {},
      }),
    ).toThrow(/Date cannot be represented/i);
  });

  it('returns detached descriptor snapshots', () => {
    const reaction = defineReaction({
      kind: 'my-extension.notify-owner',
      description: 'Notifies the owning user.',
      parameterSchema,
      handler: async () => {},
    });

    const first = reaction.toDescriptor();
    const properties = first.parameterSchema.properties as object;
    const channel = Reflect.get(properties, 'channel') as object;
    Reflect.set(channel, 'type', 'number');

    expect(reaction.toDescriptor().parameterSchema).toMatchObject({
      properties: { channel: { type: 'string' } },
    });
  });

  it('rejects runtime-invalid identity with the canonical descriptor schema', () => {
    expect(() =>
      defineReaction({
        kind: null as never,
        description: 'Notifies the owning user.',
        parameterSchema,
        handler: async () => {},
      }),
    ).toThrow(z.ZodError);
  });
});

describe('ReactionDescriptorSchema', () => {
  it('accepts a valid descriptor with a JSON-safe parameter schema', () => {
    const result = ReactionDescriptorSchema.safeParse({
      kind: 'my-extension.notify-owner',
      description: 'Notifies the owning user.',
      parameterSchema: {
        type: 'object',
        properties: {
          channel: { type: 'string' },
          message: { type: 'string' },
        },
        required: ['channel', 'message'],
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects non-JSON values embedded in the parameter schema payload', () => {
    const result = ReactionDescriptorSchema.safeParse({
      kind: 'my-extension.notify-owner',
      description: 'Notifies the owning user.',
      parameterSchema: { maxItems: 10n },
    });
    expect(result.success).toBe(false);
  });
});

describe('ReactionOutcomeSchema', () => {
  it('accepts the success variant', () => {
    expect(ReactionOutcomeSchema.parse({ success: true })).toEqual({ success: true });
  });

  it('accepts the failure variant with an error message', () => {
    const outcome = { success: false, error: { message: 'boom' } };
    expect(ReactionOutcomeSchema.parse(outcome)).toEqual(outcome);
  });

  it('rejects a failure variant without error details', () => {
    expect(ReactionOutcomeSchema.safeParse({ success: false }).success).toBe(false);
  });
});
