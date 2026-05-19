import path from 'node:path';
import { describe, expect, it } from 'bun:test';
import {
  applyDesktopMakaioHomeEnv,
  createDesktopBootContext,
  resolveDesktopMakaioHome,
} from '../src/desktop-boot-context.js';

describe('desktop-boot-context', () => {
  it('resolves MAKAIO_HOME as the operational override', () => {
    expect(resolveDesktopMakaioHome({ env: { MAKAIO_HOME: './data-home' }, homeDir: '/home/test' })).toBe(
      path.resolve('./data-home'),
    );
  });

  it('resolves relative defaults against the user home', () => {
    expect(resolveDesktopMakaioHome({ env: {}, defaultDir: '.makaio-canary', homeDir: '/home/test' })).toBe(
      '/home/test/.makaio-canary',
    );
  });

  it('resolves relative injected home directories before applying defaults', () => {
    expect(resolveDesktopMakaioHome({ env: {}, defaultDir: '.makaio-canary', homeDir: 'relative-home' })).toBe(
      path.resolve('relative-home/.makaio-canary'),
    );
  });

  it('preserves absolute defaults', () => {
    expect(resolveDesktopMakaioHome({ env: {}, defaultDir: '/var/lib/makaio', homeDir: '/home/test' })).toBe(
      '/var/lib/makaio',
    );
  });

  it('writes the normalized home into the supplied environment', () => {
    const env: NodeJS.ProcessEnv = { MAKAIO_HOME: './runtime-home' };

    const resolved = applyDesktopMakaioHomeEnv({ env, homeDir: '/home/test' });

    expect(resolved).toBe(path.resolve('./runtime-home'));
    expect(env['MAKAIO_HOME']).toBe(resolved);
  });

  it('creates host-neutral boot metadata without synthetic defaults', () => {
    expect(
      createDesktopBootContext({
        env: {},
        homeDir: '/home/test',
        frameworkPackagePath: '/app/node_modules/@makaio/framework',
        frameworkVersion: '1.2.3',
        modelRegistryFallbackSeedPaths: ['/app/static/model-registry.yaml'],
      }),
    ).toEqual({
      makaioHome: '/home/test/.makaio',
      frameworkPackagePath: '/app/node_modules/@makaio/framework',
      frameworkVersion: '1.2.3',
      modelRegistryFallbackSeedPaths: ['/app/static/model-registry.yaml'],
    });
  });
});
