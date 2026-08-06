import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createBusInstance } from '@makaio/bus-core';
import type { IMakaioBus } from '@makaio/bus-core';
import {
  AutomationTriggerSubjects,
  defineAutomationTrigger,
  toAutomationTriggerType,
  type AutomationTriggerType,
} from '@makaio/contracts';
import { AutomationTriggerRegistry } from '../automation-trigger-registry.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/**
 * Builds a minimal automation trigger type for use in tests.
 * @param kind - Canonical kind string, e.g. `demo.assignment`.
 * @returns A frozen, validated AutomationTriggerType.
 */
function makeTrigger(kind: string): AutomationTriggerType {
  return toAutomationTriggerType(
    defineAutomationTrigger({
      kind,
      label: `${kind} label`,
      description: `Fires on ${kind}.`,
      categories: ['test'],
      paramsSchema: z.object({ projectId: z.string() }),
      eventSchema: z.object({ id: z.string() }),
      activate: async () => () => {},
    }),
  );
}

/** A reusable assignment trigger owned by 'demo'. */
const assignmentTrigger = makeTrigger('demo.assignment');

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('AutomationTriggerRegistry', () => {
  let bus: IMakaioBus;
  let registry: AutomationTriggerRegistry;

  beforeEach(async () => {
    bus = createBusInstance();
    registry = new AutomationTriggerRegistry(bus);
    await registry.init();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await registry.destroy();
  });

  // -------------------------------------------------------------------------
  // register — happy path
  // -------------------------------------------------------------------------

  describe('register', () => {
    it('resolves a registered trigger by kind', async () => {
      await registry.register('demo', [assignmentTrigger]);

      expect(registry.resolveRegistration('demo.assignment')).toEqual({
        owner: 'demo',
        type: expect.objectContaining({ kind: 'demo.assignment' }),
      });
    });

    it('returns undefined for an unregistered kind', async () => {
      expect(registry.resolveRegistration('demo.missing')).toBeUndefined();
    });

    it('serves descriptors via the list() method', async () => {
      await registry.register('demo', [assignmentTrigger]);

      const descriptors = registry.list();
      expect(descriptors).toHaveLength(1);
      expect(descriptors[0]?.kind).toBe('demo.assignment');
    });

    it('atomically replaces an owner batch — new batch takes full effect', async () => {
      const reviewTrigger = makeTrigger('demo.review');
      await registry.register('demo', [assignmentTrigger]);
      await registry.register('demo', [reviewTrigger]);

      expect(registry.list()).toHaveLength(1);
      expect(registry.list()[0]?.kind).toBe('demo.review');
      expect(registry.resolveRegistration('demo.assignment')).toBeUndefined();
    });

    it('does not emit changed and keeps list empty when registering an empty batch with no prior entries', async () => {
      const events: unknown[] = [];
      bus.on(AutomationTriggerSubjects.changed, (ctx) => {
        events.push(ctx.payload);
      });

      await registry.register('demo', []);

      expect(events).toHaveLength(0);
      expect(registry.list()).toHaveLength(0);
    });

    it('accepts dot-qualified owner names (e.g. makaio.clients-core)', async () => {
      const nestedTrigger = makeTrigger('makaio.clients-core.profile-changed');
      await expect(registry.register('makaio.clients-core', [nestedTrigger])).resolves.toBeUndefined();
      expect(registry.resolveRegistration('makaio.clients-core.profile-changed')).toMatchObject({
        owner: 'makaio.clients-core',
      });
    });

    it('accepts npm-scoped owners with their exact canonical prefix', async () => {
      const scopedTrigger = makeTrigger('@acme/review.review-posted');

      await expect(registry.register('@acme/review', [scopedTrigger])).resolves.toBeUndefined();
      expect(registry.resolveRegistration('@acme/review.review-posted')).toMatchObject({
        owner: '@acme/review',
      });
      await expect(registry.register('@acme/reviews', [scopedTrigger])).rejects.toThrow(/@acme\/review\.review-posted/);
    });

    it('accepts npm-scoped owner components containing dots and underscores', async () => {
      const dottedScopeTrigger = makeTrigger('@acme.inc/review_tools.review-posted');
      const dottedPackageTrigger = makeTrigger('@acme_inc/review.tools.review-posted');

      await registry.register('@acme.inc/review_tools', [dottedScopeTrigger]);
      await registry.register('@acme_inc/review.tools', [dottedPackageTrigger]);

      expect(registry.resolveRegistration('@acme.inc/review_tools.review-posted')).toMatchObject({
        owner: '@acme.inc/review_tools',
      });
      expect(registry.resolveRegistration('@acme_inc/review.tools.review-posted')).toMatchObject({
        owner: '@acme_inc/review.tools',
      });
    });

    it('accepts npm-scoped owner components starting with hyphens', async () => {
      const hyphenatedScopeTrigger = makeTrigger('@-acme/review.review-posted');
      const hyphenatedPackageTrigger = makeTrigger('@acme/-review.review-posted');

      await registry.register('@-acme/review', [hyphenatedScopeTrigger]);
      await registry.register('@acme/-review', [hyphenatedPackageTrigger]);

      expect(registry.resolveRegistration('@-acme/review.review-posted')).toMatchObject({
        owner: '@-acme/review',
      });
      expect(registry.resolveRegistration('@acme/-review.review-posted')).toMatchObject({
        owner: '@acme/-review',
      });
    });

    it('rejects empty local-name segments after the exact scoped owner prefix', async () => {
      for (const kind of ['@acme/review..event.local', '@acme/review...event.local', '@acme/review.foo..event.local']) {
        await expect(registry.register('@acme/review', [makeTrigger(kind)])).rejects.toThrow(
          /must be namespaced by owner/,
        );
      }
    });

    // -----------------------------------------------------------------------
    // Collision and duplicate validation
    // -----------------------------------------------------------------------

    it('rejects another owner claiming an already-registered kind — names both kind and requestor', async () => {
      await registry.register('demo', [assignmentTrigger]);

      await expect(registry.register('other', [assignmentTrigger])).rejects.toThrow(/demo\.assignment.*other/);
      // Prior registration is intact
      expect(registry.resolveRegistration('demo.assignment')?.type.kind).toBe('demo.assignment');
    });

    it('rejects duplicate kinds within a single batch without partial registration', async () => {
      await expect(registry.register('demo', [assignmentTrigger, assignmentTrigger])).rejects.toThrow(/duplicate/i);
      expect(registry.list()).toHaveLength(0);
    });

    it('rejects a kind not namespaced by the owner', async () => {
      const foreign = makeTrigger('other.task');
      await expect(registry.register('demo', [foreign])).rejects.toThrow(/other\.task/);
    });

    it('rejects the bare owner prefix (empty local name)', async () => {
      // Cannot use defineAutomationTrigger here since it would reject at definition
      // time; build the raw shape manually to reach the registry validation.
      const bareKind = 'demo.'; // technically invalid — but caught by registry
      const raw = {
        kind: bareKind,
        label: 'Bare',
        description: 'Has no local name.',
        categories: [] as readonly string[],
        paramsSchema: z.object({}),
        eventSchema: z.object({}),
        activate: async (): Promise<() => void> => () => {},
      } satisfies AutomationTriggerType;
      await expect(registry.register('demo', [raw])).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // deregister
  // -------------------------------------------------------------------------

  describe('deregister', () => {
    it('removes all triggers for an owner and is idempotent', async () => {
      await registry.register('demo', [assignmentTrigger]);
      await registry.register('other', [makeTrigger('other.task')]);

      await registry.deregister('demo');
      await registry.deregister('demo'); // idempotent

      expect(registry.list().map((d) => d.kind)).toEqual(['other.task']);
      expect(registry.resolveRegistration('demo.assignment')).toBeUndefined();
    });

    it('is a no-op and does not emit when the owner has no registrations', async () => {
      const events: unknown[] = [];
      bus.on(AutomationTriggerSubjects.changed, (ctx) => {
        events.push(ctx.payload);
      });

      await registry.deregister('nobody');

      expect(events).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Descriptor snapshots
  // -------------------------------------------------------------------------

  describe('list — descriptor snapshots', () => {
    it('returns deep-frozen descriptor snapshots callers cannot corrupt', async () => {
      await registry.register('demo', [assignmentTrigger]);

      const descriptor = registry.list()[0];
      if (!descriptor) throw new Error('Expected a descriptor');

      // Descriptors are shared rather than cloned per call, so immutability — not
      // per-call detachment — is what protects the stored discovery snapshot.
      expect(() => {
        (descriptor as { kind: string }).kind = 'mutated.kind';
      }).toThrow(TypeError);
      expect(() => {
        (descriptor.categories as string[]).push('Injected');
      }).toThrow(TypeError);
      expect(() => {
        (descriptor.parameterSchema as Record<string, unknown>)['type'] = 'string';
      }).toThrow(TypeError);

      expect(registry.list()[0]?.kind).toBe('demo.assignment');
    });

    it('memoizes the catalog per index revision and rebuilds it after a mutation', async () => {
      await registry.register('demo', [assignmentTrigger]);

      const first = registry.list();
      expect(registry.list()).toBe(first);

      await registry.register('other', [makeTrigger('other.watch')]);

      const second = registry.list();
      expect(second).not.toBe(first);
      expect(second.map((descriptor) => descriptor.kind)).toEqual(['demo.assignment', 'other.watch']);
    });
  });

  // -------------------------------------------------------------------------
  // Revision and changed event
  // -------------------------------------------------------------------------

  describe('changed event — revision', () => {
    it('emits changed with incrementing revision on register and deregister', async () => {
      const events: Array<{ owner: string; revision: number; kinds: string[]; reason: string }> = [];

      bus.on(AutomationTriggerSubjects.changed, (ctx) => {
        events.push(ctx.payload);
      });

      await registry.register('demo', [assignmentTrigger]);
      await registry.register('other', [makeTrigger('other.task')]);
      await registry.deregister('demo');

      expect(events).toHaveLength(3);
      expect(events[0]).toEqual({ owner: 'demo', revision: 1, kinds: ['demo.assignment'], reason: 'registered' });
      expect(events[1]).toEqual({ owner: 'other', revision: 2, kinds: ['other.task'], reason: 'registered' });
      expect(events[2]).toEqual({ owner: 'demo', revision: 3, kinds: ['demo.assignment'], reason: 'deregistered' });
    });

    it('emits the exact union of previous and replacement batch kinds', async () => {
      const events: Array<{ kinds: string[] }> = [];
      bus.on(AutomationTriggerSubjects.changed, (ctx) => {
        events.push(ctx.payload);
      });

      await registry.register('demo', [assignmentTrigger, makeTrigger('demo.review')]);
      await registry.register('demo', [makeTrigger('demo.review'), makeTrigger('demo.completed')]);

      expect(events[1]?.kinds).toEqual(['demo.assignment', 'demo.review', 'demo.completed']);
    });

    it('emits reason deregistered when replacing an owner batch with an empty batch', async () => {
      const events: Array<{ reason: string }> = [];
      bus.on(AutomationTriggerSubjects.changed, (ctx) => {
        events.push(ctx.payload);
      });

      await registry.register('demo', [assignmentTrigger]);
      await registry.register('demo', []); // explicit empty replacement

      expect(events[1]?.reason).toBe('deregistered');
    });
  });

  // -------------------------------------------------------------------------
  // Bus RPC catalog
  // -------------------------------------------------------------------------

  describe('automation-triggers.list RPC', () => {
    it('responds to list RPC with current trigger descriptors', async () => {
      await registry.register('demo', [assignmentTrigger]);
      await registry.register('other', [makeTrigger('other.task')]);

      const response = await bus.request(AutomationTriggerSubjects.list, {});

      expect(response.triggers.map((t) => t.kind).sort()).toEqual(['demo.assignment', 'other.task']);
      expect(response.triggers[0]).toMatchObject({
        label: expect.any(String),
        description: expect.any(String),
        parameterSchema: expect.any(Object),
        eventSchema: expect.any(Object),
      });
    });

    it('reflects deregistration in subsequent list RPC responses', async () => {
      await registry.register('demo', [assignmentTrigger]);
      await registry.deregister('demo');

      const response = await bus.request(AutomationTriggerSubjects.list, {});
      expect(response.triggers).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Notification failure isolation
  // -------------------------------------------------------------------------

  describe('changed notification failure', () => {
    it('commits a change consumed by one observer when a sibling observer rejects', async () => {
      const observed: Array<{ owner: string; revision: number; kinds: string[]; reason: string }> = [];
      bus.on(AutomationTriggerSubjects.changed, (ctx) => {
        observed.push(ctx.payload);
      });
      const unsubscribeRejectingObserver = bus.on(AutomationTriggerSubjects.changed, async () => {
        throw new Error('observer unavailable');
      });
      const report = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(registry.register('demo', [assignmentTrigger])).resolves.toBeUndefined();

      expect(observed).toEqual([{ owner: 'demo', revision: 1, kinds: ['demo.assignment'], reason: 'registered' }]);
      expect(registry.list().map((descriptor) => descriptor.kind)).toEqual(['demo.assignment']);
      expect(registry.resolveRegistration('demo.assignment')).toMatchObject({ owner: 'demo' });
      expect(report).toHaveBeenCalledWith(
        '[AutomationTriggerRegistry] Failed to emit automation-triggers.changed:',
        expect.any(Error),
      );

      unsubscribeRejectingObserver();
      await registry.register('other', [makeTrigger('other.watch')]);

      expect(observed).toEqual([
        { owner: 'demo', revision: 1, kinds: ['demo.assignment'], reason: 'registered' },
        { owner: 'other', revision: 2, kinds: ['other.watch'], reason: 'registered' },
      ]);
      expect(registry.list().map((descriptor) => descriptor.kind)).toEqual(['demo.assignment', 'other.watch']);
      expect(registry.resolveRegistration('other.watch')).toMatchObject({ owner: 'other' });
    });

    it('keeps deregistration committed when changed notification fails', async () => {
      await registry.register('demo', [assignmentTrigger]);
      vi.spyOn(bus, 'emit').mockRejectedValueOnce(new Error('bus unavailable'));
      vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(registry.deregister('demo')).resolves.toBeUndefined();

      expect(registry.list()).toHaveLength(0);
      expect(registry.resolveRegistration('demo.assignment')).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Defensive snapshot of type fields
  // -------------------------------------------------------------------------

  describe('register — defensive type snapshot', () => {
    it('preserves registered behavior when the original plain object is mutated after registration', async () => {
      // defineAutomationTrigger freezes its result, so we build a plain mutable
      // AutomationTriggerType to exercise the snapshot path.
      // `satisfies` (rather than an annotation) keeps the inferred property
      // types mutable so the post-registration mutation below needs no cast.
      const mutable = {
        kind: 'demo.mutable',
        label: 'Original Label',
        description: 'Original description.',
        categories: ['a'],
        paramsSchema: z.object({ x: z.string() }),
        eventSchema: z.object({ y: z.number() }),
        activate: async () => () => {},
      } satisfies AutomationTriggerType;

      await registry.register('demo', [mutable]);

      // Mutate the source object after registration
      mutable.label = 'Mutated Label';
      mutable.categories = ['b', 'c'];

      const resolved = registry.resolveRegistration('demo.mutable');
      expect(resolved?.type.label).toBe('Original Label');
      expect(resolved?.type.categories).toEqual(['a']);
    });

    it('keeps a re-registered mutable definition’s descriptor aligned with its snapshot', async () => {
      const mutable = {
        kind: 'demo.mutable',
        label: 'Original Label',
        description: 'Original description.',
        categories: ['a'],
        paramsSchema: z.object({ x: z.string() }),
        eventSchema: z.object({ y: z.number() }),
        activate: async () => () => {},
      } satisfies AutomationTriggerType;

      await registry.register('demo', [mutable]);
      mutable.label = 'Mutated Label';
      await registry.register('demo', [mutable]);

      // Descriptor and type must describe the same observation: a descriptor
      // pinned to the first registration would advertise a label the resolved
      // trigger no longer carries.
      expect(registry.resolveRegistration('demo.mutable')?.type.label).toBe('Mutated Label');
      expect(registry.list()[0]?.label).toBe('Mutated Label');
    });
  });

  // -------------------------------------------------------------------------
  // Destroy
  // -------------------------------------------------------------------------

  describe('destroy', () => {
    it('clears all registrations on teardown', async () => {
      await registry.register('demo', [assignmentTrigger]);

      await registry.destroy();

      expect(registry.list()).toHaveLength(0);
    });
  });
});
