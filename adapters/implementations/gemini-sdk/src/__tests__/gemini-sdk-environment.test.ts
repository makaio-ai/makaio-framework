import { afterEach, describe, expect, it } from 'vitest';
import { GEMINI_SDK_SENSITIVE_ENV_VARS, withGeminiSdkEnvironment } from '../gemini-sdk-environment.js';

const originalEnvironment = new Map<string, string | undefined>();

afterEach(() => {
  for (const name of GEMINI_SDK_SENSITIVE_ENV_VARS) {
    const value = originalEnvironment.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  originalEnvironment.clear();
});

function setHostileEnvironment(): void {
  for (const name of GEMINI_SDK_SENSITIVE_ENV_VARS) {
    originalEnvironment.set(name, process.env[name]);
    process.env[name] = `hostile-${name}`;
  }
}

describe('Gemini SDK process environment scope', () => {
  it('removes hostile Core auth and transport inputs while SDK initialization runs', async () => {
    setHostileEnvironment();

    await withGeminiSdkEnvironment({}, async () => {
      for (const name of GEMINI_SDK_SENSITIVE_ENV_VARS) expect(process.env[name]).toBeUndefined();
    });

    for (const name of GEMINI_SDK_SENSITIVE_ENV_VARS) expect(process.env[name]).toBe(`hostile-${name}`);
  });

  it('serializes overlapping initialization scopes and restores after a failure', async () => {
    setHostileEnvironment();
    const firstEntered = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const observed: string[] = [];

    const first = withGeminiSdkEnvironment(
      { GEMINI_CLI_SYSTEM_SETTINGS_PATH: '/tmp/first-settings.json' },
      async () => {
        observed.push(process.env['GEMINI_CLI_SYSTEM_SETTINGS_PATH'] ?? 'missing');
        firstEntered.resolve();
        await releaseFirst.promise;
        throw new Error('first scope failed');
      },
    );
    await firstEntered.promise;
    const second = withGeminiSdkEnvironment({ GEMINI_CLI_SYSTEM_SETTINGS_PATH: '/tmp/second-settings.json' }, () => {
      observed.push(process.env['GEMINI_CLI_SYSTEM_SETTINGS_PATH'] ?? 'missing');
    });

    releaseFirst.resolve();
    await expect(first).rejects.toThrow('first scope failed');
    await second;

    expect(observed).toEqual(['/tmp/first-settings.json', '/tmp/second-settings.json']);
    for (const name of GEMINI_SDK_SENSITIVE_ENV_VARS) expect(process.env[name]).toBe(`hostile-${name}`);
  });
});
