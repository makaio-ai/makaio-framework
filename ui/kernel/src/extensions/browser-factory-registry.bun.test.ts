import { afterEach, describe, expect, it, mock } from 'bun:test';
import {
  clearExtensionBrowserFactories,
  getRegisteredExtensionBrowserFactory,
  registerExtensionBrowserFactory,
  unregisterExtensionBrowserFactory,
} from './browser-factory-registry.js';

describe('browser-factory-registry', () => {
  afterEach(() => {
    clearExtensionBrowserFactories();
  });

  it('unregisters a single extension factory', () => {
    const factory = mock();

    registerExtensionBrowserFactory('alpha', factory);
    expect(getRegisteredExtensionBrowserFactory('alpha')).toBe(factory);

    unregisterExtensionBrowserFactory('alpha');

    expect(getRegisteredExtensionBrowserFactory('alpha')).toBeUndefined();
  });

  it('throws when registering a different factory for an already-registered name', () => {
    const first = mock();
    const second = mock();

    registerExtensionBrowserFactory('gamma', first);

    expect(() => registerExtensionBrowserFactory('gamma', second)).toThrow(
      'Browser factory already registered for extension "gamma".',
    );

    // The original factory must still be intact.
    expect(getRegisteredExtensionBrowserFactory('gamma')).toBe(first);
  });

  it('trims whitespace from extension name before registration and retrieval', () => {
    const factory = mock();

    registerExtensionBrowserFactory(' acme.ext ', factory);

    // Retrievable under both the raw and trimmed name.
    expect(getRegisteredExtensionBrowserFactory(' acme.ext ')).toBe(factory);
    expect(getRegisteredExtensionBrowserFactory('acme.ext')).toBe(factory);
  });

  it('throws when factory is not a function', () => {
    // JSON.parse returns `any`, providing a clean path to pass a non-function
    // value at runtime while keeping TypeScript satisfied — tests the runtime guard.
    const notAFunction = JSON.parse('"not-a-function"') as Parameters<typeof registerExtensionBrowserFactory>[1];
    expect(() => registerExtensionBrowserFactory('bad-factory', notAFunction)).toThrow(
      'Browser factory must be a function.',
    );
  });

  it('is idempotent when re-registering the same factory reference', () => {
    const factory = mock();

    registerExtensionBrowserFactory('delta', factory);
    expect(() => registerExtensionBrowserFactory('delta', factory)).not.toThrow();
    expect(getRegisteredExtensionBrowserFactory('delta')).toBe(factory);
  });

  describe('empty-name guard', () => {
    it('throws on registerExtensionBrowserFactory with a non-string runtime value', () => {
      const invalidName = JSON.parse('42') as Parameters<typeof registerExtensionBrowserFactory>[0];
      expect(() => registerExtensionBrowserFactory(invalidName, mock())).toThrow(
        'Extension name must be a non-empty string.',
      );
    });

    it('throws on registerExtensionBrowserFactory with empty string', () => {
      expect(() => registerExtensionBrowserFactory('', mock())).toThrow('Extension name must be a non-empty string.');
    });

    it('throws on registerExtensionBrowserFactory with whitespace-only string', () => {
      expect(() => registerExtensionBrowserFactory('   ', mock())).toThrow(
        'Extension name must be a non-empty string.',
      );
    });

    it('throws on unregisterExtensionBrowserFactory with empty string', () => {
      expect(() => unregisterExtensionBrowserFactory('')).toThrow('Extension name must be a non-empty string.');
    });

    it('throws on unregisterExtensionBrowserFactory with whitespace-only string', () => {
      expect(() => unregisterExtensionBrowserFactory('  ')).toThrow('Extension name must be a non-empty string.');
    });

    it('throws on getRegisteredExtensionBrowserFactory with empty string', () => {
      expect(() => getRegisteredExtensionBrowserFactory('')).toThrow('Extension name must be a non-empty string.');
    });

    it('throws on getRegisteredExtensionBrowserFactory with whitespace-only string', () => {
      expect(() => getRegisteredExtensionBrowserFactory('\t')).toThrow('Extension name must be a non-empty string.');
    });
  });

  it('clears all registered factories', () => {
    registerExtensionBrowserFactory('alpha', mock());
    registerExtensionBrowserFactory('beta', mock());

    // Precondition: both registrations succeeded before we test clearing.
    expect(getRegisteredExtensionBrowserFactory('alpha')).toBeDefined();
    expect(getRegisteredExtensionBrowserFactory('beta')).toBeDefined();

    clearExtensionBrowserFactories();

    expect(getRegisteredExtensionBrowserFactory('alpha')).toBeUndefined();
    expect(getRegisteredExtensionBrowserFactory('beta')).toBeUndefined();
  });
});
