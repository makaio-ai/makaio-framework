import { describe, expect, it } from 'vitest';
import { adapterExternals } from '../tsdown-adapter-preset.js';

type ResolveIdHook = (source: string) => unknown;

function resolve(plugin: ReturnType<typeof adapterExternals>, source: string): unknown {
  return (plugin.resolveId as ResolveIdHook)(source);
}

describe('adapterExternals', () => {
  it('externalizes framework packages through the umbrella facade by default', () => {
    expect(resolve(adapterExternals(), '@makaio/ai-adapters-claude-shared')).toEqual({
      id: '@makaio/framework/adapters/claude',
      external: true,
    });
  });

  it('keeps selected framework packages bundled while externalizing the remaining facade', () => {
    const plugin = adapterExternals([], ['@makaio/ai-adapters-claude-shared']);

    expect(resolve(plugin, '@makaio/ai-adapters-claude-shared')).toBeNull();
    expect(resolve(plugin, '@makaio/ai-adapters-claude-shared/testing')).toBeNull();
    expect(resolve(plugin, '@makaio/contracts')).toEqual({
      id: '@makaio/framework/contracts',
      external: true,
    });
  });
});
