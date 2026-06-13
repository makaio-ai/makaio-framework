/**
 * Tests for session.registerExternal handler.
 *
 * Covers:
 * - Creates a new session with adapter identity stamped (adapterName, adapterSessionId).
 * - Returns created: true on first registration.
 * - Returns created: false on idempotent re-registration (same adapterName + adapterSessionId).
 * - Different identity pairs each create distinct sessions.
 * - public session.create still rejects adapter identity fields (contract isolation).
 * - lastClientIdentityObservation is persisted when provided.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { SessionSubjects } from '@makaio/contracts';
import { MakaioSessionService } from '../session-service.js';
import { registerMemorySessionStorage } from '../storage/memory-handler.js';
import { registerMemorySessionEventStorage } from '../session-events/memory-handler.js';
import { SessionStorageSubjects } from '../storage/namespace.js';

describe('session.registerExternal', () => {
  let sessionService: MakaioSessionService;
  let sessionStorageCleanup: () => void;
  let eventStorageCleanup: () => void;

  beforeEach(async () => {
    sessionStorageCleanup = registerMemorySessionStorage(MakaioBus);
    eventStorageCleanup = registerMemorySessionEventStorage(MakaioBus);
    sessionService = new MakaioSessionService(MakaioBus);
    await sessionService.init();
  });

  afterEach(() => {
    sessionService.destroy();
    eventStorageCleanup();
    sessionStorageCleanup();
  });

  // ===========================================================================
  // Creation with adapter identity
  // ===========================================================================

  it('creates a new session stamped with adapterName and adapterSessionId', async () => {
    const { sessionId, created } = await MakaioBus.request(SessionSubjects.registerExternal, {
      adapterName: 'my-mcp-adapter',
      adapterSessionId: 'ext-session-001',
    });

    expect(sessionId).toBeDefined();
    expect(created).toBe(true);

    const { session } = await MakaioBus.request(SessionSubjects.get, { sessionId });

    expect(session).not.toBeNull();
    expect(session?.adapterName).toBe('my-mcp-adapter');
    expect(session?.adapterSessionId).toBe('ext-session-001');
    expect(session?.status).toBe('active');
    // adapterId must be absent — external sessions have no in-runtime adapter instance
    expect(session?.adapterId).toBeUndefined();
  });

  it('persists lastClientIdentityObservation when provided', async () => {
    const observation = {
      clientId: 'my-client',
      source: 'mcp',
      kind: 'mcp-token',
      observedAt: Date.now(),
      payload: { token: 'abc' },
    };

    const { sessionId } = await MakaioBus.request(SessionSubjects.registerExternal, {
      adapterName: 'my-mcp-adapter',
      adapterSessionId: 'ext-session-obs-001',
      lastClientIdentityObservation: observation,
    });

    const { session } = await MakaioBus.request(SessionSubjects.get, { sessionId });

    expect(session?.lastClientIdentityObservation).toEqual(observation);
  });

  it('forwards caller-facing creation fields (title, targetWorkingDirectory)', async () => {
    const { sessionId } = await MakaioBus.request(SessionSubjects.registerExternal, {
      adapterName: 'my-mcp-adapter',
      adapterSessionId: 'ext-session-fields-001',
      title: 'My external session',
      targetWorkingDirectory: '/projects/my-project',
    });

    const { session } = await MakaioBus.request(SessionSubjects.get, { sessionId });

    expect(session?.title).toBe('My external session');
    expect(session?.targetWorkingDirectory).toBe('/projects/my-project');
  });

  it('emits session.created event', async () => {
    const createdEvents: string[] = [];
    const cleanup = MakaioBus.on(SessionSubjects.created, (ctx) => {
      createdEvents.push(ctx.payload.sessionId);
    });

    const { sessionId } = await MakaioBus.request(SessionSubjects.registerExternal, {
      adapterName: 'my-mcp-adapter',
      adapterSessionId: 'ext-session-event-001',
    });

    // allow event propagation
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(createdEvents).toContain(sessionId);
    cleanup();
  });

  // ===========================================================================
  // Idempotency
  // ===========================================================================

  it('returns created: false and the same sessionId on second call with identical identity', async () => {
    const first = await MakaioBus.request(SessionSubjects.registerExternal, {
      adapterName: 'my-mcp-adapter',
      adapterSessionId: 'ext-session-idempotent-001',
    });

    expect(first.created).toBe(true);

    const second = await MakaioBus.request(SessionSubjects.registerExternal, {
      adapterName: 'my-mcp-adapter',
      adapterSessionId: 'ext-session-idempotent-001',
    });

    expect(second.created).toBe(false);
    expect(second.sessionId).toBe(first.sessionId);
  });

  it('does not mutate the original session on idempotent re-registration', async () => {
    const { sessionId } = await MakaioBus.request(SessionSubjects.registerExternal, {
      adapterName: 'my-mcp-adapter',
      adapterSessionId: 'ext-session-idempotent-002',
      title: 'Original title',
    });

    const { session: before } = await MakaioBus.request(SessionSubjects.get, { sessionId });
    expect(before?.title).toBe('Original title');

    await MakaioBus.request(SessionSubjects.registerExternal, {
      adapterName: 'my-mcp-adapter',
      adapterSessionId: 'ext-session-idempotent-002',
      title: 'Attempted overwrite',
    });

    const { session: after } = await MakaioBus.request(SessionSubjects.get, { sessionId });
    // Title must not be overwritten by the second call.
    expect(after?.title).toBe('Original title');
  });

  it('resolves concurrent registrations of the same identity to a single session', async () => {
    // Both calls may pass the initial lookup before either insert lands; the
    // deterministic session ID makes them collide on the primary key so the
    // loser resolves the winner instead of creating a duplicate.
    const [first, second] = await Promise.all([
      MakaioBus.request(SessionSubjects.registerExternal, {
        adapterName: 'race-adapter',
        adapterSessionId: 'ext-race-001',
      }),
      MakaioBus.request(SessionSubjects.registerExternal, {
        adapterName: 'race-adapter',
        adapterSessionId: 'ext-race-001',
      }),
    ]);

    expect(first.sessionId).toBe(second.sessionId);
    expect([first.created, second.created].filter(Boolean)).toHaveLength(1);
  });

  it('rejects a caller-provided sessionId that collides with an unrelated session', async () => {
    const { sessionId } = await MakaioBus.request(SessionSubjects.create, {});

    await expect(
      MakaioBus.request(SessionSubjects.registerExternal, {
        sessionId,
        adapterName: 'my-mcp-adapter',
        adapterSessionId: 'ext-collision-001',
      }),
    ).rejects.toThrow(/does not carry adapter identity/);
  });

  // ===========================================================================
  // Distinct identities create distinct sessions
  // ===========================================================================

  it('creates distinct sessions for distinct (adapterName, adapterSessionId) pairs', async () => {
    const first = await MakaioBus.request(SessionSubjects.registerExternal, {
      adapterName: 'adapter-a',
      adapterSessionId: 'shared-ext-id',
    });

    const second = await MakaioBus.request(SessionSubjects.registerExternal, {
      adapterName: 'adapter-b',
      adapterSessionId: 'shared-ext-id',
    });

    // Same adapterSessionId but different adapterName → distinct sessions
    expect(first.sessionId).not.toBe(second.sessionId);
    expect(first.created).toBe(true);
    expect(second.created).toBe(true);

    const { session: sessionA } = await MakaioBus.request(SessionSubjects.get, {
      sessionId: first.sessionId,
    });
    const { session: sessionB } = await MakaioBus.request(SessionSubjects.get, {
      sessionId: second.sessionId,
    });

    expect(sessionA?.adapterName).toBe('adapter-a');
    expect(sessionB?.adapterName).toBe('adapter-b');
  });

  it('returns the original session when re-registering one adapter after another adapter shares the external ID', async () => {
    const first = await MakaioBus.request(SessionSubjects.registerExternal, {
      adapterName: 'adapter-a',
      adapterSessionId: 'shared-ext-id-reregister',
    });
    await MakaioBus.request(SessionSubjects.registerExternal, {
      adapterName: 'adapter-b',
      adapterSessionId: 'shared-ext-id-reregister',
    });

    const repeated = await MakaioBus.request(SessionSubjects.registerExternal, {
      adapterName: 'adapter-a',
      adapterSessionId: 'shared-ext-id-reregister',
    });

    expect(repeated).toEqual({ sessionId: first.sessionId, created: false });
  });

  it('preserves idempotency for caller-provided sessionId after an external ID becomes ambiguous', async () => {
    const first = await MakaioBus.request(SessionSubjects.registerExternal, {
      sessionId: 'caller-provided-adapter-a',
      adapterName: 'adapter-a',
      adapterSessionId: 'shared-ext-id-custom',
    });
    await MakaioBus.request(SessionSubjects.registerExternal, {
      adapterName: 'adapter-b',
      adapterSessionId: 'shared-ext-id-custom',
    });

    const repeated = await MakaioBus.request(SessionSubjects.registerExternal, {
      adapterName: 'adapter-a',
      adapterSessionId: 'shared-ext-id-custom',
    });

    expect(first).toEqual({ sessionId: 'caller-provided-adapter-a', created: true });
    expect(repeated).toEqual({ sessionId: 'caller-provided-adapter-a', created: false });
  });

  it('creates distinct sessions for the same adapter with different external IDs', async () => {
    const first = await MakaioBus.request(SessionSubjects.registerExternal, {
      adapterName: 'adapter-a',
      adapterSessionId: 'ext-id-aaa',
    });

    const second = await MakaioBus.request(SessionSubjects.registerExternal, {
      adapterName: 'adapter-a',
      adapterSessionId: 'ext-id-bbb',
    });

    expect(first.sessionId).not.toBe(second.sessionId);
    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
  });

  // ===========================================================================
  // Adapter identity is readable via storage lookup
  // ===========================================================================

  it('registered session is findable by adapterSessionId via storage lookup', async () => {
    const { sessionId } = await MakaioBus.request(SessionSubjects.registerExternal, {
      adapterName: 'my-mcp-adapter',
      adapterSessionId: 'ext-lookup-001',
    });

    const { session } = await MakaioBus.request(SessionStorageSubjects.getByAdapterSessionId, {
      adapterSessionId: 'ext-lookup-001',
    });

    expect(session).not.toBeNull();
    expect(session?.sessionId).toBe(sessionId);
    expect(session?.adapterName).toBe('my-mcp-adapter');
  });

  // ===========================================================================
  // session.create does not accept adapter identity fields
  // ===========================================================================

  it('session.create schema rejects adapterName and adapterSessionId', async () => {
    // The session.create request schema does not include adapterName or
    // adapterSessionId. Passing them must not stamp adapter identity on the
    // created session — they are unknown fields that Zod strips.
    const { sessionId } = await MakaioBus.request(SessionSubjects.create, {
      // @ts-expect-error — intentionally passing fields outside the create schema
      // (TypeScript reports excess properties only on the first offending field)
      adapterName: 'should-not-be-stored',
      adapterSessionId: 'ext-should-not-be-stored',
    });

    const { session } = await MakaioBus.request(SessionSubjects.get, { sessionId });

    expect(session?.adapterName).toBeUndefined();
    expect(session?.adapterSessionId).toBeUndefined();
  });
});
