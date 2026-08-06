import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAutomationTriggerDescriptor, defineAutomationTrigger, toAutomationTriggerType } from '../definition.js';
import type {
  AutomationTriggerActivationContext,
  AutomationTriggerCleanup,
  AutomationTriggerParams,
  AutomationTriggerType,
} from '../definition.js';
import type { ExtensionAutomationTriggersContribution } from '../contribution.js';
import { AutomationTriggerDescriptorSchema } from '../schemas.js';

const paramsSchema = z.object({ projectKey: z.string().transform((value) => value.toUpperCase()) });
const eventSchema = z.object({ issueKey: z.string() });

describe('defineAutomationTrigger', () => {
  it('preserves identity fields and typed schemas', () => {
    const definition = defineAutomationTrigger({
      kind: 'demo.assignment',
      label: 'Assignment',
      description: 'Emits accepted assignments.',
      categories: ['Issue trackers'],
      paramsSchema,
      eventSchema,
      activate: async () => async () => undefined,
    });

    expect(definition.kind).toBe('demo.assignment');
    expect(definition.label).toBe('Assignment');
    expect(definition.description).toBe('Emits accepted assignments.');
    expect(definition.categories).toEqual(['Issue trackers']);
    expect(definition.paramsSchema).toBe(paramsSchema);
    expect(definition.eventSchema).toBe(eventSchema);
  });

  it('applies the params schema transform', () => {
    const definition = defineAutomationTrigger({
      kind: 'demo.assignment',
      label: 'Assignment',
      description: 'Emits accepted assignments.',
      categories: [],
      paramsSchema,
      eventSchema,
      activate: async () => async () => undefined,
    });

    expect(definition.paramsSchema.parse({ projectKey: 'shop' })).toEqual({ projectKey: 'SHOP' });
  });

  it('rejects an invalid kind at definition time', () => {
    expect(() =>
      defineAutomationTrigger({
        kind: 'InvalidKind',
        label: 'L',
        description: 'D',
        categories: [],
        paramsSchema: z.object({}),
        eventSchema: z.object({}),
        activate: async () => async () => undefined,
      }),
    ).toThrow();
  });

  it('rejects unrepresentable param schemas at definition time', () => {
    expect(() =>
      defineAutomationTrigger({
        kind: 'demo.bad-params',
        label: 'L',
        description: 'D',
        categories: [],
        paramsSchema: z.object({ at: z.date() }) as never,
        eventSchema: z.object({}),
        activate: async () => async () => undefined,
      }),
    ).toThrow(/Date cannot be represented/i);
  });
});

describe('createAutomationTriggerDescriptor', () => {
  it('produces a validated detached descriptor', () => {
    const definition = defineAutomationTrigger({
      kind: 'demo.assignment',
      label: 'Assignment',
      description: 'Emits accepted assignments.',
      categories: ['Issue trackers'],
      paramsSchema,
      eventSchema,
      activate: async () => async () => undefined,
    });

    const descriptor = createAutomationTriggerDescriptor(definition);
    expect(AutomationTriggerDescriptorSchema.parse(descriptor)).toEqual(descriptor);
    expect(descriptor).toMatchObject({
      kind: 'demo.assignment',
      parameterSchema: { type: 'object' },
      eventSchema: { type: 'object' },
      workflowCompatible: true,
    });
    expect(descriptor.label).toBe('Assignment');
    expect(descriptor.categories).toEqual(['Issue trackers']);
  });

  it('strips $schema from derived JSON Schema records', () => {
    const definition = defineAutomationTrigger({
      kind: 'demo.stripped',
      label: 'S',
      description: 'D',
      categories: [],
      paramsSchema: z.object({ x: z.string() }),
      eventSchema: z.object({ y: z.number() }),
      activate: async () => async () => undefined,
    });

    const descriptor = createAutomationTriggerDescriptor(definition);
    expect(descriptor.parameterSchema).not.toHaveProperty('$schema');
    expect(descriptor.eventSchema).not.toHaveProperty('$schema');
  });

  it('advertises a transform schema input shape for params', () => {
    const definition = defineAutomationTrigger({
      kind: 'demo.transform',
      label: 'T',
      description: 'D',
      categories: [],
      paramsSchema: z.object({ raw: z.string().transform((s) => s.toUpperCase()) }),
      eventSchema: z.object({ out: z.string() }),
      activate: async () => async () => undefined,
    });

    const descriptor = createAutomationTriggerDescriptor(definition);
    expect(descriptor.parameterSchema).toMatchObject({
      type: 'object',
      properties: { raw: { type: 'string' } },
    });
  });

  it('derives workflow compatibility conservatively from the output JSON Schema root', () => {
    const scalar = defineAutomationTrigger({
      kind: 'demo.scalar-output',
      label: 'Scalar',
      description: 'Emits a scalar.',
      categories: [],
      paramsSchema: z.object({}),
      eventSchema: z.string(),
      activate: async () => async () => undefined,
    });
    const array = defineAutomationTrigger({
      kind: 'demo.array-output',
      label: 'Array',
      description: 'Emits an array.',
      categories: [],
      paramsSchema: z.object({}),
      eventSchema: z.array(z.string()),
      activate: async () => async () => undefined,
    });
    const decodedObject = defineAutomationTrigger({
      kind: 'demo.decoded-object',
      label: 'Decoded object',
      description: 'Decodes a scalar source value to an object event.',
      categories: [],
      paramsSchema: z.object({}),
      eventSchema: z.codec(z.string(), z.object({ normalized: z.string() }), {
        decode: (value) => ({ normalized: value.toUpperCase() }),
        encode: (value) => value.normalized,
      }),
      activate: async () => async () => undefined,
    });

    expect(createAutomationTriggerDescriptor(scalar).workflowCompatible).toBe(false);
    expect(createAutomationTriggerDescriptor(array).workflowCompatible).toBe(false);
    expect(createAutomationTriggerDescriptor(decodedObject).workflowCompatible).toBe(true);
  });

  it('returns detached descriptor snapshots that cannot mutate the cache', () => {
    const definition = defineAutomationTrigger({
      kind: 'demo.snapshot',
      label: 'L',
      description: 'D',
      categories: [],
      paramsSchema: z.object({ id: z.string() }),
      eventSchema: z.object({}),
      activate: async () => async () => undefined,
    });

    const first = createAutomationTriggerDescriptor(definition);
    const props = first.parameterSchema.properties as Record<string, object>;
    Reflect.set(props['id']!, 'type', 'number');

    expect(createAutomationTriggerDescriptor(definition).parameterSchema).toMatchObject({
      properties: { id: { type: 'string' } },
    });
  });

  it('produces serializable descriptors', () => {
    const definition = defineAutomationTrigger({
      kind: 'demo.serial',
      label: 'L',
      description: 'D',
      categories: ['cat'],
      paramsSchema: z.object({ key: z.string() }),
      eventSchema: z.object({ value: z.number() }),
      activate: async () => async () => undefined,
    });

    expect(() => JSON.stringify(createAutomationTriggerDescriptor(definition))).not.toThrow();
  });
});

describe('AutomationTriggerType activate variance', () => {
  it('rejects an activation declaring narrower params than the erased contract', () => {
    const narrowActivate =
      async (
        _context: AutomationTriggerActivationContext<unknown>,
        _params: { readonly repo: string },
      ): Promise<AutomationTriggerCleanup> =>
      async () =>
        undefined;

    // @ts-expect-error `activate` is a readonly property, so its parameters are
    // checked contravariantly. Without that, a hand-written trigger could pair
    // `params: { repo: string }` with `paramsSchema: z.object({})` and still
    // type-check as an AutomationTriggerType.
    const erased: AutomationTriggerType['activate'] = narrowActivate;

    expect(erased).toBeTypeOf('function');
  });

  it('accepts an activation declaring the erased params contract', () => {
    const wideActivate =
      async (
        _context: AutomationTriggerActivationContext<unknown>,
        _params: AutomationTriggerParams,
      ): Promise<AutomationTriggerCleanup> =>
      async () =>
        undefined;

    const erased: AutomationTriggerType['activate'] = wideActivate;

    expect(erased).toBeTypeOf('function');
  });
});

describe('toAutomationTriggerType', () => {
  // Use a typed schema to exercise the generic overload end-to-end.
  const projectParamsSchema = z.object({ projectKey: z.string() });
  const issueEventSchema = z.object({ issueKey: z.string() });

  it('returns the identical object reference (preserves descriptor cache key)', () => {
    const definition = defineAutomationTrigger({
      kind: 'demo.identity-check',
      label: 'Identity Check',
      description: 'Verifies toAutomationTriggerType preserves object identity.',
      categories: [],
      paramsSchema: projectParamsSchema,
      eventSchema: issueEventSchema,
      activate: async () => async () => undefined,
    });

    // Compile-time check: the return type satisfies AutomationTriggerType.
    // Runtime check: no spread/copy was made — the WeakMap descriptor cache key is still valid.
    expect(toAutomationTriggerType(definition)).toBe(definition);
  });

  it('is usable as the return element of createAutomationTriggers without a cast on the caller side', () => {
    const definition = defineAutomationTrigger({
      kind: 'demo.contribution-check',
      label: 'Contribution Check',
      description: 'Exercises the typed contribution factory return type.',
      categories: ['Tests'],
      paramsSchema: projectParamsSchema,
      eventSchema: issueEventSchema,
      activate: async (_ctx, params) => {
        // params is typed as { projectKey: string } — no cast required.
        void params.projectKey;
        return async () => undefined;
      },
    });

    // This assignment compiles only if toAutomationTriggerType(definition) satisfies
    // AutomationTriggerType, which is the expected element type of createAutomationTriggers.
    const contribution: ExtensionAutomationTriggersContribution = {
      createAutomationTriggers: () => [toAutomationTriggerType(definition)],
    };

    expect(contribution.createAutomationTriggers).toBeTypeOf('function');
  });
});
