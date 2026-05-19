import { describe, expect, it } from 'bun:test';
import {
  buildDevHostRuntimeOptions,
  HOST_WORKSPACE_ROOT_ENV,
  resolveDevHostOptions,
} from '../src/main/dev-host-options.js';

describe('resolveDevHostOptions', () => {
  it('returns dev-host options from direct env resolution', () => {
    expect(
      resolveDevHostOptions({
        [HOST_WORKSPACE_ROOT_ENV]: '/workspace/direct-host',
      }),
    ).toEqual({
      workspaceRoot: '/workspace/direct-host',
    });
  });

  it('resolves relative workspace roots against the supplied base directory', () => {
    expect(
      resolveDevHostOptions(
        {
          [HOST_WORKSPACE_ROOT_ENV]: '.',
        },
        { baseDir: '/workspace/direct-host' },
      ),
    ).toEqual({
      workspaceRoot: '/workspace/direct-host',
    });
  });
});

describe('buildDevHostRuntimeOptions', () => {
  it('returns descriptor discovery without runtime host capability tokens', () => {
    const options = buildDevHostRuntimeOptions({ workspaceRoot: '/workspace/host' }, '/tmp/.makaio');

    expect(options).not.toHaveProperty('hostCapabilities');
  });
});
