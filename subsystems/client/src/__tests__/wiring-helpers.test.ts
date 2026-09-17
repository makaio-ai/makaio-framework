import { describe, expect, it } from 'vitest';
import { createClientDefinition } from '@makaio/contracts/client';
import {
  buildClientCommand,
  buildHookCommand,
  deriveSessionEventDescriptors,
  isSessionEventSupported,
} from '../wiring-helpers.js';

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

  it('carries minimumVersion through when declared on a hook event', () => {
    const definition = createClientDefinition({
      id: 'test-minimum-version',
      name: 'Test Minimum Version',
      version: '0.1.0',
      authMethods: [],
      defaultApprovalPolicy: 'always-ask',
      runtimeCapabilities: {
        supportsHooks: true,
        hookEvents: [{ name: 'SessionStart' }, { name: 'PostCompact', minimumVersion: '2.1.76' }],
      },
    });

    const descriptors = deriveSessionEventDescriptors(definition);

    expect(descriptors).toHaveLength(2);
    expect(descriptors[0]).toStrictEqual({ eventName: 'SessionStart', mode: 'event' });
    expect(descriptors[1]).toStrictEqual({
      eventName: 'PostCompact',
      mode: 'event',
      minimumVersion: '2.1.76',
    });
  });

  it('omits minimumVersion key entirely when the hook event does not declare one', () => {
    const definition = createClientDefinition({
      id: 'test-no-minimum-version',
      name: 'Test No Minimum Version',
      version: '0.1.0',
      authMethods: [],
      defaultApprovalPolicy: 'always-ask',
      runtimeCapabilities: {
        supportsHooks: true,
        hookEvents: [{ name: 'SessionStart' }],
      },
    });

    const [descriptor] = deriveSessionEventDescriptors(definition);

    expect(Object.prototype.hasOwnProperty.call(descriptor, 'minimumVersion')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isSessionEventSupported
// ---------------------------------------------------------------------------

describe('isSessionEventSupported', () => {
  it('returns true when minimumVersion is absent (no minimum declared)', () => {
    expect(isSessionEventSupported({ eventName: 'SessionStart' }, '2.1.50')).toBe(true);
  });

  it('returns true when binaryVersion is null (version unknown)', () => {
    expect(isSessionEventSupported({ eventName: 'PostCompact', minimumVersion: '2.1.76' }, null)).toBe(true);
  });

  it('returns true when binaryVersion is undefined (version unknown)', () => {
    expect(isSessionEventSupported({ eventName: 'PostCompact', minimumVersion: '2.1.76' }, undefined)).toBe(true);
  });

  it('returns false when binaryVersion is below minimumVersion', () => {
    expect(isSessionEventSupported({ eventName: 'PostCompact', minimumVersion: '2.1.76' }, '2.1.75')).toBe(false);
  });

  it('returns true when binaryVersion exactly equals minimumVersion', () => {
    expect(isSessionEventSupported({ eventName: 'PostCompact', minimumVersion: '2.1.76' }, '2.1.76')).toBe(true);
  });

  it('returns true when binaryVersion is above minimumVersion (minor bump)', () => {
    expect(isSessionEventSupported({ eventName: 'PostCompact', minimumVersion: '2.1.76' }, '2.2.0')).toBe(true);
  });

  it('returns true when binaryVersion is the literal string "unknown" (non-semver from CLI parse failure)', () => {
    expect(isSessionEventSupported({ eventName: 'PostCompact', minimumVersion: '2.1.76' }, 'unknown')).toBe(true);
  });

  it('returns true when binaryVersion is an empty string (non-semver)', () => {
    expect(isSessionEventSupported({ eventName: 'PostCompact', minimumVersion: '2.1.76' }, '')).toBe(true);
  });

  it('returns true when binaryVersion is a partial version "2.1" (not an exact semver)', () => {
    expect(isSessionEventSupported({ eventName: 'PostCompact', minimumVersion: '2.1.76' }, '2.1')).toBe(true);
  });
});
