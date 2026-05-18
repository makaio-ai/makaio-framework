import { afterEach, describe, expect, it, vi } from 'vitest';
import { seedMakaioHome } from './makaio-home.js';

vi.mock('node:os', () => ({
  homedir: () => '/home/testuser',
}));

afterEach(() => {
  delete process.env['MAKAIO_HOME'];
});

describe('seedMakaioHome', () => {
  it('normalizes a pre-set relative MAKAIO_HOME to an absolute path', () => {
    process.env['MAKAIO_HOME'] = '.makaio-canary';

    const result = seedMakaioHome('.makaio');

    expect(result).toBe('/home/testuser/.makaio-canary');
    expect(process.env['MAKAIO_HOME']).toBe('/home/testuser/.makaio-canary');
  });

  it('preserves a pre-set absolute MAKAIO_HOME', () => {
    process.env['MAKAIO_HOME'] = '/tmp/makaio-home';

    const result = seedMakaioHome('.makaio');

    expect(result).toBe('/tmp/makaio-home');
    expect(process.env['MAKAIO_HOME']).toBe('/tmp/makaio-home');
  });

  it('normalizes a relative build-time default', () => {
    const result = seedMakaioHome('.makaio-canary');

    expect(result).toBe('/home/testuser/.makaio-canary');
    expect(process.env['MAKAIO_HOME']).toBe('/home/testuser/.makaio-canary');
  });

  it('preserves an absolute build-time default', () => {
    const result = seedMakaioHome('/tmp/makaio-default');

    expect(result).toBe('/tmp/makaio-default');
    expect(process.env['MAKAIO_HOME']).toBe('/tmp/makaio-default');
  });
});
