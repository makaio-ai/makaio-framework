import { describe, expect, it, afterEach } from 'bun:test';
import { stubEnv, unstubAllEnvs } from '../env-stub.js';

describe('stubEnv / unstubAllEnvs', () => {
  afterEach(() => {
    unstubAllEnvs();
  });

  it('sets an environment variable', () => {
    stubEnv('MAKAIO_TEST_STUB', 'hello');
    expect(process.env['MAKAIO_TEST_STUB']).toBe('hello');
  });

  it('restores the original value on unstub', () => {
    const original = process.env['PATH'];
    stubEnv('PATH', '/fake');
    expect(process.env['PATH']).toBe('/fake');
    unstubAllEnvs();
    expect(process.env['PATH']).toBe(original);
  });

  it('deletes keys that did not exist before stubbing', () => {
    const key = `MAKAIO_TEST_STUB_${Date.now()}`;
    expect(process.env[key]).toBeUndefined();
    stubEnv(key, 'temp');
    expect(process.env[key]).toBe('temp');
    unstubAllEnvs();
    expect(process.env[key]).toBeUndefined();
  });

  it('handles stubbing to undefined (delete)', () => {
    stubEnv('MAKAIO_TEST_STUB', 'value');
    expect(process.env['MAKAIO_TEST_STUB']).toBe('value');
    stubEnv('MAKAIO_TEST_STUB', undefined);
    expect(process.env['MAKAIO_TEST_STUB']).toBeUndefined();
    unstubAllEnvs();
  });

  it('preserves original across multiple stubs of the same key', () => {
    const key = `MAKAIO_TEST_MULTI_${Date.now()}`;
    expect(process.env[key]).toBeUndefined();
    stubEnv(key, 'first');
    stubEnv(key, 'second');
    stubEnv(key, 'third');
    expect(process.env[key]).toBe('third');
    unstubAllEnvs();
    expect(process.env[key]).toBeUndefined();
  });
});
