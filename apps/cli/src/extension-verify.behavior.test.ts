import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ExtensionVerifyError, verifyExtensionWorkspace } from './extension-verify.js';

const tempDirs: string[] = [];
const VERIFY_TEST_TIMEOUT_MS = 15_000;

afterEach(async () => {
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
});

/**
 * Create a temporary extension workspace.
 * @param entrypoints - Descriptor entrypoints to write.
 * @param files - Relative file contents keyed by workspace-relative path.
 * @returns Workspace root path.
 */
async function createWorkspace(
  entrypoints: {
    readonly server?: true | string;
    readonly browser?: true | string;
    readonly cli?: true | string;
  },
  files: Readonly<Record<string, string>>,
): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'makaio-extension-verify-'));
  const workspaceRoot = path.join(tempDir, 'workspace');
  tempDirs.push(tempDir);

  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(
    path.join(workspaceRoot, 'descriptor.json'),
    `${JSON.stringify(
      {
        name: 'verify-fixture',
        displayName: 'Verify Fixture',
        version: '0.1.0',
        makaio: {
          framework: '>=0.1.0',
        },
        entrypoints,
        execution: 'embedded',
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  await Promise.all(
    Object.entries(files).map(async ([relativePath, contents]) => {
      const absolutePath = path.join(workspaceRoot, relativePath);
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, contents, 'utf8');
    }),
  );

  return workspaceRoot;
}

/**
 * Assert that verification fails with a typed verifier error.
 * @param workspaceRoot - Extension workspace to verify.
 * @returns Structured verification error.
 */
async function expectVerifyFailure(workspaceRoot: string): Promise<ExtensionVerifyError> {
  try {
    await verifyExtensionWorkspace({ cwd: workspaceRoot });
  } catch (error) {
    expect(error).toBeInstanceOf(ExtensionVerifyError);
    if (error instanceof ExtensionVerifyError) {
      return error;
    }
    throw error;
  }

  throw new Error('Expected extension verification to fail.');
}

describe('verifyExtensionWorkspace', { timeout: VERIFY_TEST_TIMEOUT_MS }, () => {
  it('returns machine-readable check results on success', async () => {
    const workspaceRoot = await createWorkspace(
      {
        browser: true,
      },
      {
        './dist/browser.mjs': "import 'react';\nexport default () => ({});\n",
      },
    );

    const result = await verifyExtensionWorkspace({ cwd: workspaceRoot });

    expect(result).toMatchObject({
      ok: true,
      rootDir: workspaceRoot,
      entrypoints: {
        browser: true,
      },
      diagnostics: [],
    });
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ check: 'descriptor', status: 'passed' }),
        expect.objectContaining({ check: 'entrypoint', surface: 'server', status: 'skipped' }),
        expect.objectContaining({
          check: 'entrypoint',
          surface: 'browser',
          status: 'passed',
          entrypoint: 'browser',
        }),
        expect.objectContaining({ check: 'runtime', surface: 'browser', status: 'passed' }),
        expect.objectContaining({ check: 'runtime', surface: 'cli', status: 'skipped' }),
      ]),
    );
  });

  it('prefers src/{stem}.ts over dist/{stem}.mjs when both exist', async () => {
    const workspaceRoot = await createWorkspace(
      {
        browser: true,
      },
      {
        './src/browser.ts': 'export default () => ({});\n',
        './dist/browser.mjs': "import 'zod';\nexport default () => ({});\n",
      },
    );

    // src/browser.ts has no bare imports, dist/browser.mjs imports zod (unsupported).
    // Convention prefers src, so verification passes.
    const result = await verifyExtensionWorkspace({ cwd: workspaceRoot });
    expect(result.ok).toBe(true);
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          check: 'entrypoint',
          surface: 'browser',
          status: 'passed',
          entrypoint: 'browser',
        }),
      ]),
    );
  });

  it('resolves a custom stem when the surface uses a non-default filename', async () => {
    const workspaceRoot = await createWorkspace(
      {
        browser: 'browser/index',
      },
      {
        './dist/browser/index.mjs': "import 'react';\nexport default () => ({});\n",
      },
    );

    const result = await verifyExtensionWorkspace({ cwd: workspaceRoot });
    expect(result.ok).toBe(true);
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          check: 'entrypoint',
          surface: 'browser',
          status: 'passed',
          entrypoint: 'browser/index',
        }),
      ]),
    );
  });

  it('exposes a typed diagnostic when no resolution candidate exists', async () => {
    const workspaceRoot = await createWorkspace({ server: true }, {});

    const error = await expectVerifyFailure(workspaceRoot);

    expect(error.message).toContain('server entrypoint "server" has no resolvable candidate');
    expect(error.result).toMatchObject({
      ok: false,
      diagnostics: [
        {
          code: 'entrypoint.no-candidate',
          surface: 'server',
          entrypoint: 'server',
        },
      ],
    });
  });

  it('exposes a typed diagnostic for symlink escapes from the extension root', async () => {
    const workspaceRoot = await createWorkspace({ server: true }, {});
    const outsideDir = path.join(path.dirname(workspaceRoot), 'outside-dist');
    await mkdir(outsideDir, { recursive: true });
    await writeFile(
      path.join(outsideDir, 'server.mjs'),
      "export default { name: 'verify-fixture', displayName: 'Verify Fixture' };\n",
      'utf8',
    );
    await mkdir(path.join(workspaceRoot, 'dist'), { recursive: true });
    // Symlink dist/server.mjs → outside the extension root
    await symlink(path.join(outsideDir, 'server.mjs'), path.join(workspaceRoot, 'dist', 'server.mjs'), 'file');

    const error = await expectVerifyFailure(workspaceRoot);

    expect(error.result).toMatchObject({
      ok: false,
      diagnostics: [
        {
          code: 'entrypoint.no-candidate',
          surface: 'server',
          entrypoint: 'server',
        },
      ],
    });
  });

  it('exposes a typed diagnostic when the browser bundle graph is not loadable ESM', async () => {
    const workspaceRoot = await createWorkspace(
      {
        browser: true,
      },
      {
        './dist/browser.mjs': "import './missing-chunk.mjs';\nexport default () => ({});\n",
      },
    );

    const error = await expectVerifyFailure(workspaceRoot);

    expect(error.message).toContain('Browser entrypoint is not parseable/loadable ESM:');
    expect(error.result).toMatchObject({
      ok: false,
      diagnostics: [
        {
          code: 'browser.invalid-esm',
          surface: 'browser',
          entrypoint: 'browser',
        },
      ],
    });
  });

  it('exposes a typed diagnostic when the browser bundle escapes the static root', async () => {
    const workspaceRoot = await createWorkspace(
      {
        browser: true,
      },
      {
        './outside.mjs': 'export default {};\n',
        './dist/browser.mjs': "import '../outside.mjs';\nexport default () => ({});\n",
      },
    );

    const error = await expectVerifyFailure(workspaceRoot);

    expect(error.message).toContain('Browser entrypoint reaches outside the static root:');
    expect(error.result).toMatchObject({
      ok: false,
      diagnostics: [
        {
          code: 'browser.static-root-escape',
          surface: 'browser',
          entrypoint: 'browser',
        },
      ],
    });
  });
});
