import { beforeEach, describe, expect, expectTypeOf, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { z } from 'zod';
import { createExtensionStorageNamespace } from './create-extension-storage-namespace';

describe('createExtensionStorageNamespace', () => {
  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
    MakaioBus.getContext().namespaceRegistry.__resetNamespaces?.();
  });

  it('trims surrounding whitespace before creating the extension storage namespace', () => {
    const namespace = createExtensionStorageNamespace(' my-extension ', {
      schemas: {
        get: { request: z.object({ id: z.string() }), response: z.object({ value: z.string() }) },
      },
    });

    expect(namespace.domain).toBe('extension:my-extension');
    expect(namespace.subjects.get.$meta.namespace).toBe('storage:extension:my-extension');
    expectTypeOf(namespace.domain).toEqualTypeOf<'extension:my-extension'>();
    expectTypeOf(namespace.subjects.get.$meta.namespace).toEqualTypeOf<'storage:extension:my-extension'>();
    expect(MakaioBus.getContext().namespaceRegistry.getSchema(namespace.subjects.get)).toBeUndefined();
  });

  it('keeps runtime and type-level trim behavior aligned for JavaScript trim whitespace', () => {
    const namespace = createExtensionStorageNamespace('\vmy-extension\f', {
      schemas: {
        get: { request: z.object({ id: z.string() }), response: z.object({ value: z.string() }) },
      },
    });

    expect(namespace.domain).toBe('extension:my-extension');
    expect(namespace.subjects.get.$meta.namespace).toBe('storage:extension:my-extension');
    expectTypeOf(namespace.domain).toEqualTypeOf<'extension:my-extension'>();
    expectTypeOf(namespace.subjects.get.$meta.namespace).toEqualTypeOf<'storage:extension:my-extension'>();
  });

  it('preserves broad string extension name types after runtime trimming', () => {
    const extensionName: string = ' dynamic-extension ';
    const namespace = createExtensionStorageNamespace(extensionName, {
      schemas: {
        get: { request: z.object({ id: z.string() }), response: z.object({ value: z.string() }) },
      },
    });

    expect(namespace.domain).toBe('extension:dynamic-extension');
    expect(namespace.subjects.get.$meta.namespace).toBe('storage:extension:dynamic-extension');
    expectTypeOf(namespace.domain).toEqualTypeOf<`extension:${string}`>();
    expectTypeOf(namespace.subjects.get.$meta.namespace).toEqualTypeOf<`storage:extension:${string}`>();
  });

  it('rejects empty and already-prefixed extension names', () => {
    expect(() =>
      createExtensionStorageNamespace('   ', {
        schemas: {
          get: { request: z.object({ id: z.string() }), response: z.object({ value: z.string() }) },
        },
      }),
    ).toThrow('Invalid extensionName');

    expect(() =>
      createExtensionStorageNamespace('extension:already-prefixed', {
        schemas: {
          get: { request: z.object({ id: z.string() }), response: z.object({ value: z.string() }) },
        },
      }),
    ).toThrow('Invalid extensionName');
  });
});
