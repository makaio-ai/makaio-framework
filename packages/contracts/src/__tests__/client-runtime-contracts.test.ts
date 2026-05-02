/**
 * Tests for `client.runtime.observe` and `client.runtime.started` contract shapes.
 *
 * Covers schema validation for the request/response pair and the event payload,
 * as well as bus subject registration for both subjects.
 */
import { describe, expect, it } from 'vitest';
import {
  ClientRuntimeEvidenceBaseSchema,
  ClientRuntimeObserveSchema,
  ClientRuntimeSourceSchema,
  ClientRuntimeStartedSchema,
  ClientSubjects,
} from '@makaio/contracts/client';

// ---------------------------------------------------------------------------
// Shared fixture helpers
// ---------------------------------------------------------------------------

function makeSource(overrides?: Record<string, unknown>) {
  return {
    layer: 'adapter',
    producer: 'claude-code-adapter',
    ...overrides,
  };
}

function makeObserveRequest(overrides?: Record<string, unknown>) {
  return {
    clientId: 'claude-code',
    source: makeSource(),
    observedAt: 1_713_795_200_000,
    pid: 12345,
    ...overrides,
  };
}

function makeStartedEvent(overrides?: Record<string, unknown>) {
  return {
    clientRuntimeId: 'runtime-abc-123',
    clientId: 'claude-code',
    status: 'observed',
    source: makeSource(),
    observedAt: 1_713_795_200_000,
    pid: 12345,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// ClientRuntimeSourceSchema
// ---------------------------------------------------------------------------

describe('ClientRuntimeSourceSchema', () => {
  it('accepts all valid layer values', () => {
    const layers = ['supervisor', 'adapter', 'client-hook', 'statusline', 'cli-wrapper'] as const;

    for (const layer of layers) {
      expect(ClientRuntimeSourceSchema.safeParse({ layer, producer: 'some-producer' }).success).toBe(true);
    }
  });

  it('rejects an unknown layer', () => {
    expect(ClientRuntimeSourceSchema.safeParse({ layer: 'unknown', producer: 'some-producer' }).success).toBe(false);
  });

  it('rejects an empty producer string', () => {
    expect(ClientRuntimeSourceSchema.safeParse({ layer: 'adapter', producer: '' }).success).toBe(false);
  });

  it('rejects a whitespace-only producer string', () => {
    expect(ClientRuntimeSourceSchema.safeParse({ layer: 'adapter', producer: '   ' }).success).toBe(false);
  });

  it('rejects a missing producer field', () => {
    expect(ClientRuntimeSourceSchema.safeParse({ layer: 'adapter' }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ClientRuntimeEvidenceBaseSchema
// ---------------------------------------------------------------------------

describe('ClientRuntimeEvidenceBaseSchema', () => {
  it('accepts an empty object (all fields optional)', () => {
    expect(ClientRuntimeEvidenceBaseSchema.safeParse({}).success).toBe(true);
  });

  it('accepts all evidence fields together', () => {
    const result = ClientRuntimeEvidenceBaseSchema.parse({
      supervisorSessionId: 'sup-session-1',
      pid: 12345,
      parentPid: 1000,
      adapterSessionId: 'adapter-session-1',
      sessionId: 'framework-session-1',
      cwd: '/home/user/project',
      argv: ['claude', '--dangerously-skip-permissions'],
      metadata: { extra: 'value' },
    });

    expect(result.supervisorSessionId).toBe('sup-session-1');
    expect(result.pid).toBe(12345);
    expect(result.parentPid).toBe(1000);
    expect(result.adapterSessionId).toBe('adapter-session-1');
    expect(result.sessionId).toBe('framework-session-1');
    expect(result.cwd).toBe('/home/user/project');
    expect(result.argv).toEqual(['claude', '--dangerously-skip-permissions']);
    expect(result.metadata).toEqual({ extra: 'value' });
  });

  it('rejects a non-integer pid', () => {
    expect(ClientRuntimeEvidenceBaseSchema.safeParse({ pid: 12345.5 }).success).toBe(false);
  });

  it('rejects a zero pid (must be positive)', () => {
    expect(ClientRuntimeEvidenceBaseSchema.safeParse({ pid: 0 }).success).toBe(false);
  });

  it('rejects a negative pid', () => {
    expect(ClientRuntimeEvidenceBaseSchema.safeParse({ pid: -1 }).success).toBe(false);
  });

  it('rejects empty hard-evidence string fields', () => {
    expect(ClientRuntimeEvidenceBaseSchema.safeParse({ supervisorSessionId: '' }).success).toBe(false);
    expect(ClientRuntimeEvidenceBaseSchema.safeParse({ adapterSessionId: '   ' }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// client.runtime.observe request
// ---------------------------------------------------------------------------

describe('ClientRuntimeObserveSchema.request', () => {
  it('accepts a minimal valid request (pid as evidence)', () => {
    const result = ClientRuntimeObserveSchema.request.safeParse(makeObserveRequest());

    expect(result.success).toBe(true);
  });

  it('accepts a request with supervisorSessionId as evidence', () => {
    const result = ClientRuntimeObserveSchema.request.safeParse(
      makeObserveRequest({ pid: undefined, supervisorSessionId: 'sup-session-1' }),
    );

    expect(result.success).toBe(true);
  });

  it('accepts a request with adapterSessionId as evidence', () => {
    const result = ClientRuntimeObserveSchema.request.safeParse(
      makeObserveRequest({ pid: undefined, adapterSessionId: 'adapter-session-1' }),
    );

    expect(result.success).toBe(true);
  });

  it('accepts a fully populated request', () => {
    const result = ClientRuntimeObserveSchema.request.parse(
      makeObserveRequest({
        supervisorSessionId: 'sup-session-1',
        pid: 12345,
        parentPid: 1000,
        adapterSessionId: 'adapter-session-1',
        sessionId: 'framework-session-1',
        cwd: '/home/user/project',
        argv: ['claude'],
        metadata: { env: 'production' },
      }),
    );

    expect(result.clientId).toBe('claude-code');
    expect(result.source.layer).toBe('adapter');
    expect(result.source.producer).toBe('claude-code-adapter');
    expect(result.observedAt).toBe(1_713_795_200_000);
    expect(result.pid).toBe(12345);
    expect(result.cwd).toBe('/home/user/project');
  });

  it('rejects a request with an empty clientId', () => {
    expect(ClientRuntimeObserveSchema.request.safeParse(makeObserveRequest({ clientId: '' })).success).toBe(false);
  });

  it('rejects a request with a whitespace-only clientId', () => {
    expect(ClientRuntimeObserveSchema.request.safeParse(makeObserveRequest({ clientId: '   ' })).success).toBe(false);
  });

  it('rejects a request with a negative observedAt timestamp', () => {
    expect(ClientRuntimeObserveSchema.request.safeParse(makeObserveRequest({ observedAt: -1 })).success).toBe(false);
  });

  it('rejects a request with a non-integer observedAt timestamp', () => {
    expect(
      ClientRuntimeObserveSchema.request.safeParse(makeObserveRequest({ observedAt: 1_713_795_200.5 })).success,
    ).toBe(false);
  });

  it('rejects a request with a non-finite observedAt timestamp', () => {
    expect(ClientRuntimeObserveSchema.request.safeParse(makeObserveRequest({ observedAt: Infinity })).success).toBe(
      false,
    );
  });

  it('rejects a request with a missing source', () => {
    const { source: _source, ...withoutSource } = makeObserveRequest();

    expect(ClientRuntimeObserveSchema.request.safeParse(withoutSource).success).toBe(false);
  });

  // RO-2: hard-evidence invariant — at least one of supervisorSessionId, pid,
  // or adapterSessionId must be present.
  it('rejects a request with none of the three hard-evidence fields (RO-2)', () => {
    const { pid: _pid, ...withoutPid } = makeObserveRequest();
    const result = ClientRuntimeObserveSchema.request.safeParse(withoutPid);

    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages).toContain(
        'At least one hard-evidence field is required (supervisorSessionId, pid, or adapterSessionId)',
      );
    }
  });
});

// ---------------------------------------------------------------------------
// client.runtime.observe response
// ---------------------------------------------------------------------------

describe('ClientRuntimeObserveSchema.response', () => {
  it('accepts a valid response', () => {
    const result = ClientRuntimeObserveSchema.response.parse({
      clientRuntimeId: 'runtime-abc-123',
      created: true,
      promoted: false,
    });

    expect(result.clientRuntimeId).toBe('runtime-abc-123');
    expect(result.created).toBe(true);
    expect(result.promoted).toBe(false);
  });

  it('rejects a response with an empty clientRuntimeId', () => {
    expect(
      ClientRuntimeObserveSchema.response.safeParse({
        clientRuntimeId: '',
        created: false,
        promoted: false,
      }).success,
    ).toBe(false);
  });

  it('rejects a response missing the created flag', () => {
    expect(
      ClientRuntimeObserveSchema.response.safeParse({
        clientRuntimeId: 'runtime-abc-123',
        promoted: false,
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// client.runtime.started event
// ---------------------------------------------------------------------------

describe('ClientRuntimeStartedSchema', () => {
  it('accepts a minimal valid event', () => {
    expect(ClientRuntimeStartedSchema.safeParse(makeStartedEvent()).success).toBe(true);
  });

  it('accepts status "observed"', () => {
    const result = ClientRuntimeStartedSchema.parse(makeStartedEvent({ status: 'observed' }));

    expect(result.status).toBe('observed');
  });

  it('accepts status "started"', () => {
    const result = ClientRuntimeStartedSchema.parse(makeStartedEvent({ status: 'started' }));

    expect(result.status).toBe('started');
  });

  it('rejects an unknown status', () => {
    expect(ClientRuntimeStartedSchema.safeParse(makeStartedEvent({ status: 'stopped' })).success).toBe(false);
  });

  it('accepts a fully populated event', () => {
    const result = ClientRuntimeStartedSchema.parse(
      makeStartedEvent({
        supervisorSessionId: 'sup-session-1',
        parentPid: 1000,
        adapterSessionId: 'adapter-session-1',
        sessionId: 'framework-session-1',
        cwd: '/home/user/project',
        argv: ['claude', '--no-color'],
        metadata: { hook: 'PostToolUse' },
      }),
    );

    expect(result.clientRuntimeId).toBe('runtime-abc-123');
    expect(result.clientId).toBe('claude-code');
    expect(result.source.layer).toBe('adapter');
    expect(result.supervisorSessionId).toBe('sup-session-1');
    expect(result.cwd).toBe('/home/user/project');
    expect(result.argv).toEqual(['claude', '--no-color']);
  });

  it('rejects an event with an empty clientRuntimeId', () => {
    expect(ClientRuntimeStartedSchema.safeParse(makeStartedEvent({ clientRuntimeId: '' })).success).toBe(false);
  });

  it('rejects an event with an empty clientId', () => {
    expect(ClientRuntimeStartedSchema.safeParse(makeStartedEvent({ clientId: '' })).success).toBe(false);
  });

  it('rejects an event with a negative observedAt timestamp', () => {
    expect(ClientRuntimeStartedSchema.safeParse(makeStartedEvent({ observedAt: -1 })).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Bus subject registration
// ---------------------------------------------------------------------------

describe('ClientSubjects — runtime observation subjects', () => {
  it('exposes client.runtime.observe with the correct subject and namespace', () => {
    expect(ClientSubjects.runtime.observe.subject).toBe('runtime.observe');
    expect(ClientSubjects.runtime.observe.$meta.namespace).toBe('client');
  });

  it('exposes client.runtime.started with the correct subject and namespace', () => {
    expect(ClientSubjects.runtime.started.subject).toBe('runtime.started');
    expect(ClientSubjects.runtime.started.$meta.namespace).toBe('client');
  });

  it('does not collide with existing client.session subjects', () => {
    expect(ClientSubjects.session.started.subject).toBe('session.started');
    expect(ClientSubjects.session.started.$meta.namespace).toBe('client');
  });
});
