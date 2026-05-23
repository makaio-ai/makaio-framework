import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ElectrobunConfig } from 'electrobun';

const ENV_KEYS = ['MAKAIO_ELECTROBUN_SOURCE_DEV', 'NODE_ENV'] as const;
type EnvKey = (typeof ENV_KEYS)[number];
const originalEnv = new Map<EnvKey, string | undefined>();

/**
 * Import electrobun.config.ts after applying environment overrides.
 * @param env - Environment values to apply for this import.
 * @returns Freshly imported Electrobun config.
 */
async function importConfig(env: Partial<Record<EnvKey, string | undefined>>): Promise<ElectrobunConfig> {
  for (const key of ENV_KEYS) {
    if (!originalEnv.has(key)) {
      originalEnv.set(key, process.env[key]);
    }
    const value = env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  vi.resetModules();
  const module = (await import('../electrobun.config.ts')) as { default: ElectrobunConfig };
  return module.default;
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  originalEnv.clear();
});

describe('electrobun.config.ts', () => {
  it('uses the source main-process entry for source-dev runs', async () => {
    const config = await importConfig({
      MAKAIO_ELECTROBUN_SOURCE_DEV: '1',
      NODE_ENV: 'production',
    });

    expect(config.build?.bun?.entrypoint).toBe('./src/main/index.ts');
    expect(config.build?.bun).toMatchObject({
      define: {
        'process.env.NODE_ENV': '"development"',
        __MAKAIO_HOME_DEFAULT__: 'undefined',
      },
      naming: 'index.js',
    });
    expect(config.build?.copy).toEqual({
      './resources/makaio-launcher.sh': 'Resources/makaio-launcher.sh',
      './resources/makaio-launcher-linux.sh': 'Resources/makaio-launcher-linux.sh',
      './resources/makaio.cmd': 'Resources/makaio.cmd',
      './resources/install-cli.sh': 'Resources/install-cli.sh',
    });
  });

  it('uses prebuilt dist artifacts for packaged runs', async () => {
    const config = await importConfig({
      MAKAIO_ELECTROBUN_SOURCE_DEV: undefined,
      NODE_ENV: 'production',
    });

    expect(config.build?.bun?.entrypoint).toBe('./dist/index.js');
    expect(config.build?.copy).toMatchObject({
      './dist/cli.mjs': 'Resources/app/dist/cli.mjs',
      './dist/renderer': 'dist/renderer',
      './dist/variant.json': 'Resources/variant.json',
    });
  });
});
