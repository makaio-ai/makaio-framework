import { beforeEach, describe, expect, expectTypeOf, it } from 'vitest';
import {
  createExtensionNamespace,
  MakaioBus,
  type ExtensionNamespaceExtensions,
  type ExtensionNamespaceFromConfig,
} from '../index.js';
import { z } from 'zod';

describe('createExtensionNamespace', () => {
  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
    MakaioBus.getContext().namespaceRegistry.__resetNamespaces?.();
  });

  it('creates an unprefixed extension namespace without registering it on the singleton', () => {
    const namespace = createExtensionNamespace('bus-core-extension-namespace-test', {
      schemas: {
        changed: z.object({ value: z.string() }),
      },
    });

    expect(namespace.domain).toBe('bus-core-extension-namespace-test');
    expect(namespace.subjects.changed.$meta.namespace).toBe('extension:bus-core-extension-namespace-test');
    expect(MakaioBus.getContext().namespaceRegistry.getSchema(namespace.subjects.changed)).toBeUndefined();
  });

  it('trims surrounding whitespace before creating the extension domain', () => {
    const namespace = createExtensionNamespace(' my-extension ', {
      schemas: {
        changed: z.object({ value: z.string() }),
      },
    });

    expect(namespace.domain).toBe('my-extension');
    expect(namespace.subjects.changed.$meta.namespace).toBe('extension:my-extension');
    expectTypeOf(namespace.domain).toEqualTypeOf<'my-extension'>();
    expectTypeOf(namespace.subjects.changed.$meta.namespace).toEqualTypeOf<'extension:my-extension'>();
  });

  it('keeps runtime and type-level trim behavior aligned for JavaScript trim whitespace', () => {
    const namespace = createExtensionNamespace('\vmy-extension\f', {
      schemas: {
        changed: z.object({ value: z.string() }),
      },
    });

    expect(namespace.domain).toBe('my-extension');
    expect(namespace.subjects.changed.$meta.namespace).toBe('extension:my-extension');
    expectTypeOf(namespace.domain).toEqualTypeOf<'my-extension'>();
    expectTypeOf(namespace.subjects.changed.$meta.namespace).toEqualTypeOf<'extension:my-extension'>();
  });

  it('preserves broad string extension name types after runtime trimming', () => {
    const extensionName: string = ' dynamic-extension ';
    const namespace = createExtensionNamespace(extensionName, {
      schemas: {
        changed: z.object({ value: z.string() }),
      },
    });

    expect(namespace.domain).toBe('dynamic-extension');
    expect(namespace.subjects.changed.$meta.namespace).toBe('extension:dynamic-extension');
    expectTypeOf(namespace.domain).toEqualTypeOf<string>();
    expectTypeOf(namespace.subjects.changed.$meta.namespace).toEqualTypeOf<`extension:${string}`>();
  });

  it('rejects empty extension names before creating a namespace', () => {
    expect(() =>
      createExtensionNamespace('', {
        schemas: {
          changed: z.object({ value: z.string() }),
        },
      }),
    ).toThrow('Invalid extensionName');

    expect(() =>
      createExtensionNamespace('   ', {
        schemas: {
          changed: z.object({ value: z.string() }),
        },
      }),
    ).toThrow('Invalid extensionName');
  });

  it('rejects names that already include the extension domain prefix', () => {
    expect(() =>
      createExtensionNamespace('extension:already-prefixed', {
        schemas: {
          changed: z.object({ value: z.string() }),
        },
      }),
    ).toThrow('Invalid extensionName');
  });

  it('preserves custom extension types in ExtensionNamespaceFromConfig', () => {
    const schemas = {
      changed: z.object({ value: z.string() }),
    } as const;

    interface CustomExtensions extends ExtensionNamespaceExtensions {
      readonly customMetadata: {
        readonly version: string;
      };
    }

    type Namespace = ExtensionNamespaceFromConfig<'typed-extension', typeof schemas, CustomExtensions>;

    expect(schemas.changed).toBeDefined();
    expectTypeOf<Namespace['extensions']>().toEqualTypeOf<CustomExtensions>();
  });
});
