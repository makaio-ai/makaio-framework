import { describe, expect, it, spyOn } from 'bun:test';
import { readBunServerEnv } from '../index.js';

describe('readBunServerEnv', () => {
  it('validates port and host with strict defaults', () => {
    expect(readBunServerEnv({ appName: 'server', env: { PORT: '4444', HOST: '127.0.0.1' } })).toEqual({
      port: 4444,
      host: '127.0.0.1',
    });

    expect(() => readBunServerEnv({ appName: 'server', env: { PORT: '0' } })).toThrow('Invalid PORT: 0');
    expect(() => readBunServerEnv({ appName: 'server', env: { HOST: 'bad host' } })).toThrow('Invalid HOST: bad host');
  });

  it('can warn and fall back for standalone apps that preserve lenient env semantics', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(readBunServerEnv({ appName: 'relay', env: { PORT: 'nope', HOST: 'bad host' }, invalid: 'warn' })).toEqual({
        port: 3000,
        host: '0.0.0.0',
      });
      expect(warn).toHaveBeenCalledWith('[relay] Invalid PORT: nope, falling back to 3000');
      expect(warn).toHaveBeenCalledWith('[relay] Invalid HOST: bad host, falling back to 0.0.0.0');
    } finally {
      warn.mockRestore();
    }
  });
});
