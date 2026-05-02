import { describe, expect, it } from 'vitest';
import { resolveFrameworkSpecifier } from './framework-module-resolver.js';

describe('bun framework module resolver path resolution', () => {
  it('maps framework subpath specifiers into the configured dist path', () => {
    expect(resolveFrameworkSpecifier('/app/dist/framework', '@makaio/framework/bus')).toBe(
      '/app/dist/framework/bus/index.mjs',
    );
  });

  it('does not map unrelated package specifiers', () => {
    expect(resolveFrameworkSpecifier('/app/dist/framework', 'openai')).toBeUndefined();
  });
});
