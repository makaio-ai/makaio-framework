import { describe, it, expect, expectTypeOf } from 'vitest';
import { BrowserEntrypointSchema } from '@makaio/contracts';
import type { ExtensionRuntimeSurface } from '../extension/index.js';
import { ExtensionInfoSchema } from '../observability/index.js';
import type { ExtensionInfo, ComponentState } from '../observability/index.js';

describe('ExtensionRuntimeSurface', () => {
  it('includes the supported hosted surface categories', () => {
    expectTypeOf<'interactive'>().toMatchTypeOf<ExtensionRuntimeSurface>();
    expectTypeOf<'headless'>().toMatchTypeOf<ExtensionRuntimeSurface>();
  });

  it('does not include any (any is a manifest affinity, not a runtime identity)', () => {
    expectTypeOf<'any'>().not.toMatchTypeOf<ExtensionRuntimeSurface>();
  });
});

describe('ExtensionInfo (from observability/shared-schemas)', () => {
  it('compiles with all fields including error', () => {
    const info: ExtensionInfo = {
      name: 'docker',
      displayName: 'Docker',
      state: 'failed',
      enabled: false,
      error: 'Docker daemon not running',
    };

    expectTypeOf(info).toMatchTypeOf<ExtensionInfo>();
    expectTypeOf(info.error).toEqualTypeOf<string | undefined>();
  });

  it('compiles without optional fields', () => {
    const info: ExtensionInfo = {
      name: 'voice',
      displayName: 'Voice Bridge',
      state: 'active',
      enabled: true,
    };

    expectTypeOf(info).toMatchTypeOf<ExtensionInfo>();
  });

  it('state field is typed as ComponentState', () => {
    const info: ExtensionInfo = {
      name: 'relay',
      displayName: 'Relay',
      state: 'initializing',
      enabled: true,
    };

    expectTypeOf(info.state).toEqualTypeOf<ComponentState>();
  });

  it('reuses the shared browser entrypoint schema', () => {
    const browser = BrowserEntrypointSchema.parse({ entrypoint: '/extensions/relay/browser.js' });
    const info = ExtensionInfoSchema.parse({
      name: 'relay',
      displayName: 'Relay',
      state: 'active',
      enabled: true,
      browser,
    });

    expect(info.browser).toEqual(browser);
  });
});
