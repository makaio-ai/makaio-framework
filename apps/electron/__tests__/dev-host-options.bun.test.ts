import { describe, expect, it } from 'bun:test';
import { HOST_WORKSPACE_ROOT_ENV, resolveDevHostOptions } from '../src/main/dev-host-options.js';

describe('resolveDevHostOptions', () => {
  /** A stable absolute path used as the workspace root in tests. */
  const WORKSPACE_ROOT = '/workspace/test-root';

  it('returns Electron dev-host options for a valid absolute path', () => {
    expect(
      resolveDevHostOptions({
        [HOST_WORKSPACE_ROOT_ENV]: WORKSPACE_ROOT,
      }),
    ).toEqual({
      workspaceRoot: WORKSPACE_ROOT,
    });
  });

  it('resolves relative workspace roots against the supplied base directory', () => {
    expect(
      resolveDevHostOptions(
        {
          [HOST_WORKSPACE_ROOT_ENV]: '.',
        },
        { baseDir: WORKSPACE_ROOT },
      ),
    ).toEqual({
      workspaceRoot: WORKSPACE_ROOT,
    });
  });

  it('throws when the workspace root value is relative without a base directory', () => {
    expect(() =>
      resolveDevHostOptions({
        [HOST_WORKSPACE_ROOT_ENV]: './host',
      }),
    ).toThrow('MAKAIO_HOST_WORKSPACE_ROOT must be an absolute path, got: ./host');
  });
});
