import { describe, it, expect } from 'vitest';
import {
  ClientHookEventDeclarationSchema,
  ClientRuntimeCapabilitiesSchema,
  createClientDefinition,
  deriveHookEventTransportMode,
} from '@makaio/contracts/client';

describe('ClientHookEventDeclaration', () => {
  it('defaults hookEvents to empty array when omitted', () => {
    const caps = ClientRuntimeCapabilitiesSchema.parse({});
    expect(caps.hookEvents).toEqual([]);
  });

  it('accepts valid hookEvents with name only', () => {
    const caps = ClientRuntimeCapabilitiesSchema.parse({
      supportsHooks: true,
      hookEvents: [{ name: 'PreToolUse' }],
    });
    expect(caps.hookEvents).toHaveLength(1);
    expect(caps.hookEvents[0].name).toBe('PreToolUse');
  });

  it('accepts hookEvents with name and frameworkSubject', () => {
    const caps = ClientRuntimeCapabilitiesSchema.parse({
      supportsHooks: true,
      hookEvents: [{ name: 'PreToolUse', frameworkSubject: 'client.session.tool.pre' }],
    });
    expect(caps.hookEvents[0].frameworkSubject).toBe('client.session.tool.pre');
  });

  it('rejects hookEvents with empty name', () => {
    expect(() =>
      ClientRuntimeCapabilitiesSchema.parse({
        hookEvents: [{ name: '' }],
      }),
    ).toThrow();
  });

  it('rejects hookEvents with empty frameworkSubject', () => {
    expect(() =>
      ClientRuntimeCapabilitiesSchema.parse({
        supportsHooks: true,
        hookEvents: [{ name: 'PreToolUse', frameworkSubject: '' }],
      }),
    ).toThrow();
  });

  it('rejects hookEvents when supportsHooks is false', () => {
    expect(() =>
      ClientRuntimeCapabilitiesSchema.parse({
        supportsHooks: false,
        hookEvents: [{ name: 'PreToolUse' }],
      }),
    ).toThrow();
  });

  it('survives createClientDefinition deep-freeze', () => {
    const def = createClientDefinition({
      id: 'test-client',
      name: 'Test',
      version: '0.1.0',
      authMethods: [],
      nativeTools: [],
      defaultApprovalPolicy: 'always-ask',
      runtimeCapabilities: {
        supportsHooks: true,
        hookEvents: [{ name: 'SessionStart', frameworkSubject: 'client.session.started' }, { name: 'CustomEvent' }],
      },
    });
    expect(def.runtimeCapabilities.hookEvents).toHaveLength(2);
    expect(Object.isFrozen(def.runtimeCapabilities.hookEvents)).toBe(true);
    expect(Object.isFrozen(def.runtimeCapabilities.hookEvents[0])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// responseCapabilities schema validation
// ---------------------------------------------------------------------------

describe('ClientHookEventDeclaration — responseCapabilities', () => {
  it('defaults responseCapabilities to an empty array when omitted', () => {
    const event = ClientHookEventDeclarationSchema.parse({ name: 'Stop' });
    expect(event.responseCapabilities).toEqual([]);
  });

  it('accepts an explicit empty responseCapabilities array', () => {
    const event = ClientHookEventDeclarationSchema.parse({
      name: 'Stop',
      responseCapabilities: [],
    });
    expect(event.responseCapabilities).toEqual([]);
  });

  it('accepts a single response capability', () => {
    const event = ClientHookEventDeclarationSchema.parse({
      name: 'PreToolUse',
      responseCapabilities: ['approve'],
    });
    expect(event.responseCapabilities).toEqual(['approve']);
  });

  it('accepts multiple response capabilities', () => {
    const event = ClientHookEventDeclarationSchema.parse({
      name: 'PreToolUse',
      responseCapabilities: ['approve', 'deny', 'context.append'],
    });
    expect(event.responseCapabilities).toEqual(['approve', 'deny', 'context.append']);
  });

  it('rejects response capabilities with empty strings', () => {
    const result = ClientHookEventDeclarationSchema.safeParse({
      name: 'PreToolUse',
      responseCapabilities: ['approve', ''],
    });
    expect(result.success).toBe(false);
  });

  it('rejects the removed "mode" field via strict schema', () => {
    const result = ClientHookEventDeclarationSchema.safeParse({
      name: 'PreToolUse',
      mode: 'request',
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// deriveHookEventTransportMode
// ---------------------------------------------------------------------------

describe('deriveHookEventTransportMode', () => {
  it('returns "event" for empty responseCapabilities', () => {
    const event = ClientHookEventDeclarationSchema.parse({ name: 'Stop' });
    expect(deriveHookEventTransportMode(event)).toBe('event');
  });

  it('returns "request" for non-empty responseCapabilities', () => {
    const event = ClientHookEventDeclarationSchema.parse({
      name: 'PreToolUse',
      responseCapabilities: ['approve', 'deny'],
    });
    expect(deriveHookEventTransportMode(event)).toBe('request');
  });

  it('returns "request" for a single capability', () => {
    const event = ClientHookEventDeclarationSchema.parse({
      name: 'PreToolUse',
      responseCapabilities: ['context.append'],
    });
    expect(deriveHookEventTransportMode(event)).toBe('request');
  });

  it('returns "event" for explicitly empty capabilities', () => {
    const event = ClientHookEventDeclarationSchema.parse({
      name: 'SessionStart',
      responseCapabilities: [],
    });
    expect(deriveHookEventTransportMode(event)).toBe('event');
  });
});

// ---------------------------------------------------------------------------
// minimumVersion schema validation
// ---------------------------------------------------------------------------

describe('ClientHookEventDeclaration — minimumVersion', () => {
  it('accepts a valid semver literal as minimumVersion', () => {
    const event = ClientHookEventDeclarationSchema.parse({
      name: 'PostCompact',
      minimumVersion: '2.1.76',
    });
    expect(event.minimumVersion).toBe('2.1.76');
  });

  it('parses without minimumVersion key when the field is absent', () => {
    const event = ClientHookEventDeclarationSchema.parse({ name: 'SessionStart' });
    expect(event.minimumVersion).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(event, 'minimumVersion')).toBe(false);
  });

  it('rejects a semver range (caret) as minimumVersion', () => {
    const result = ClientHookEventDeclarationSchema.safeParse({
      name: 'PostCompact',
      minimumVersion: '^2.1.0',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-semver string as minimumVersion', () => {
    const result = ClientHookEventDeclarationSchema.safeParse({
      name: 'PostCompact',
      minimumVersion: 'latest',
    });
    expect(result.success).toBe(false);
  });
});
