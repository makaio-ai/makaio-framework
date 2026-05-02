import { describe, expect, it } from 'vitest';
import { cleanEnvForAdapter } from '../cleanEnvForAdapter.js';

describe('cleanEnvForAdapter', () => {
  it('removes adapter runtime variables and undefined values', () => {
    expect(
      cleanEnvForAdapter({
        CLAUDECODE: '1',
        NODE_OPTIONS: '--import tsx/esm',
        PATH: '/usr/bin',
        UNSET: undefined,
      }),
    ).toEqual({ PATH: '/usr/bin' });
  });

  it('removes caller-provided ambient credential env vars', () => {
    expect(
      cleanEnvForAdapter(
        {
          ANTHROPIC_API_KEY: 'ambient-key',
          OPENAI_API_KEY: 'ambient-openai-key',
          PATH: '/usr/bin',
        },
        { omitEnvVars: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'] },
      ),
    ).toEqual({ PATH: '/usr/bin' });
  });
});
