import { describe, expect, it } from 'vitest';
import { resolveHookEnvPairs } from '../utils/hook-env.js';

describe('resolveHookEnvPairs', () => {
  it('returns undefined when no config file is set', () => {
    expect(resolveHookEnvPairs({})).toBeUndefined();
  });

  it('quotes hook environment values for shell assignment syntax', () => {
    const pairs = resolveHookEnvPairs({
      MAKAIO_CONFIG_FILE: "/tmp/project dir/makaio's config.ts",
      MAKAIO_HOME: '/tmp/home dir',
    });

    expect(pairs).toEqual([
      "MAKAIO_CONFIG_FILE='/tmp/project dir/makaio'\\''s config.ts'",
      "MAKAIO_HOME='/tmp/home dir'",
    ]);
  });
});
