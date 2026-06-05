/**
 * Tests for hook handle API surface introduced in Phase 1.
 *
 * Covers:
 * - {@link ClientHookHandleResponseSchema} schema validation and defaults
 * - {@link createRawClientHookHandleSubject} subject factory
 * - `hook.handle` namespace registration in {@link createClientNamespace}
 * - {@link deriveSessionEventDescriptors} mode propagation
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MakaioBus } from '@makaio/bus-core';
import { createClientDefinition } from '@makaio/contracts/client';
import { createClientNamespace } from '../create-client-namespace.js';
import {
  ClientHookHandleResponseSchema,
  createRawClientHookHandleSubject,
} from '../client-session-observed-semantics.js';
import { deriveSessionEventDescriptors } from '../wiring-helpers.js';

const OverrideHookSchema = z.object({ override: z.boolean() });
let clientIdCounter = 0;

function nextClientId(label: string): string {
  clientIdCounter += 1;
  return `hook-handle-${label}-${clientIdCounter}`;
}

// ---------------------------------------------------------------------------
// ClientHookHandleResponseSchema
// ---------------------------------------------------------------------------

describe('ClientHookHandleResponseSchema', () => {
  it('applies defaults when given an empty object', () => {
    const result = ClientHookHandleResponseSchema.parse({});

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('accepts a fully specified valid response', () => {
    const result = ClientHookHandleResponseSchema.parse({
      exitCode: 1,
      stdout: 'output line',
      stderr: 'error line',
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('output line');
    expect(result.stderr).toBe('error line');
  });

  it('accepts exitCode 0 (minimum valid)', () => {
    const result = ClientHookHandleResponseSchema.safeParse({ exitCode: 0 });
    expect(result.success).toBe(true);
  });

  it('accepts exitCode 255 (maximum valid)', () => {
    const result = ClientHookHandleResponseSchema.safeParse({ exitCode: 255 });
    expect(result.success).toBe(true);
  });

  it('rejects exitCode 256 (above maximum)', () => {
    const result = ClientHookHandleResponseSchema.safeParse({ exitCode: 256 });
    expect(result.success).toBe(false);
  });

  it('rejects exitCode -1 (below minimum)', () => {
    const result = ClientHookHandleResponseSchema.safeParse({ exitCode: -1 });
    expect(result.success).toBe(false);
  });

  it('rejects a non-integer exitCode', () => {
    const result = ClientHookHandleResponseSchema.safeParse({ exitCode: 1.5 });
    expect(result.success).toBe(false);
  });

  it('rejects a non-number exitCode', () => {
    const result = ClientHookHandleResponseSchema.safeParse({ exitCode: '1' });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createRawClientHookHandleSubject
// ---------------------------------------------------------------------------

describe('createRawClientHookHandleSubject', () => {
  it('returns subject string hook.handle', () => {
    const clientId = nextClientId('subject');
    const subject = createRawClientHookHandleSubject(clientId);

    expect(subject.subject).toBe('hook.handle');
  });

  it('sets namespace to client:<id>', () => {
    const clientId = nextClientId('namespace');
    const subject = createRawClientHookHandleSubject(clientId);

    expect(subject.$meta.namespace).toBe(`client:${clientId}`);
  });

  it('sets isRequest to true', () => {
    const clientId = nextClientId('is-request');
    const subject = createRawClientHookHandleSubject(clientId);

    expect(subject.$meta.isRequest).toBe(true);
  });

  it('does not register the namespace on the bus', () => {
    const clientId = nextClientId('non-owning');
    const subject = createRawClientHookHandleSubject(clientId);

    expect(MakaioBus.getSchema(subject)).toBeUndefined();
  });

  it('canonicalizes whitespace, case, and an optional client: prefix', () => {
    const clientId = nextClientId('canonical');
    const subject = createRawClientHookHandleSubject(` client:${clientId.toUpperCase()} `);

    expect(subject.$meta.namespace).toBe(`client:${clientId}`);
  });

  it('throws when clientId is whitespace-only', () => {
    expect(() => createRawClientHookHandleSubject('   ')).toThrow(
      '[createRawClientHookHandleSubject] clientId must be a non-empty string',
    );
  });

  it('throws when clientId contains disallowed characters', () => {
    expect(() => createRawClientHookHandleSubject('bad/client')).toThrow(
      'clientId must contain only lowercase letters, numbers, and hyphens',
    );
  });
});

// ---------------------------------------------------------------------------
// hook.handle namespace registration
// ---------------------------------------------------------------------------

describe('createClientNamespace — hook.handle subject', () => {
  it('registers hook.handle alongside hook.received', () => {
    const clientId = nextClientId('ns-handle');
    const { subjects } = createClientNamespace(clientId);

    expect(subjects.hook.handle.subject).toBe('hook.handle');
    expect(subjects.hook.handle.$meta.namespace).toBe(`client:${clientId}`);
  });

  it('registers hook.handle as a request subject', () => {
    const clientId = nextClientId('ns-handle-req');
    const { subjects } = createClientNamespace(clientId);

    expect(subjects.hook.handle.$meta.isRequest).toBe(true);
  });

  it('hook.handle schema is accessible from the bus after namespace registration', () => {
    const clientId = nextClientId('ns-schema');
    const { subjects } = createClientNamespace(clientId);

    const schema = MakaioBus.getSchema(subjects.hook.handle);
    expect(schema).toBeDefined();
  });

  it('rejects additionalSchemas that override hook.received', () => {
    const clientId = nextClientId('reserved-received');
    const expectedMessage = [
      `[createClientNamespace] additionalSchemas for client:${clientId}`,
      'cannot override reserved shared hook subjects: hook.received',
    ].join(' ');

    expect(() =>
      createClientNamespace(clientId, {
        'hook.received': OverrideHookSchema,
      }),
    ).toThrow(expectedMessage);
  });

  it('rejects additionalSchemas that override hook.handle', () => {
    const clientId = nextClientId('reserved-handle');
    const expectedMessage = [
      `[createClientNamespace] additionalSchemas for client:${clientId}`,
      'cannot override reserved shared hook subjects: hook.handle',
    ].join(' ');

    expect(() =>
      createClientNamespace(clientId, {
        'hook.handle': {
          request: OverrideHookSchema,
          response: OverrideHookSchema,
        },
      }),
    ).toThrow(expectedMessage);
  });
});

// ---------------------------------------------------------------------------
// deriveSessionEventDescriptors — mode propagation
// ---------------------------------------------------------------------------

describe('deriveSessionEventDescriptors — mode propagation', () => {
  it('propagates explicit mode: request for matching declarations', () => {
    const definition = createClientDefinition({
      id: 'test-handle',
      name: 'Test Handle',
      version: '0.1.0',
      defaultApprovalPolicy: 'always-ask',
      runtimeCapabilities: {
        supportsHooks: true,
        hookEvents: [{ name: 'PreToolUse', frameworkSubject: 'client.session.tool.pre', mode: 'request' }],
      },
    });

    const descriptors = deriveSessionEventDescriptors(definition);

    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]?.eventName).toBe('PreToolUse');
    expect(descriptors[0]?.mode).toBe('request');
  });

  it('defaults mode to event when no mode is declared', () => {
    const definition = createClientDefinition({
      id: 'test-event',
      name: 'Test Event',
      version: '0.1.0',
      defaultApprovalPolicy: 'always-ask',
      runtimeCapabilities: {
        supportsHooks: true,
        hookEvents: [{ name: 'SessionStart', frameworkSubject: 'client.session.started' }],
      },
    });

    const descriptors = deriveSessionEventDescriptors(definition);

    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]?.mode).toBe('event');
  });

  it('preserves declaration order and mode for mixed event/request declarations', () => {
    const definition = createClientDefinition({
      id: 'test-mixed',
      name: 'Test Mixed',
      version: '0.1.0',
      defaultApprovalPolicy: 'always-ask',
      runtimeCapabilities: {
        supportsHooks: true,
        hookEvents: [
          { name: 'SessionStart', frameworkSubject: 'client.session.started' },
          { name: 'PreToolUse', frameworkSubject: 'client.session.tool.pre', mode: 'request' },
          { name: 'PostToolUse', frameworkSubject: 'client.session.tool.post' },
        ],
      },
    });

    const descriptors = deriveSessionEventDescriptors(definition);

    expect(descriptors).toHaveLength(3);
    expect(descriptors[0]).toStrictEqual({ eventName: 'SessionStart', mode: 'event' });
    expect(descriptors[1]).toStrictEqual({ eventName: 'PreToolUse', mode: 'request' });
    expect(descriptors[2]).toStrictEqual({ eventName: 'PostToolUse', mode: 'event' });
  });

  it('excludes declarations without a frameworkSubject', () => {
    const definition = createClientDefinition({
      id: 'test-no-subject',
      name: 'Test No Subject',
      version: '0.1.0',
      defaultApprovalPolicy: 'always-ask',
      runtimeCapabilities: {
        supportsHooks: true,
        hookEvents: [{ name: 'SessionStart', frameworkSubject: 'client.session.started' }, { name: 'InternalEvent' }],
      },
    });

    const descriptors = deriveSessionEventDescriptors(definition);

    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]?.eventName).toBe('SessionStart');
  });

  it('returns an empty array when no hookEvents have a frameworkSubject', () => {
    const definition = createClientDefinition({
      id: 'test-empty',
      name: 'Test Empty',
      version: '0.1.0',
      defaultApprovalPolicy: 'always-ask',
      runtimeCapabilities: {
        supportsHooks: true,
        hookEvents: [{ name: 'InternalOnly' }],
      },
    });

    const descriptors = deriveSessionEventDescriptors(definition);

    expect(descriptors).toHaveLength(0);
  });
});
