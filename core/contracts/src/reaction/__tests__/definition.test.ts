import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineReaction } from '../definition.js';
import type { ReactionCause, ReactionExecutionContext } from '../execution.js';
import { ReactionDescriptorSchema, ReactionOutcomeSchema } from '../schemas.js';

const parameterSchema = z.object({
  channel: z.string(),
  message: z.string(),
});

/**
 * Create a minimal {@link ReactionCause} fixture.
 * @returns A schema-shaped but otherwise arbitrary cause.
 */
function makeCause(): ReactionCause {
  return {
    ruleId: 'rule-7',
    evaluationId: 'evaluation-1',
    ruleSet: { id: 'set-1', digest: 'digest-1' },
    rule: {
      id: 'rule-7',
      description: 'Test rule.',
      on: { kind: 'test.trigger' },
      reaction: { kind: 'my-extension.notify-owner' },
    },
    event: {
      cause: { message: { receivedAt: new Date(0).toISOString() } },
      subject: 'test.subject',
      origin: {
        caller: { kind: 'makaio.extension', id: 'test' },
        principal: { kind: 'makaio.extension', id: 'test' },
      },
      facts: {},
    },
  };
}

/**
 * Create a minimal execution context fixture.
 * @param overrides - Fields to override on the base fixture.
 * @returns Execution context fixture.
 */
function makeContext(overrides: Partial<ReactionExecutionContext> = {}): ReactionExecutionContext {
  return {
    invocationId: 'inv-1',
    key: 'rule-7:occasion-1',
    cause: makeCause(),
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
      keyed: false,
      handler: async () => ({ state: 'accepted' }),
    });

    expect(reaction.kind).toBe('my-extension.notify-owner');
    expect(reaction.description).toBe('Notifies the owning user.');
    expect(reaction.keyed).toBe(false);
    expect(reaction.parameterSchema).toBe(parameterSchema);
    expect(reaction.parameterSchema.parse({ channel: 'email', message: 'hi' })).toEqual({
      channel: 'email',
      message: 'hi',
    });
  });

  it('forwards the call context, validated parameters, and the execution context to the typed handler', async () => {
    const received: { call?: unknown; parameters?: unknown; context?: ReactionExecutionContext } = {};
    const reaction = defineReaction({
      kind: 'my-extension.notify-owner',
      description: 'Notifies the owning user.',
      parameterSchema,
      keyed: false,
      handler: async (call, parameters, context) => {
        received.call = call;
        received.parameters = parameters;
        received.context = context;
        return { state: 'accepted' };
      },
    });

    const call = { caller: { kind: 'makaio.rules', id: 'rules' }, principal: { kind: 'makaio.extension', id: 'x' } };
    const context = makeContext({ correlationId: 'corr-1', deadlineEpochMs: 1700000005000 });
    const parameters = parameterSchema.parse({ channel: 'email', message: 'hi' });
    const outcome = await reaction.handler(call as never, parameters, context);

    expect(received.call).toBe(call);
    expect(received.parameters).toEqual({ channel: 'email', message: 'hi' });
    expect(received.context).toBe(context);
    expect(outcome).toEqual({ state: 'accepted' });
  });

  it('derives a serializable descriptor with a JSON Schema parameter shape', () => {
    const reaction = defineReaction({
      kind: 'my-extension.notify-owner',
      description: 'Notifies the owning user.',
      parameterSchema,
      keyed: false,
      handler: async () => ({ state: 'accepted' }),
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
      keyed: false,
      handler: async () => ({ state: 'accepted' }),
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
        keyed: false,
        handler: async () => ({ state: 'accepted' }),
      }),
    ).toThrow(/Date cannot be represented/i);
  });

  it('returns detached descriptor snapshots', () => {
    const reaction = defineReaction({
      kind: 'my-extension.notify-owner',
      description: 'Notifies the owning user.',
      parameterSchema,
      keyed: false,
      handler: async () => ({ state: 'accepted' }),
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
        keyed: false,
        handler: async () => ({ state: 'accepted' }),
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
  it('accepts the accepted variant, with and without a result', () => {
    expect(ReactionOutcomeSchema.parse({ state: 'accepted' })).toEqual({ state: 'accepted' });
    expect(ReactionOutcomeSchema.parse({ state: 'accepted', result: { ok: true } })).toEqual({
      state: 'accepted',
      result: { ok: true },
    });
  });

  it('accepts the rejected and failed variants with a stable code and reason', () => {
    const rejected = { state: 'rejected', code: 'not-allowed', reason: 'denied' };
    const failed = { state: 'failed', code: 'handler-failed', reason: 'boom' };
    expect(ReactionOutcomeSchema.parse(rejected)).toEqual(rejected);
    expect(ReactionOutcomeSchema.parse(failed)).toEqual(failed);
  });

  it('accepts the retry variant with a reason', () => {
    const retry = { state: 'retry', reason: 'transient' };
    expect(ReactionOutcomeSchema.parse(retry)).toEqual(retry);
  });

  it('rejects a rejected or failed variant without a stable code', () => {
    expect(ReactionOutcomeSchema.safeParse({ state: 'rejected', reason: 'denied' }).success).toBe(false);
    expect(ReactionOutcomeSchema.safeParse({ state: 'failed', reason: 'boom' }).success).toBe(false);
  });
});
