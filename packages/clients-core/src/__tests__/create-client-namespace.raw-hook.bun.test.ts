import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { z } from 'zod';
import { MakaioBus } from '@makaio/bus-core';
import { createClientNamespace } from '../create-client-namespace.js';
import {
  createRawClientHookReceivedSubject,
  canonicalizeClientId,
  emitBestEffort,
  pickNonEmptyString,
  buildClientSessionBase,
  RawClientHookPayloadSchema,
} from '../client-session-observed-semantics.js';

const ExtraStatuslineSchema = z.object({ status: z.string() });
const ORIGINAL_DEBUG = process.env.DEBUG;
const ORIGINAL_MAKAIO_DEBUG = process.env.MAKAIO_DEBUG;
let clientIdCounter = 0;

function nextClientId(label: string): string {
  clientIdCounter += 1;
  return `raw-hook-${label}-${clientIdCounter}`;
}

function resetDebugEnv(): void {
  if (ORIGINAL_DEBUG === undefined) {
    delete process.env.DEBUG;
  } else {
    process.env.DEBUG = ORIGINAL_DEBUG;
  }
  if (ORIGINAL_MAKAIO_DEBUG === undefined) {
    delete process.env.MAKAIO_DEBUG;
  } else {
    process.env.MAKAIO_DEBUG = ORIGINAL_MAKAIO_DEBUG;
  }
}

async function waitForBestEffortCatch(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  resetDebugEnv();
  mock.restore();
});

describe('createClientNamespace', () => {
  it('registers the hook.received subject under client:<clientId>', () => {
    const clientId = nextClientId('codex');
    const { subjects, namespaceDomain } = createClientNamespace(clientId);

    expect(namespaceDomain).toBe(`client:${clientId}`);
    expect(subjects.hook.received.subject).toBe('hook.received');
    expect(subjects.hook.received.$meta.namespace).toBe(`client:${clientId}`);

    // Namespace is registered on the singleton bus
    const schema = MakaioBus.getSchema(subjects.hook.received);
    expect(schema).toBeDefined();
  });

  it('produces distinct namespace domains for different client IDs', () => {
    const codexId = nextClientId('codex-distinct');
    const claudeCodeId = nextClientId('claude-code-distinct');
    const codex = createClientNamespace(codexId);
    const claudeCode = createClientNamespace(claudeCodeId);

    expect(codex.namespaceDomain).toBe(`client:${codexId}`);
    expect(claudeCode.namespaceDomain).toBe(`client:${claudeCodeId}`);
    expect(codex.subjects.hook.received.$meta.namespace).toBe(`client:${codexId}`);
    expect(claudeCode.subjects.hook.received.$meta.namespace).toBe(`client:${claudeCodeId}`);
  });

  it('subjects carry the full qualified subject path', () => {
    const clientId = nextClientId('gemini');
    const { subjects } = createClientNamespace(clientId);

    // Subject key is the local part, full path is namespace + "." + subject
    expect(subjects.hook.received.subject).toBe('hook.received');
    expect(subjects.hook.received.$meta.namespace).toBe(`client:${clientId}`);
  });

  it('hook.received schema validates a well-formed raw hook payload', () => {
    const validPayload = {
      eventName: 'PreToolUse',
      receivedAt: 1_713_795_200_000,
      payload: { tool: 'bash', command: 'ls' },
      metadata: { pid: 12_345 },
    };

    const result = RawClientHookPayloadSchema.safeParse(validPayload);
    expect(result.success).toBe(true);
  });

  it('hook.received schema validates a payload without optional metadata', () => {
    const minimalPayload = {
      eventName: 'Stop',
      receivedAt: 1_713_795_200_000,
      payload: { exit_code: 0 },
    };

    const result = RawClientHookPayloadSchema.safeParse(minimalPayload);
    expect(result.success).toBe(true);
  });

  it('hook.received schema rejects payloads missing required fields', () => {
    const missingEventName = {
      receivedAt: 1_713_795_200_000,
      payload: {},
    };

    const result = RawClientHookPayloadSchema.safeParse(missingEventName);
    expect(result.success).toBe(false);
  });

  it('hook.received schema rejects a non-object payload field', () => {
    const nonObjectPayload = {
      eventName: 'PostToolUse',
      receivedAt: 1_713_795_200_000,
      payload: 'not-an-object',
    };

    const result = RawClientHookPayloadSchema.safeParse(nonObjectPayload);
    expect(result.success).toBe(false);
  });

  it('hook.received schema rejects negative receivedAt timestamps', () => {
    const negativeTimestamp = {
      eventName: 'Stop',
      receivedAt: -1,
      payload: {},
    };

    const result = RawClientHookPayloadSchema.safeParse(negativeTimestamp);
    expect(result.success).toBe(false);
  });

  it('picks and trims non-empty strings from raw hook payloads', () => {
    expect(pickNonEmptyString({ prompt: ' hello ' }, 'prompt')).toBe('hello');
    expect(pickNonEmptyString({ prompt: '   ' }, 'prompt')).toBeUndefined();
    expect(pickNonEmptyString({ prompt: 42 }, 'prompt')).toBeUndefined();
  });

  it('throws when clientId is empty', () => {
    expect(() => createClientNamespace('')).toThrow('[createClientNamespace] clientId must be a non-empty string');
  });

  it('throws when clientId is empty after the optional namespace prefix', () => {
    expect(() => createClientNamespace(' client: ')).toThrow(
      '[createClientNamespace] clientId must be a non-empty string',
    );
  });

  it('canonicalizes whitespace, case, and an optional client: prefix before registering the namespace', () => {
    const clientId = nextClientId('canonical');
    const { subjects, namespaceDomain } = createClientNamespace(` client:${clientId.toUpperCase()} `);

    expect(namespaceDomain).toBe(`client:${clientId}`);
    expect(subjects.hook.received.$meta.namespace).toBe(`client:${clientId}`);
  });

  it('maps differently cased prefixed IDs to the same canonical namespace', () => {
    const clientId = nextClientId('prefixed');
    const first = createClientNamespace(`client:${clientId.toUpperCase()}`);
    const second = createClientNamespace(`client:${clientId}`);

    expect(first.namespaceDomain).toBe(`client:${clientId}`);
    expect(second.namespaceDomain).toBe(`client:${clientId}`);
    expect(second.subjects.hook.received).toBe(first.subjects.hook.received);
  });

  it('rejects whitespace and disallowed symbols inside clientId', () => {
    expect(() => createClientNamespace('bad client')).toThrow(
      '[createClientNamespace] clientId must contain only lowercase letters, numbers, and hyphens after an optional client: prefix',
    );
    expect(() => createClientNamespace('client:bad/client')).toThrow(
      '[createClientNamespace] clientId must contain only lowercase letters, numbers, and hyphens after an optional client: prefix',
    );
  });

  it('normalizes whitespace around clientId before registering the namespace', () => {
    const clientId = nextClientId('trim');
    const { subjects, namespaceDomain } = createClientNamespace(` ${clientId} `);

    expect(namespaceDomain).toBe(`client:${clientId}`);
    expect(subjects.hook.received.$meta.namespace).toBe(`client:${clientId}`);
  });

  it('canonicalizes client IDs through the exported helper without requiring a caller label', () => {
    expect(canonicalizeClientId(' client:Codex ')).toBe('codex');
    expect(() => canonicalizeClientId('client:')).toThrow('[canonicalizeClientId] clientId must be a non-empty string');
  });

  it('emits and receives a raw hook event on the registered subject', async () => {
    const { subjects } = createClientNamespace(nextClientId('emit'));

    const received: unknown[] = [];
    const cleanup = MakaioBus.on(subjects.hook.received, ({ payload }) => {
      received.push(payload);
    });

    await MakaioBus.emit(subjects.hook.received, {
      eventName: 'UserPromptSubmit',
      receivedAt: 1_713_795_200_000,
      payload: { session_id: 'sess-1', prompt: 'hello' },
    });

    cleanup();

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      eventName: 'UserPromptSubmit',
      receivedAt: 1_713_795_200_000,
    });
  });

  describe('additionalSchemas', () => {
    it('registers extra subjects alongside hook.received', () => {
      const clientId = nextClientId('with-extras');
      const { subjects, namespaceDomain } = createClientNamespace(clientId, {
        'statusline.received': ExtraStatuslineSchema,
      });

      expect(namespaceDomain).toBe(`client:${clientId}`);
      expect(subjects.hook.received.subject).toBe('hook.received');
      expect(subjects.hook.received.$meta.namespace).toBe(`client:${clientId}`);
      expect(subjects.statusline.received.subject).toBe('statusline.received');
      expect(subjects.statusline.received.$meta.namespace).toBe(`client:${clientId}`);

      const schema = MakaioBus.getSchema(subjects.statusline.received);
      expect(schema).toBeDefined();
    });

    it('emits and receives events on an additional subject', async () => {
      const { subjects } = createClientNamespace(nextClientId('extras-emit'), {
        'statusline.received': ExtraStatuslineSchema,
      });

      const received: unknown[] = [];
      const cleanup = MakaioBus.on(subjects.statusline.received, ({ payload }) => {
        received.push(payload);
      });

      await MakaioBus.emit(subjects.statusline.received, { status: 'active' });

      cleanup();

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ status: 'active' });
    });

    it('hook.received remains accessible when additionalSchemas are provided', async () => {
      const { subjects } = createClientNamespace(nextClientId('extras-hook'), {
        'statusline.received': ExtraStatuslineSchema,
      });

      const received: unknown[] = [];
      const cleanup = MakaioBus.on(subjects.hook.received, ({ payload }) => {
        received.push(payload);
      });

      await MakaioBus.emit(subjects.hook.received, {
        eventName: 'Stop',
        receivedAt: 1_713_795_200_000,
        payload: {},
      });

      cleanup();

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ eventName: 'Stop' });
    });

    it('throws when a later call asks for additional subjects missing from the existing namespace', () => {
      const clientId = nextClientId('late-extra');
      createClientNamespace(clientId);

      expect(() =>
        createClientNamespace(clientId, {
          'statusline.received': ExtraStatuslineSchema,
        }),
      ).toThrow(
        `[createClientNamespace] client:${clientId} was already registered without required subjects: statusline.received`,
      );
    });
  });

  describe('createRawClientHookReceivedSubject', () => {
    it('builds a non-owning hook.received subject without registering a namespace', () => {
      const clientId = nextClientId('ad-hoc');
      const subject = createRawClientHookReceivedSubject(clientId);

      expect(subject.subject).toBe('hook.received');
      expect(subject.$meta.namespace).toBe(`client:${clientId}`);
      expect(MakaioBus.getSchema(subject)).toBeUndefined();
    });

    it('can emit to a concrete owner namespace without re-registering it', async () => {
      const clientId = nextClientId('owner-namespace');
      const { subjects } = createClientNamespace(clientId, {
        'statusline.received': ExtraStatuslineSchema,
      });
      const subject = createRawClientHookReceivedSubject(clientId);

      const received: unknown[] = [];
      const cleanup = MakaioBus.on(subjects.hook.received, ({ payload }) => {
        received.push(payload);
      });

      await MakaioBus.emit(subject, {
        eventName: 'Stop',
        receivedAt: 1_713_795_200_000,
        payload: {},
      });

      cleanup();

      expect(received).toHaveLength(1);
      expect(subjects.statusline.received.subject).toBe('statusline.received');
    });

    it('throws when clientId is whitespace-only', () => {
      expect(() => createRawClientHookReceivedSubject('   ')).toThrow(
        '[createRawClientHookReceivedSubject] clientId must be a non-empty string',
      );
    });

    it('canonicalizes whitespace, case, and an optional client: prefix', () => {
      const clientId = nextClientId('raw-canonical');
      const subject = createRawClientHookReceivedSubject(` client:${clientId.toUpperCase()} `);

      expect(subject.$meta.namespace).toBe(`client:${clientId}`);
    });
  });

  describe('emitBestEffort', () => {
    it('invokes emission thunks immediately', () => {
      const calls: string[] = [];

      emitBestEffort(async () => {
        calls.push('called');
      });

      expect(calls).toEqual(['called']);
    });

    it('swallows emission errors without production logging', async () => {
      delete process.env.DEBUG;
      delete process.env.MAKAIO_DEBUG;
      const debugSpy = spyOn(console, 'debug').mockImplementation(() => undefined);

      emitBestEffort(async () => {
        throw new Error('missing handler');
      });
      await waitForBestEffortCatch();

      expect(debugSpy).not.toHaveBeenCalled();
    });

    it('swallows synchronous emission errors without disrupting caller flow', async () => {
      const error = new Error('sync failure');

      expect(() => {
        emitBestEffort(() => {
          throw error;
        });
      }).not.toThrow();

      await waitForBestEffortCatch();
    });

    it('logs swallowed emission errors when DEBUG is set', async () => {
      process.env.DEBUG = '1';
      delete process.env.MAKAIO_DEBUG;
      const error = new Error('missing handler');
      const debugSpy = spyOn(console, 'debug').mockImplementation(() => undefined);

      emitBestEffort(async () => {
        throw error;
      });
      await waitForBestEffortCatch();

      expect(debugSpy).toHaveBeenCalledWith('[emitBestEffort] observed-semantics emission failed', error);
    });

    it('logs swallowed emission errors when MAKAIO_DEBUG is set', async () => {
      delete process.env.DEBUG;
      process.env.MAKAIO_DEBUG = '1';
      const error = new Error('missing handler');
      const debugSpy = spyOn(console, 'debug').mockImplementation(() => undefined);

      emitBestEffort(async () => {
        throw error;
      });
      await waitForBestEffortCatch();

      expect(debugSpy).toHaveBeenCalledWith('[emitBestEffort] observed-semantics emission failed', error);
    });
  });

  // RS-9: buildClientSessionBase unit tests
  describe('buildClientSessionBase', () => {
    it('always stamps source as adapter-derived', () => {
      const result = buildClientSessionBase({ clientId: 'codex' });

      expect(result.source).toBe('adapter-derived');
    });

    it('stamps observedAt as a recent epoch millisecond timestamp', () => {
      const before = Date.now();
      const result = buildClientSessionBase({ clientId: 'codex' });
      const after = Date.now();

      expect(result.observedAt).toBeGreaterThanOrEqual(before);
      expect(result.observedAt).toBeLessThanOrEqual(after);
    });

    it('passes clientId through unchanged', () => {
      const result = buildClientSessionBase({ clientId: 'claude-code' });

      expect(result.clientId).toBe('claude-code');
    });

    it('omits sessionId when not provided', () => {
      const result = buildClientSessionBase({ clientId: 'codex' });

      expect(result).not.toHaveProperty('sessionId');
    });

    it('omits adapterSessionId when not provided', () => {
      const result = buildClientSessionBase({ clientId: 'codex' });

      expect(result).not.toHaveProperty('adapterSessionId');
    });

    it('omits sessionId when explicitly undefined', () => {
      const result = buildClientSessionBase({ clientId: 'codex', sessionId: undefined });

      expect(result).not.toHaveProperty('sessionId');
    });

    it('omits adapterSessionId when explicitly undefined', () => {
      const result = buildClientSessionBase({ clientId: 'codex', adapterSessionId: undefined });

      expect(result).not.toHaveProperty('adapterSessionId');
    });

    it('spreads sessionId when provided', () => {
      const result = buildClientSessionBase({ clientId: 'codex', sessionId: 'sess-abc' });

      expect(result.sessionId).toBe('sess-abc');
    });

    it('spreads adapterSessionId when provided', () => {
      const result = buildClientSessionBase({ clientId: 'codex', adapterSessionId: 'adapter-xyz' });

      expect(result.adapterSessionId).toBe('adapter-xyz');
    });

    it('spreads both sessionId and adapterSessionId when both are provided', () => {
      const result = buildClientSessionBase({
        clientId: 'codex',
        sessionId: 'sess-abc',
        adapterSessionId: 'adapter-xyz',
      });

      expect(result.sessionId).toBe('sess-abc');
      expect(result.adapterSessionId).toBe('adapter-xyz');
    });
  });

  // RS-10: safeEmitRuntimeObserve is an unexported private function inside
  // extensions/client-hooks/src/cli/client-hook-command.ts, which
  // belongs to a different package (@makaio/client-hooks) than this test file
  // (@makaio/clients-core). It is not exported from that module and is therefore
  // not importable here without adding a cross-package dev dependency. Coverage
  // for safeEmitRuntimeObserve lives in its own package's test suite at
  // extensions/client-hooks/src/__tests__/client-hook-command.test.ts.
});
