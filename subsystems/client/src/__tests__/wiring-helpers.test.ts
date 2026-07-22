import { describe, expect, it } from 'vitest';
import { createClientDefinition } from '@makaio/contracts/client';
import { buildClientCommand, buildHookCommand, deriveSessionEventDescriptors } from '../wiring-helpers.js';

describe('buildClientCommand', () => {
  it('quotes the executable token when rendering non-hook client commands', () => {
    expect(buildClientCommand("/Applications/Makaio CLI/bin/makai'o", ['claude', 'statusline'])).toBe(
      "'/Applications/Makaio CLI/bin/makai'\\''o' claude statusline",
    );
  });
});

describe('buildHookCommand', () => {
  it('leaves simple command tokens unchanged', () => {
    expect(buildHookCommand('makaio', 'hook received codex', 'SessionStart')).toBe(
      'makaio hook received codex SessionStart',
    );
  });

  it('quotes the executable token when the makaio command is a path with shell-sensitive characters', () => {
    expect(buildHookCommand("/Applications/Makaio CLI/bin/makai'o", 'hook received codex', 'SessionStart')).toBe(
      "'/Applications/Makaio CLI/bin/makai'\\''o' hook received codex SessionStart",
    );
  });
});

describe('deriveSessionEventDescriptors', () => {
  it('returns events without frameworkSubject alongside events with one', () => {
    const definition = createClientDefinition({
      id: 'test-all-events',
      name: 'Test All Events',
      version: '0.1.0',
      authMethods: [],
      defaultApprovalPolicy: 'always-ask',
      runtimeCapabilities: {
        supportsHooks: true,
        hookEvents: [
          { name: 'SessionStart', frameworkSubject: 'client.session.started' },
          { name: 'InternalEvent' },
          {
            name: 'PreToolUse',
            frameworkSubject: 'client.session.tool.pre',
            responseCapabilities: ['approve', 'deny'],
          },
        ],
      },
    });

    const descriptors = deriveSessionEventDescriptors(definition);

    expect(descriptors).toHaveLength(3);
    expect(descriptors[0]).toStrictEqual({ eventName: 'SessionStart', mode: 'event' });
    expect(descriptors[1]).toStrictEqual({ eventName: 'InternalEvent', mode: 'event' });
    expect(descriptors[2]).toStrictEqual({ eventName: 'PreToolUse', mode: 'request' });
  });

  it('returns all events even when none have a frameworkSubject', () => {
    const definition = createClientDefinition({
      id: 'test-no-subjects',
      name: 'Test No Subjects',
      version: '0.1.0',
      authMethods: [],
      defaultApprovalPolicy: 'always-ask',
      runtimeCapabilities: {
        supportsHooks: true,
        hookEvents: [{ name: 'InternalOnly' }, { name: 'AnotherInternal' }],
      },
    });

    const descriptors = deriveSessionEventDescriptors(definition);

    expect(descriptors).toHaveLength(2);
    expect(descriptors[0]).toStrictEqual({ eventName: 'InternalOnly', mode: 'event' });
    expect(descriptors[1]).toStrictEqual({ eventName: 'AnotherInternal', mode: 'event' });
  });

  it('returns an empty array when hookEvents is empty', () => {
    const definition = createClientDefinition({
      id: 'test-empty-hooks',
      name: 'Test Empty',
      version: '0.1.0',
      authMethods: [],
      defaultApprovalPolicy: 'always-ask',
      runtimeCapabilities: {
        supportsHooks: true,
        hookEvents: [],
      },
    });

    const descriptors = deriveSessionEventDescriptors(definition);

    expect(descriptors).toHaveLength(0);
  });
});
