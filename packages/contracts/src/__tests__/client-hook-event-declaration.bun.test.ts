import { describe, it, expect } from 'bun:test';
import { ClientRuntimeCapabilitiesSchema, createClientDefinition } from '@makaio/contracts/client';

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
