import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { MakaioBus } from '@makaio/bus-core';
import { ConfigSubjects, type Config } from '@makaio/contracts';
import type { IConfigStorage } from '@makaio/core';
import { NodeRuntimeProvider } from '../node-runtime-provider.js';
import { registerConfigHandlers } from '../boot-config.js';

class MemoryConfigStorage implements IConfigStorage<Config> {
  public saved: Config | undefined;

  public constructor(private current: Partial<Config> | null = null) {}

  public async getConfig(): Promise<Config> {
    return (this.current ?? {}) as Config;
  }

  public async saveConfig(config: Config): Promise<void> {
    this.saved = config;
    this.current = config;
  }
}

describe('registerConfigHandlers', () => {
  const originalRelayUrl = process.env.MAKAIO_RELAY_URL;
  const originalBusUrl = process.env.MAKAIO_BUS_URL;
  const originalBusSecret = process.env.MAKAIO_BUS_SECRET;
  let cleanup: (() => void) | undefined;

  beforeEach(() => {
    delete process.env.MAKAIO_RELAY_URL;
    delete process.env.MAKAIO_BUS_URL;
    delete process.env.MAKAIO_BUS_SECRET;
  });

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    if (originalRelayUrl === undefined) delete process.env.MAKAIO_RELAY_URL;
    else process.env.MAKAIO_RELAY_URL = originalRelayUrl;
    if (originalBusUrl === undefined) delete process.env.MAKAIO_BUS_URL;
    else process.env.MAKAIO_BUS_URL = originalBusUrl;
    if (originalBusSecret === undefined) delete process.env.MAKAIO_BUS_SECRET;
    else process.env.MAKAIO_BUS_SECRET = originalBusSecret;
  });

  it('returns effective config including MAKAIO_RELAY_URL', async () => {
    process.env.MAKAIO_RELAY_URL = 'wss://relay.example.com';
    const provider = new NodeRuntimeProvider(new MemoryConfigStorage(null), '/tmp/makaio-test');
    cleanup = registerConfigHandlers(MakaioBus, provider);

    const { config } = await MakaioBus.request(ConfigSubjects.get, {});

    expect(config.relay?.url).toBe('wss://relay.example.com');
  });

  it('does not persist environment-only values on update', async () => {
    process.env.MAKAIO_RELAY_URL = 'wss://relay.example.com';
    const storage = new MemoryConfigStorage(null);
    const provider = new NodeRuntimeProvider(storage, '/tmp/makaio-test');
    cleanup = registerConfigHandlers(MakaioBus, provider);
    const { config } = await MakaioBus.request(ConfigSubjects.get, {});

    await MakaioBus.request(ConfigSubjects.update, { config });

    expect(storage.saved?.relay).toBeUndefined();
  });

  it('preserves user-provided stored values on update', async () => {
    const storage = new MemoryConfigStorage({
      relay: { url: 'wss://stored.example.com' },
    } as Partial<Config>);
    const provider = new NodeRuntimeProvider(storage, '/tmp/makaio-test');
    cleanup = registerConfigHandlers(MakaioBus, provider);
    const { config } = await MakaioBus.request(ConfigSubjects.get, {});

    await MakaioBus.request(ConfigSubjects.update, { config });

    expect(storage.saved?.relay?.url).toBe('wss://stored.example.com');
  });

  it('does not persist env-only bus url when NodeRuntimeProvider generates a secret', async () => {
    process.env.MAKAIO_BUS_URL = 'https://bus.example.com';
    const storage = new MemoryConfigStorage(null);
    const provider = new NodeRuntimeProvider(storage, '/tmp/makaio-test');
    cleanup = registerConfigHandlers(MakaioBus, provider);

    const { config } = await MakaioBus.request(ConfigSubjects.get, {});
    await MakaioBus.request(ConfigSubjects.update, { config });

    expect(config.bus?.remote?.url).toBe('https://bus.example.com');
    expect(config.bus?.remote?.secret).toBeTruthy();
    expect(storage.saved?.bus).toBeUndefined();
  });

  it('does not persist env-only relay when saving a generated secret for stored bus config', async () => {
    process.env.MAKAIO_RELAY_URL = 'wss://relay.example.com';
    const storage = new MemoryConfigStorage({
      bus: { remote: { url: 'https://stored-bus.example.com' } },
    } as Partial<Config>);
    const provider = new NodeRuntimeProvider(storage, '/tmp/makaio-test');
    cleanup = registerConfigHandlers(MakaioBus, provider);

    const { config } = await MakaioBus.request(ConfigSubjects.get, {});

    expect(config.relay?.url).toBe('wss://relay.example.com');
    expect(config.bus?.remote?.secret).toBeTruthy();
    expect(storage.saved?.bus?.remote?.url).toBe('https://stored-bus.example.com');
    expect(storage.saved?.bus?.remote?.secret).toBeTruthy();
    expect(storage.saved?.relay).toBeUndefined();
  });
});
