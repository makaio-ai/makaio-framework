import { describe, expectTypeOf, it } from 'bun:test';
import type { ExtensionContext, MakaioExtension, NodeExtensionContext } from '../index.js';

type HasKey<T, K extends PropertyKey> = K extends keyof T ? true : false;

describe('ExtensionContext host-specific fields', () => {
  it('keeps the base extension context free of Node-only host fields', () => {
    expectTypeOf<HasKey<ExtensionContext, 'platform'>>().toEqualTypeOf<false>();
    expectTypeOf<HasKey<ExtensionContext, 'homedir'>>().toEqualTypeOf<false>();
    expectTypeOf<HasKey<ExtensionContext, 'makaioHome'>>().toEqualTypeOf<false>();
    expectTypeOf<HasKey<ExtensionContext, 'username'>>().toEqualTypeOf<false>();
  });

  it('exposes Node host fields through an explicit context type', () => {
    expectTypeOf<NodeExtensionContext['platform']>().toEqualTypeOf<NodeJS.Platform>();
    expectTypeOf<NodeExtensionContext['homedir']>().toEqualTypeOf<string>();
    expectTypeOf<NodeExtensionContext['makaioHome']>().toEqualTypeOf<string>();
    expectTypeOf<NodeExtensionContext['username']>().toEqualTypeOf<string>();
    expectTypeOf<NodeExtensionContext['busUrl']>().toEqualTypeOf<string | undefined>();
  });

  it('allows host-agnostic extensions to opt into the generic base context', () => {
    const extension = {
      name: 'portable-extension',
      displayName: 'Portable Extension',
      version: '0.1.0',
      create(ctx) {
        expectTypeOf<HasKey<typeof ctx, 'makaioHome'>>().toEqualTypeOf<false>();
        return {
          init() {
            void ctx.bus;
          },
        };
      },
    } satisfies MakaioExtension<ExtensionContext>;

    expectTypeOf(extension).toMatchTypeOf<MakaioExtension<ExtensionContext>>();
  });
});
