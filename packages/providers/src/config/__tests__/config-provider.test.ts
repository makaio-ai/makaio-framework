import { describe, it, expect, vi } from 'vitest';
import type { Config } from '@makaio/contracts';
import { ConfigError, type IConfigStorage } from '@makaio/core';
import { ConfigProvider } from '../index.js';

/**
 * Minimal in-memory IConfigStorage for testing.
 */
class MemoryConfigStorage implements IConfigStorage<Config> {
  private stored: Partial<Config> | null;

  public constructor(initial: Partial<Config> | null = null) {
    this.stored = initial;
  }

  public async getConfig(): Promise<Config> {
    return (this.stored ?? {}) as Config;
  }

  public async saveConfig(config: Config): Promise<void> {
    this.stored = config;
  }
}

/**
 * Creates a valid config object for tests, then applies unsafe overrides to
 * exercise runtime schema validation without using double assertions.
 * @param overrides - Raw key/value pairs to force onto the config object
 * @returns Config object with the requested invalid runtime shape
 */
function createInvalidConfig(overrides: Record<string, unknown>): Config {
  const config: Config = {
    $schema: 'makaio/config/v1',
    mode: 'local',
    role: 'main-dev-machine',
  };

  for (const [key, value] of Object.entries(overrides)) {
    Reflect.set(config as Record<string, unknown>, key, value);
  }

  return config;
}

/**
 * Concrete subclass of ConfigProvider for testing.
 * Exposes a mutable env map to simulate process.env overrides.
 */
class TestConfigProvider extends ConfigProvider {
  private readonly envMap: Record<string, string>;

  public constructor(storage: IConfigStorage<Config>, envMap: Record<string, string> = {}) {
    super(storage);
    this.envMap = envMap;
  }

  public getMachineId(): Promise<string> {
    return Promise.resolve('test-machine-id');
  }

  protected override getEnv(key: string): string | undefined {
    return this.envMap[key];
  }
}

describe('ConfigProvider', () => {
  describe('getConfig', () => {
    it('returns default config when storage is empty', async () => {
      const provider = new TestConfigProvider(new MemoryConfigStorage(null));

      const config = await provider.getConfig();

      expect(config.$schema).toBe('makaio/config/v1');
      expect(config.mode).toBe('local');
      expect(config.role).toBe('main-dev-machine');
    });

    it('merges stored config over defaults', async () => {
      const storage = new MemoryConfigStorage({ mode: 'remote', role: 'server' } as Partial<Config>);
      const provider = new TestConfigProvider(storage);

      const config = await provider.getConfig();

      expect(config.mode).toBe('remote');
      expect(config.role).toBe('server');
    });

    it('applies env variable overrides over stored config', async () => {
      const storage = new MemoryConfigStorage({ mode: 'local' } as Partial<Config>);
      const provider = new TestConfigProvider(storage, { MAKAIO_MODE: 'hybrid' });

      const config = await provider.getConfig();

      expect(config.mode).toBe('hybrid');
    });

    it('applies programmatic overrides over env variables', async () => {
      const storage = new MemoryConfigStorage({ mode: 'local' } as Partial<Config>);
      const provider = new TestConfigProvider(storage, { MAKAIO_MODE: 'remote' });

      const config = await provider.getConfig({ mode: 'hybrid' });

      expect(config.mode).toBe('hybrid');
    });

    it('sets bus.remote when MAKAIO_BUS_URL is provided', async () => {
      const provider = new TestConfigProvider(new MemoryConfigStorage(null), {
        MAKAIO_BUS_URL: 'http://localhost:4000',
      });

      const config = await provider.getConfig();

      expect(config.bus?.remote?.url).toBe('http://localhost:4000');
    });

    it('sets bus.remote.secret when both MAKAIO_BUS_URL and MAKAIO_BUS_SECRET are provided', async () => {
      const provider = new TestConfigProvider(new MemoryConfigStorage(null), {
        MAKAIO_BUS_URL: 'http://localhost:4000',
        MAKAIO_BUS_SECRET: 'supersecret',
      });

      const config = await provider.getConfig();

      expect(config.bus?.remote?.url).toBe('http://localhost:4000');
      expect(config.bus?.remote?.secret).toBe('supersecret');
    });

    it('trims surrounding whitespace from MAKAIO_BUS_SECRET', async () => {
      const provider = new TestConfigProvider(new MemoryConfigStorage(null), {
        MAKAIO_BUS_URL: 'http://localhost:4000',
        MAKAIO_BUS_SECRET: '  padded-secret  ',
      });

      const config = await provider.getConfig();

      expect(config.bus?.remote?.secret).toBe('padded-secret');
    });

    it('throws when MAKAIO_BUS_SECRET is whitespace-only', async () => {
      const provider = new TestConfigProvider(new MemoryConfigStorage(null), {
        MAKAIO_BUS_URL: 'http://localhost:4000',
        MAKAIO_BUS_SECRET: '   ',
      });

      await expect(provider.getConfig()).rejects.toThrow(
        'MAKAIO_BUS_SECRET is set but empty after trimming; refusing to use an empty secret',
      );
    });

    it('throws when MAKAIO_BUS_SECRET is an empty string', async () => {
      const provider = new TestConfigProvider(new MemoryConfigStorage(null), {
        MAKAIO_BUS_URL: 'http://localhost:4000',
        MAKAIO_BUS_SECRET: '',
      });

      await expect(provider.getConfig()).rejects.toThrow(
        'MAKAIO_BUS_SECRET is set but empty after trimming; refusing to use an empty secret',
      );
    });

    it('sets relay when MAKAIO_RELAY_URL is provided', async () => {
      const provider = new TestConfigProvider(new MemoryConfigStorage(null), {
        MAKAIO_RELAY_URL: 'wss://relay.example.com',
      });

      const config = await provider.getConfig();

      expect(config.relay?.url).toBe('wss://relay.example.com');
    });

    it('does not set bus when MAKAIO_BUS_URL is absent', async () => {
      const provider = new TestConfigProvider(new MemoryConfigStorage(null), {});

      const config = await provider.getConfig();

      expect(config.bus).toBeUndefined();
    });

    it('throws when MAKAIO_BUS_SECRET is set without MAKAIO_BUS_URL', async () => {
      const provider = new TestConfigProvider(new MemoryConfigStorage(null), {
        MAKAIO_BUS_SECRET: 'supersecret',
      });

      await expect(provider.getConfig()).rejects.toThrow('MAKAIO_BUS_SECRET requires MAKAIO_BUS_URL');
    });

    it('normalizes MAKAIO_BUS_SECRET before enforcing MAKAIO_BUS_URL dependency', async () => {
      const provider = new TestConfigProvider(new MemoryConfigStorage(null), {
        MAKAIO_BUS_SECRET: '   ',
      });

      await expect(provider.getConfig()).rejects.toThrow(
        'MAKAIO_BUS_SECRET is set but empty after trimming; refusing to use an empty secret',
      );
    });

    it('throws ConfigError when merged config fails schema validation', async () => {
      // Inject an invalid mode via storage to trigger schema validation failure
      const storage: IConfigStorage<Config> = {
        getConfig: async () => createInvalidConfig({ mode: 'invalid-mode' }),
        saveConfig: async () => undefined,
      };
      const provider = new TestConfigProvider(storage);

      await expect(provider.getConfig()).rejects.toThrow(ConfigError);
    });

    it('ConfigError has expected subject on validation failure', async () => {
      const storage: IConfigStorage<Config> = {
        getConfig: async () => createInvalidConfig({ mode: 'bad' }),
        saveConfig: async () => undefined,
      };
      const provider = new TestConfigProvider(storage);

      await expect(provider.getConfig()).rejects.toMatchObject({
        subject: 'runtime.config.validation',
      });
    });

    it('wraps storage read failures in ConfigError', async () => {
      const storage: IConfigStorage<Config> = {
        getConfig: async () => {
          throw new Error('disk unavailable');
        },
        saveConfig: async () => undefined,
      };
      const provider = new TestConfigProvider(storage);

      await expect(provider.getConfig()).rejects.toMatchObject({
        subject: 'runtime.config.load',
      });
    });

    it('merge order: overrides win over everything', async () => {
      const storage = new MemoryConfigStorage({ mode: 'remote' } as Partial<Config>);
      const provider = new TestConfigProvider(storage, { MAKAIO_MODE: 'hybrid' });

      const config = await provider.getConfig({ mode: 'local' });

      expect(config.mode).toBe('local');
    });
  });

  describe('saveConfig', () => {
    it('saves valid config to storage', async () => {
      const storage = new MemoryConfigStorage(null);
      const provider = new TestConfigProvider(storage);

      await provider.saveConfig({
        $schema: 'makaio/config/v1',
        mode: 'local',
        role: 'main-dev-machine',
      });

      const saved = await storage.getConfig();
      expect(saved.mode).toBe('local');
    });

    it('throws ConfigError when saving invalid config', async () => {
      const storage = new MemoryConfigStorage(null);
      const provider = new TestConfigProvider(storage);

      await expect(provider.saveConfig(createInvalidConfig({ mode: 'invalid' }))).rejects.toThrow(ConfigError);
    });

    it('ConfigError on save has expected subject', async () => {
      const storage = new MemoryConfigStorage(null);
      const provider = new TestConfigProvider(storage);

      await expect(provider.saveConfig(createInvalidConfig({ mode: 'not-a-mode' }))).rejects.toMatchObject({
        subject: 'runtime.config.save',
      });
    });

    it('does not persist to storage when config is invalid', async () => {
      const storage = new MemoryConfigStorage({ mode: 'local', role: 'server' } as Partial<Config>);
      const provider = new TestConfigProvider(storage);

      await expect(provider.saveConfig(createInvalidConfig({ mode: 'bad' }))).rejects.toThrow(ConfigError);

      // Storage should remain unchanged
      const saved = await storage.getConfig();
      expect((saved as Partial<Config>).mode).toBe('local');
    });
  });

  describe('getEnv (default implementation)', () => {
    it('returns undefined for any key when not overridden', async () => {
      // Use a provider that does NOT override getEnv (uses default)
      class DefaultEnvProvider extends ConfigProvider {
        public getMachineId(): Promise<string> {
          return Promise.resolve('default-machine');
        }
      }

      const provider = new DefaultEnvProvider(new MemoryConfigStorage(null));

      // If env fallback were active, mode could be set from process.env — but default returns undefined
      const config = await provider.getConfig();
      // Default mode from defaults, not from process.env
      expect(config.mode).toBe('local');
    });
  });

  describe('console output suppression verification', () => {
    it('logs diagnostics when validation fails', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        const storage: IConfigStorage<Config> = {
          getConfig: async () => ({ mode: 'bad' }) as unknown as Config,
          saveConfig: async () => undefined,
        };
        const provider = new TestConfigProvider(storage);

        await expect(provider.getConfig()).rejects.toThrow(ConfigError);
        expect(consoleSpy).toHaveBeenCalled();
      } finally {
        consoleSpy.mockRestore();
      }
    });
  });
});
