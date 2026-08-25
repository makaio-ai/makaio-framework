/**
 * Tests for subject/namespace default transport visibility (§1.7).
 *
 * Covered scenarios:
 * 1. Namespace-level `defaultTransports: 'local-only'` suppresses transport
 *    dispatch when the caller omits `transports`.
 * 2. An explicit `transports` option (including an empty array) overrides the
 *    namespace default so callers can always opt in or out per call.
 * 3. Subject-level `$meta.defaultTransports: 'local-only'` also suppresses
 *    dispatch (takes precedence over namespace-level `'all'`).
 * 4. The relay path — transport-registry emits with explicit `transports` —
 *    is unaffected by namespace/subject defaults.
 * 5. Plain `'all'` namespace default (and no default) behaves identically:
 *    dispatches to transports as before.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { createBusNamespace, defaultTransports } from '@makaio/core';
import { createBusInstance, type BusMessage, type BusTransportRegistry, type EmitOptions } from '../index.js';
import { MockTransport } from './helpers/transport-fixtures.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create an isolated bus instance with a single recording transport registered,
 * plus the provided namespace.
 * @param definition - Namespace definition to register on the bus
 * @param transportKey - Key to use when registering the transport
 * @returns Object containing the bus, transport, and registered subjects
 */
function createTestSetup<Domain extends string, Schemas extends Record<string, import('@makaio/core').SubjectSchema>>(
  definition: import('@makaio/core').BusNamespaceDefinition<Domain, Schemas>,
  transportKey: keyof BusTransportRegistry,
): {
  bus: ReturnType<typeof createBusInstance>;
  transport: MockTransport;
  subjects: import('@makaio/core').BusNamespaceDefinition<Domain, Schemas>['subjects'];
} {
  const bus = createBusInstance();
  const { subjects } = bus.registerNamespace(definition);
  const transport = new MockTransport('test-transport');
  bus.getContext().transportRegistry.registerTransport(transportKey, transport);
  return { bus, transport, subjects };
}

// ---------------------------------------------------------------------------
// Namespace definitions (created once — no singleton mutation)
// ---------------------------------------------------------------------------

const LocalOnlyNs = createBusNamespace(
  'dtv-local-only',
  { updated: z.object({ value: z.string() }) },
  { defaultTransports: 'local-only' },
);

const AllNs = createBusNamespace('dtv-all', { updated: z.object({ value: z.string() }) }, { defaultTransports: 'all' });

const DefaultNs = createBusNamespace('dtv-default', { updated: z.object({ value: z.string() }) });

// Namespace with 'all' default but one subject marked local-only at the subject level
const MixedNs = createBusNamespace('dtv-mixed', {
  publicEvent: z.object({ value: z.string() }),
  internalEvent: defaultTransports(z.object({ value: z.string() }), 'local-only'),
});

const SubjectDefaultNs = createBusNamespace('dtv-subject-default', {
  event: defaultTransports(z.object({ id: z.string() }), 'local-only'),
});

const SubjectOverrideAllNs = createBusNamespace(
  'dtv-subject-override-all',
  {
    internalEvent: z.object({ value: z.string() }),
    publicEvent: defaultTransports(z.object({ value: z.string() }), 'all'),
  },
  { defaultTransports: 'local-only' },
);

declare module '../index.js' {
  interface BusTransportRegistry {
    'dtv-transport-a': MockTransport;
    'dtv-transport-b': MockTransport;
    'dtv-transport-c': MockTransport;
    'dtv-transport-d': MockTransport;
    'dtv-transport-e': MockTransport;
    'dtv-transport-relay': MockTransport;
    'dtv-transport-wrapper': MockTransport;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('defaultTransports — namespace-level local-only', () => {
  let bus: ReturnType<typeof createBusInstance>;
  let transport: MockTransport;

  beforeEach(() => {
    ({ bus, transport } = createTestSetup(LocalOnlyNs, 'dtv-transport-a'));
  });

  afterEach(() => {
    transport.clear();
  });

  it('does NOT dispatch to transport when caller omits transports option', async () => {
    await bus.emit(LocalOnlyNs.subjects.updated, { value: 'silent' });

    expect(transport.messages.filter((m) => m.type === 'event')).toHaveLength(0);
  });

  it('still delivers to local handlers when transport is suppressed by default', async () => {
    const received: string[] = [];
    bus.on(LocalOnlyNs.subjects.updated, ({ payload }) => {
      received.push(payload.value);
    });

    await bus.emit(LocalOnlyNs.subjects.updated, { value: 'local-handler' });

    expect(received).toEqual(['local-handler']);
    expect(transport.messages.filter((m) => m.type === 'event')).toHaveLength(0);
  });

  it('dispatches to transport when caller explicitly passes all transports (undefined override not applicable — opt-in via named transport)', async () => {
    await bus.emit(LocalOnlyNs.subjects.updated, { value: 'explicit' }, { transports: ['dtv-transport-a'] });

    const eventMessages = transport.messages.filter((m) => m.type === 'event');
    expect(eventMessages).toHaveLength(1);
    expect(eventMessages[0]).toMatchObject({
      type: 'event',
      subject: 'updated',
      namespace: 'dtv-local-only',
      payload: { value: 'explicit' },
    });
  });

  it('does not dispatch to transport when caller passes empty array (explicit local-only still local-only)', async () => {
    await bus.emit(LocalOnlyNs.subjects.updated, { value: 'force-local' }, { transports: [] });

    expect(transport.messages.filter((m) => m.type === 'event')).toHaveLength(0);
  });
});

describe('defaultTransports — namespace-level all (explicit)', () => {
  let bus: ReturnType<typeof createBusInstance>;
  let transport: MockTransport;

  beforeEach(() => {
    ({ bus, transport } = createTestSetup(AllNs, 'dtv-transport-b'));
  });

  afterEach(() => {
    transport.clear();
  });

  it('dispatches to transport when caller omits transports option', async () => {
    await bus.emit(AllNs.subjects.updated, { value: 'normal' });

    const eventMessages = transport.messages.filter((m) => m.type === 'event');
    expect(eventMessages).toHaveLength(1);
  });
});

describe('defaultTransports — no namespace-level default (implicit all)', () => {
  let bus: ReturnType<typeof createBusInstance>;
  let transport: MockTransport;

  beforeEach(() => {
    ({ bus, transport } = createTestSetup(DefaultNs, 'dtv-transport-c'));
  });

  afterEach(() => {
    transport.clear();
  });

  it('dispatches to transport by default — same behaviour as before this feature', async () => {
    await bus.emit(DefaultNs.subjects.updated, { value: 'default' });

    const eventMessages = transport.messages.filter((m) => m.type === 'event');
    expect(eventMessages).toHaveLength(1);
  });
});

describe('defaultTransports — mixed namespace (all default, subject-level meta)', () => {
  let bus: ReturnType<typeof createBusInstance>;
  let transport: MockTransport;

  beforeEach(() => {
    ({ bus, transport } = createTestSetup(MixedNs, 'dtv-transport-d'));
  });

  afterEach(() => {
    transport.clear();
  });

  it('publicEvent dispatches to transport (namespace all default)', async () => {
    await bus.emit(MixedNs.subjects.publicEvent, { value: 'public' });

    const eventMessages = transport.messages.filter(
      (m) => m.type === 'event' && (m as BusMessage & { subject: string }).subject === 'publicEvent',
    );
    expect(eventMessages).toHaveLength(1);
  });

  it('internalEvent does NOT dispatch to transport (subject-level local-only overrides namespace all)', async () => {
    await bus.emit(MixedNs.subjects.internalEvent, { value: 'internal' });

    const eventMessages = transport.messages.filter(
      (m) => m.type === 'event' && (m as BusMessage & { subject: string }).subject === 'internalEvent',
    );
    expect(eventMessages).toHaveLength(0);
  });
});

describe('defaultTransports — subject-level all overrides namespace local-only', () => {
  let bus: ReturnType<typeof createBusInstance>;
  let transport: MockTransport;

  beforeEach(() => {
    ({ bus, transport } = createTestSetup(SubjectOverrideAllNs, 'dtv-transport-e'));
  });

  afterEach(() => {
    transport.clear();
  });

  it('keeps namespace local-only for subjects without an override', async () => {
    await bus.emit(SubjectOverrideAllNs.subjects.internalEvent, { value: 'internal' });

    expect(transport.messages.filter((m) => m.type === 'event')).toHaveLength(0);
  });

  it('dispatches when subject-level all overrides namespace local-only', async () => {
    await bus.emit(SubjectOverrideAllNs.subjects.publicEvent, { value: 'public' });

    const eventMessages = transport.messages.filter((m) => m.type === 'event');
    expect(eventMessages).toHaveLength(1);
    expect(eventMessages[0]).toMatchObject({
      type: 'event',
      subject: 'publicEvent',
      namespace: 'dtv-subject-override-all',
      payload: { value: 'public' },
    });
  });
});

describe('defaultTransports — relay path unaffected', () => {
  it('relay path with explicit transports is unaffected by namespace local-only default', async () => {
    const bus = createBusInstance();
    bus.registerNamespace(LocalOnlyNs);
    const transport = new MockTransport('relay-transport');
    bus.getContext().transportRegistry.registerTransport('dtv-transport-relay', transport);

    // Relay path: the transport-registry calls emit with explicit transports:[transportName].
    // This simulates what transport-registry.ts does when forwarding an inbound message.
    await bus.emit(LocalOnlyNs.subjects.updated, { value: 'relayed' }, { transports: ['dtv-transport-relay'] });

    const eventMessages = transport.messages.filter((m) => m.type === 'event');
    expect(eventMessages).toHaveLength(1);
    expect(eventMessages[0]).toMatchObject({
      type: 'event',
      subject: 'updated',
      namespace: 'dtv-local-only',
      payload: { value: 'relayed' },
    });
  });
});

/**
 * The dispatching surface every namespace-scoped bus wrapper has to expose.
 *
 * Spelled structurally so one call site can drive a scoped bus and a filtered
 * bus alike: their generic `emit` signatures do not form a callable union, and
 * what is under test here is the option's fate, not subject inference.
 */
type WrapperBus = {
  /**
   * Emit the wrapper-test subject.
   * @param subject - Subject to emit on.
   * @param payload - Event payload.
   * @param options - Emit options whose routing must reach the bus intact.
   * @returns Promise resolving once the emission has been dispatched.
   */
  emit(subject: typeof DefaultNs.subjects.updated, payload: { value: string }, options?: EmitOptions): Promise<void>;
};

describe('emit options survive the namespace-scoped bus wrappers', () => {
  let bus: ReturnType<typeof createBusInstance>;
  let transport: MockTransport;

  /**
   * Count the events this transport was asked to relay.
   * @returns Number of recorded event messages.
   */
  const relayedEvents = (): number => transport.messages.filter((m) => m.type === 'event').length;

  beforeEach(() => {
    // A namespace that relays by default: the control emission below then
    // proves the wrapper can reach the transport at all, so a silence under
    // `transports: []` is the option's doing and not the wrapper's.
    ({ bus, transport } = createTestSetup(DefaultNs, 'dtv-transport-wrapper'));
  });

  afterEach(() => {
    transport.clear();
  });

  it.each<readonly [string, (root: ReturnType<typeof createBusInstance>) => WrapperBus]>([
    ['scoped bus', (root) => root.scoped(root.registerNamespace(DefaultNs))],
    ['filtered bus', (root) => root.withFilter({ value: 'irrelevant' })],
    [
      'filtered bus derived from a scoped bus',
      (root) => root.scoped(root.registerNamespace(DefaultNs)).withFilter({ value: 'irrelevant' }),
    ],
  ])('honours an explicit local-only routing option through a %s', async (_label, createWrapper) => {
    const wrapper = createWrapper(bus);
    const received: string[] = [];
    bus.on(DefaultNs.subjects.updated, ({ payload }) => {
      received.push(payload.value);
    });

    await wrapper.emit(DefaultNs.subjects.updated, { value: 'relayed' });
    expect(relayedEvents()).toBe(1);

    await wrapper.emit(DefaultNs.subjects.updated, { value: 'local-only' }, { transports: [] });

    // The option is the only difference between the two emissions, so the
    // second one leaving no trace on the transport is what proves the wrapper
    // forwarded it rather than dropping it.
    expect(relayedEvents()).toBe(1);
    // And the message itself was still emitted — locally, which is the point.
    expect(received).toEqual(['relayed', 'local-only']);
  });
});

describe('createBusNamespace — defaultTransports carried through definition', () => {
  it('stores defaultTransports on the namespace definition', () => {
    const ns = createBusNamespace(
      'dtv-carried',
      { event: z.object({ id: z.string() }) },
      { defaultTransports: 'local-only' },
    );
    expect(ns.defaultTransports).toBe('local-only');
  });

  it('omits defaultTransports when not specified', () => {
    const ns = createBusNamespace('dtv-no-default', { event: z.object({ id: z.string() }) });
    expect(ns.defaultTransports).toBeUndefined();
  });

  it('supports legacy NamespaceRegistrationOptions (busValidationMode) without defaultTransports', () => {
    const ns = createBusNamespace(
      'dtv-legacy-options',
      { event: z.object({ id: z.string() }) },
      { busValidationMode: 'skip' },
    );
    expect(ns.options).toEqual({ busValidationMode: 'skip' });
    expect(ns.defaultTransports).toBeUndefined();
  });

  it('stores subject-level defaultTransports through the public schema wrapper', () => {
    expect(SubjectDefaultNs.subjects.event.$meta.defaultTransports).toBe('local-only');
  });
});

describe('namespace-registry getDefaultTransports', () => {
  it('returns local-only for a registered namespace with local-only default', () => {
    const bus = createBusInstance();
    bus.registerNamespace(LocalOnlyNs);
    const registry = bus.getContext().namespaceRegistry;
    expect(registry.getDefaultTransports('dtv-local-only.updated')).toBe('local-only');
  });

  it('returns all for a registered namespace with all default', () => {
    const bus = createBusInstance();
    bus.registerNamespace(AllNs);
    const registry = bus.getContext().namespaceRegistry;
    expect(registry.getDefaultTransports('dtv-all.updated')).toBe('all');
  });

  it('returns all (implicit default) for a namespace with no defaultTransports', () => {
    const bus = createBusInstance();
    bus.registerNamespace(DefaultNs);
    const registry = bus.getContext().namespaceRegistry;
    expect(registry.getDefaultTransports('dtv-default.updated')).toBe('all');
  });

  it('returns all for an unregistered subject', () => {
    const bus = createBusInstance();
    const registry = bus.getContext().namespaceRegistry;
    expect(registry.getDefaultTransports('dtv-nonexistent.subject')).toBe('all');
  });
});
