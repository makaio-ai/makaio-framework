import { readFileSync, realpathSync } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import * as url from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const FRAMEWORK_ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../../../');
const EXTENSION_VERIFY_TEST_TIMEOUT_MS = 20_000;

const serveMocks = vi.hoisted(() => ({
  serve: vi.fn(),
}));

vi.mock('./serve.js', () => serveMocks);

import { createProgram } from './main.js';

/**
 * Assert that a file exists.
 * @param filePath - Absolute path to the expected file.
 */
async function expectFile(filePath: string): Promise<void> {
  await expect(access(filePath)).resolves.toBeUndefined();
}

/**
 * Read the current version from a framework package.json.
 * @param frameworkRelativePath - Package manifest path relative to the framework root.
 * @returns Version string from the manifest.
 */
function readRepoPackageVersion(frameworkRelativePath: string): string {
  return (JSON.parse(readFileSync(path.join(FRAMEWORK_ROOT, frameworkRelativePath), 'utf8')) as { version: string })
    .version;
}

/**
 * Build the exact `link:` target generated for repo-dev framework dependencies.
 * @param scaffoldRoot - Absolute root of the generated extension scaffold.
 * @param frameworkRelativePath - Package directory relative to the framework root.
 * @returns Expected workspace link dependency string.
 */
function expectedWorkspaceLink(scaffoldRoot: string, frameworkRelativePath: string): string {
  const relativeTarget = path.relative(
    realpathSync.native(scaffoldRoot),
    path.join(FRAMEWORK_ROOT, frameworkRelativePath),
  );
  const portableTarget = relativeTarget.replaceAll(path.sep, '/');
  const normalizedTarget =
    portableTarget.startsWith('./') || portableTarget.startsWith('../') ? portableTarget : `./${portableTarget}`;
  return `link:${normalizedTarget}`;
}

describe('extension init builtin', () => {
  const tempDirs: string[] = [];
  let originalExitCode: typeof process.exitCode;

  beforeEach(() => {
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    process.exitCode = originalExitCode;

    while (tempDirs.length > 0) {
      const tempDir = tempDirs.pop();
      if (tempDir) {
        await rm(tempDir, { recursive: true, force: true });
      }
    }
  });

  it('creates a server-only scaffold by default and omits unselected surfaces', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'makaio-extension-init-'));
    tempDirs.push(tempRoot);
    const extensionRoot = path.join(tempRoot, 'server-only');

    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const program = createProgram();

    await program.parseAsync(['extension', 'init', 'server-only', '--out-dir', extensionRoot], { from: 'user' });

    await expectFile(path.join(extensionRoot, 'package.json'));
    await expectFile(path.join(extensionRoot, 'descriptor.json'));
    await expectFile(path.join(extensionRoot, '.gitignore'));
    await expectFile(path.join(extensionRoot, 'tsconfig.json'));
    await expectFile(path.join(extensionRoot, 'tsconfig.repo-dev.json'));
    await expectFile(path.join(extensionRoot, 'tsdown.config.ts'));
    await expectFile(path.join(extensionRoot, 'vitest.config.ts'));
    await expectFile(path.join(extensionRoot, 'README.md'));
    await expectFile(path.join(extensionRoot, 'scripts', 'package-mode.ts'));
    await expectFile(path.join(extensionRoot, 'scripts', 'run-with-mode.ts'));
    await expectFile(path.join(extensionRoot, 'scripts', 'prepare-portable-package.mjs'));
    await expectFile(path.join(extensionRoot, 'src', 'server.ts'));
    await expectFile(path.join(extensionRoot, 'test', 'verify.test.ts'));
    await expect(access(path.join(extensionRoot, 'src', 'browser.ts'))).rejects.toThrow();
    await expect(access(path.join(extensionRoot, 'src', 'cli.ts'))).rejects.toThrow();

    const descriptor = JSON.parse(await readFile(path.join(extensionRoot, 'descriptor.json'), 'utf8'));
    expect(descriptor).toMatchObject({
      name: 'server-only',
      displayName: 'Server Only',
      entrypoints: {
        server: true,
      },
      execution: 'embedded',
    });
    expect(descriptor.cli).toBeUndefined();

    const tsdownConfig = await readFile(path.join(extensionRoot, 'tsdown.config.ts'), 'utf8');
    expect(tsdownConfig).toContain("import { mergeConfig } from 'tsdown';");
    expect(tsdownConfig).toContain('createRepoDevAliases(extensionRoot, {');
    expect(tsdownConfig).toContain("server: './src/server.ts'");
    expect(tsdownConfig).not.toContain("browser: './src/browser.ts'");
    expect(tsdownConfig).not.toContain("cli: './src/cli.ts'");

    const tsconfig = JSON.parse(await readFile(path.join(extensionRoot, 'tsconfig.json'), 'utf8'));
    expect(tsconfig.compilerOptions.rootDir).toBe('.');
    expect(tsconfig.include).toEqual(['src', 'scripts', 'test']);

    const packageJson = JSON.parse(await readFile(path.join(extensionRoot, 'package.json'), 'utf8'));
    expect(packageJson.scripts.build).toBe('tsx ./scripts/run-with-mode.ts repo-dev tsdown');
    expect(packageJson.scripts.test).toBe(
      'tsx ./scripts/run-with-mode.ts repo-dev vitest run --config vitest.config.ts',
    );
    expect(packageJson.scripts.verify).toBe(
      'tsx ./scripts/run-with-mode.ts repo-dev vitest run test/verify.test.ts --config vitest.config.ts',
    );
    expect(packageJson.scripts['prepare:portable-package']).toBe('node ./scripts/prepare-portable-package.mjs');

    expect(infoSpy).toHaveBeenCalledWith(`Created extension scaffold at ${extensionRoot}`);
    expect(process.exitCode).toBeUndefined();
  });

  it('creates server, browser, and cli scaffolds from flags', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'makaio-extension-init-'));
    tempDirs.push(tempRoot);
    const extensionRoot = path.join(tempRoot, 'generated', 'acme-tools');

    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const program = createProgram();

    await program.parseAsync(
      [
        'extension',
        'init',
        'acme-tools',
        '--display-name',
        'Acme Tools',
        '--surface',
        'server,browser,cli',
        '--scope',
        '@acme',
        '--out-dir',
        extensionRoot,
      ],
      { from: 'user' },
    );

    await expectFile(path.join(extensionRoot, 'src', 'server.ts'));
    await expectFile(path.join(extensionRoot, 'src', 'browser.ts'));
    await expectFile(path.join(extensionRoot, 'src', 'cli.ts'));
    await expectFile(path.join(extensionRoot, 'test', 'verify.test.ts'));

    const packageJson = JSON.parse(await readFile(path.join(extensionRoot, 'package.json'), 'utf8'));
    expect(packageJson.name).toBe('@acme/acme-tools');
    expect(packageJson.dependencies).toEqual({ zod: '^4.1.13' });
    expect(packageJson.devDependencies['@makaio/kernel']).toMatch(/^link:/);
    expect(packageJson.devDependencies['@makaio/ui-kernel']).toMatch(/^link:/);
    expect(packageJson.scripts.build).toBe('tsx ./scripts/run-with-mode.ts repo-dev tsdown');
    expect(packageJson.scripts.verify).toBe(
      'tsx ./scripts/run-with-mode.ts repo-dev vitest run test/verify.test.ts --config vitest.config.ts',
    );
    expect(packageJson.exports).toMatchObject({
      './server': './src/server.ts',
      './browser': './src/browser.ts',
      './cli': './src/cli.ts',
    });
    expect(packageJson.publishConfig.exports).toMatchObject({
      './server': './dist/server.mjs',
      './browser': './dist/browser.mjs',
      './cli': './dist/cli.mjs',
    });

    const descriptor = JSON.parse(await readFile(path.join(extensionRoot, 'descriptor.json'), 'utf8'));
    expect(descriptor).toMatchObject({
      name: 'acme-tools',
      displayName: 'Acme Tools',
      entrypoints: {
        server: true,
        browser: true,
        cli: true,
      },
      cli: {
        name: 'acme-tools',
        description: 'CLI commands for Acme Tools',
        subcommands: [{ name: 'doctor', description: 'Check that the scaffolded CLI surface is wired correctly' }],
      },
    });

    // These it('...') strings ARE the scaffold contract — each verifier test case
    // name is a required security/correctness gate. The assertions verify that the
    // generator emits the correct verifier coverage for the selected surfaces.
    const verifyTest = await readFile(path.join(extensionRoot, 'test', 'verify.test.ts'), 'utf8');
    expect(verifyTest).toContain("import { verifyExtensionWorkspace } from '@makaio/cli';");
    expect(verifyTest).toContain("it('rejects invalid descriptor.json'");
    expect(verifyTest).toContain("it('rejects missing declared server entrypoints");
    expect(verifyTest).toContain("it('rejects invalid server default exports'");
    expect(verifyTest).toContain("it('rejects invalid CLI default exports'");
    expect(verifyTest).toContain("it('rejects unsupported browser bare imports'");
    expect(verifyTest).toContain("it('rejects browser bundles that escape the static root'");
    expect(verifyTest).toContain("it('rejects browser bundles that are not loadable ESM'");

    expect(infoSpy).toHaveBeenCalledWith(`Created extension scaffold at ${extensionRoot}`);
    expect(process.exitCode).toBeUndefined();
  });

  it('creates a browser-only scaffold with runnable verifier coverage', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'makaio-extension-init-'));
    tempDirs.push(tempRoot);
    const extensionRoot = path.join(tempRoot, 'browser-only');

    const program = createProgram();
    await program.parseAsync(
      ['extension', 'init', 'browser-only', '--surface', 'browser', '--out-dir', extensionRoot],
      {
        from: 'user',
      },
    );

    await expectFile(path.join(extensionRoot, 'src', 'browser.ts'));
    await expect(access(path.join(extensionRoot, 'src', 'server.ts'))).rejects.toThrow();
    await expect(access(path.join(extensionRoot, 'src', 'cli.ts'))).rejects.toThrow();

    const packageJson = JSON.parse(await readFile(path.join(extensionRoot, 'package.json'), 'utf8'));
    expect(packageJson.devDependencies['@makaio/ui-kernel']).toMatch(/^link:/);
    expect(packageJson.scripts.verify).toBe(
      'tsx ./scripts/run-with-mode.ts repo-dev vitest run test/verify.test.ts --config vitest.config.ts',
    );
    expect(packageJson.dependencies).toBeUndefined();

    const descriptor = JSON.parse(await readFile(path.join(extensionRoot, 'descriptor.json'), 'utf8'));
    expect(descriptor.entrypoints).toEqual({
      browser: true,
    });

    const verifyTest = await readFile(path.join(extensionRoot, 'test', 'verify.test.ts'), 'utf8');
    expect(verifyTest).toContain("it('rejects invalid descriptor.json'");
    expect(verifyTest).toContain("it('rejects missing browser build output'");
    expect(verifyTest).toContain("it('rejects unsupported browser bare imports'");
    expect(verifyTest).toContain("it('rejects browser bundles that escape the static root'");
    expect(verifyTest).toContain("it('rejects browser bundles that are not loadable ESM'");
    expect(verifyTest).not.toContain("it('rejects invalid server default exports'");
    expect(verifyTest).not.toContain("it('rejects invalid CLI default exports'");
  });

  it(
    'stages a portable source package from the generated scaffold',
    {
      timeout: EXTENSION_VERIFY_TEST_TIMEOUT_MS,
    },
    async () => {
      const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'makaio-extension-init-'));
      tempDirs.push(tempRoot);
      const extensionRoot = path.join(tempRoot, 'portable-ext');

      const program = createProgram();
      await program.parseAsync(
        ['extension', 'init', 'portable-ext', '--surface', 'server,cli', '--out-dir', extensionRoot],
        {
          from: 'user',
        },
      );

      const generatedPackageJson = JSON.parse(await readFile(path.join(extensionRoot, 'package.json'), 'utf8'));
      expect(generatedPackageJson.devDependencies['@makaio/build-tooling']).toBe(
        expectedWorkspaceLink(extensionRoot, 'build-tooling'),
      );
      expect(generatedPackageJson.devDependencies['@makaio/cli']).toBe(
        expectedWorkspaceLink(extensionRoot, 'apps/cli'),
      );
      expect(generatedPackageJson.devDependencies['@makaio/contracts']).toBe(
        expectedWorkspaceLink(extensionRoot, 'packages/contracts'),
      );
      expect(generatedPackageJson.devDependencies['@makaio/kernel']).toBe(
        expectedWorkspaceLink(extensionRoot, 'packages/kernel'),
      );

      await new Promise<void>((resolve, reject) => {
        execFile(
          process.execPath,
          ['./scripts/prepare-portable-package.mjs'],
          {
            cwd: extensionRoot,
            env: { ...process.env },
          },
          (error) => {
            if (error) {
              reject(error);
              return;
            }

            resolve();
          },
        );
      });

      const stagedPackageJson = JSON.parse(
        await readFile(path.join(extensionRoot, 'build', 'portable-source', 'package.json'), 'utf8'),
      );
      const expectedFrameworkVersions = {
        '@makaio/build-tooling': readRepoPackageVersion('build-tooling/package.json'),
        '@makaio/cli': readRepoPackageVersion('apps/cli/package.json'),
        '@makaio/contracts': readRepoPackageVersion('packages/contracts/package.json'),
        '@makaio/kernel': readRepoPackageVersion('packages/kernel/package.json'),
      };

      expect(stagedPackageJson.scripts).toEqual({
        build: 'tsdown',
        test: 'vitest run --config vitest.config.ts',
        verify: 'vitest run test/verify.test.ts --config vitest.config.ts',
      });
      expect(stagedPackageJson.devDependencies['@makaio/build-tooling']).toBe(
        `^${expectedFrameworkVersions['@makaio/build-tooling']}`,
      );
      expect(stagedPackageJson.devDependencies['@makaio/cli']).toBe(`^${expectedFrameworkVersions['@makaio/cli']}`);
      expect(stagedPackageJson.devDependencies['@makaio/contracts']).toBe(
        `^${expectedFrameworkVersions['@makaio/contracts']}`,
      );
      expect(stagedPackageJson.devDependencies['@makaio/kernel']).toBe(
        `^${expectedFrameworkVersions['@makaio/kernel']}`,
      );
      expect(stagedPackageJson.devDependencies['tsx']).toBe('^4.20.4');
    },
  );

  it('escapes special characters in generated entrypoints', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'makaio-extension-init-'));
    tempDirs.push(tempRoot);
    const extensionRoot = path.join(tempRoot, 'quoted-tools');

    const program = createProgram();
    vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await program.parseAsync(
      [
        'extension',
        'init',
        'quoted-tools',
        '--display-name',
        'Bob\'s "Tools"',
        '--surface',
        'server,cli',
        '--out-dir',
        extensionRoot,
      ],
      { from: 'user' },
    );

    const serverTs = await readFile(path.join(extensionRoot, 'src', 'server.ts'), 'utf8');
    // JSON.stringify produces double-quoted strings that safely embed any content.
    // The apostrophe passes through literally; double quotes are backslash-escaped.
    expect(serverTs).toContain('name: "quoted-tools"');
    expect(serverTs).toContain("Bob's");
    expect(serverTs).toContain('\\"Tools\\"');
    // Must NOT use raw single-quoted interpolation.
    expect(serverTs).not.toContain("name: 'quoted");

    const cliTs = await readFile(path.join(extensionRoot, 'src', 'cli.ts'), 'utf8');
    expect(cliTs).toContain('name: "quoted-tools"');
    expect(cliTs).toContain("Bob's");
    expect(cliTs).toContain('\\"Tools\\"');
    expect(cliTs).not.toContain("name: 'quoted");
  });

  it('verifies the full built contract locally', { timeout: EXTENSION_VERIFY_TEST_TIMEOUT_MS }, async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'makaio-extension-init-'));
    tempDirs.push(tempRoot);
    const extensionRoot = path.join(tempRoot, 'verified-ext');
    const distDir = path.join(extensionRoot, 'dist');

    const program = createProgram();
    await program.parseAsync(
      ['extension', 'init', 'verified-ext', '--surface', 'server,browser,cli', '--out-dir', extensionRoot],
      {
        from: 'user',
      },
    );

    await mkdir(distDir, { recursive: true });
    await writeFile(
      path.join(distDir, 'server.mjs'),
      "export default { name: 'verified-ext', displayName: 'Verified Ext' };\n",
      'utf8',
    );
    await writeFile(path.join(distDir, 'browser.mjs'), "import 'react';\nexport default () => ({});\n", 'utf8');
    await writeFile(
      path.join(distDir, 'cli.mjs'),
      "export default { name: 'verified-ext', description: 'CLI commands for Verified Ext', subcommands: [{ name: 'doctor', description: 'Check that the scaffolded CLI surface is wired correctly', schema: { safeParse: () => ({ success: true, data: {} }) }, handler: async () => {} }] };\n",
      'utf8',
    );
    await rm(path.join(extensionRoot, 'src'), { recursive: true, force: true });

    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await program.parseAsync(['extension', 'verify', '--cwd', extensionRoot], { from: 'user' });

    expect(infoSpy).toHaveBeenCalledWith(`Extension verified at ${extensionRoot}`);
    expect(process.exitCode).toBeUndefined();
  });

  it('fails verify when a declared dist entrypoint is missing', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'makaio-extension-init-'));
    tempDirs.push(tempRoot);
    const extensionRoot = path.join(tempRoot, 'broken-ext');

    const program = createProgram();
    await program.parseAsync(['extension', 'init', 'broken-ext', '--out-dir', extensionRoot], { from: 'user' });

    await rm(path.join(extensionRoot, 'src'), { recursive: true, force: true });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await program.parseAsync(['extension', 'verify', '--cwd', extensionRoot], { from: 'user' });

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Extension verify failed: server entrypoint "server" has no resolvable candidate'),
    );
    expect(infoSpy).not.toHaveBeenCalledWith(`Extension verified at ${extensionRoot}`);
    expect(process.exitCode).toBe(1);
  });

  it('fails verify when descriptor.json is invalid', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'makaio-extension-init-'));
    tempDirs.push(tempRoot);
    const extensionRoot = path.join(tempRoot, 'invalid-descriptor');

    const program = createProgram();
    await program.parseAsync(['extension', 'init', 'invalid-descriptor', '--out-dir', extensionRoot], { from: 'user' });

    const descriptorPath = path.join(extensionRoot, 'descriptor.json');
    const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8'));
    descriptor.entrypoints = {};
    await writeFile(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`, 'utf8');

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await program.parseAsync(['extension', 'verify', '--cwd', extensionRoot], { from: 'user' });

    expect(errorSpy).toHaveBeenCalledWith(
      'Extension verify failed: descriptor.json is invalid: entrypoints: at least one entrypoint must be declared',
    );
    expect(process.exitCode).toBe(1);
  });

  it('fails verify when the server default export is invalid', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'makaio-extension-init-'));
    tempDirs.push(tempRoot);
    const extensionRoot = path.join(tempRoot, 'invalid-server');
    const distDir = path.join(extensionRoot, 'dist');

    const program = createProgram();
    await program.parseAsync(['extension', 'init', 'invalid-server', '--out-dir', extensionRoot], { from: 'user' });

    await mkdir(distDir, { recursive: true });
    await writeFile(path.join(distDir, 'server.mjs'), 'export default {};\n', 'utf8');
    await rm(path.join(extensionRoot, 'src'), { recursive: true, force: true });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await program.parseAsync(['extension', 'verify', '--cwd', extensionRoot], { from: 'user' });

    expect(errorSpy).toHaveBeenCalledWith(
      'Extension verify failed: Server entrypoint default export is not a valid MakaioExtension: server',
    );
    expect(process.exitCode).toBe(1);
  });

  it('fails verify when the CLI default export is invalid', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'makaio-extension-init-'));
    tempDirs.push(tempRoot);
    const extensionRoot = path.join(tempRoot, 'invalid-cli');
    const distDir = path.join(extensionRoot, 'dist');

    const program = createProgram();
    await program.parseAsync(['extension', 'init', 'invalid-cli', '--surface', 'cli', '--out-dir', extensionRoot], {
      from: 'user',
    });

    await mkdir(distDir, { recursive: true });
    await writeFile(
      path.join(distDir, 'cli.mjs'),
      "export default { name: 'invalid-cli', description: 'broken', subcommands: [] };\n",
      'utf8',
    );
    await rm(path.join(extensionRoot, 'src'), { recursive: true, force: true });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await program.parseAsync(['extension', 'verify', '--cwd', extensionRoot], { from: 'user' });

    expect(errorSpy).toHaveBeenCalledWith(
      'Extension verify failed: CLI entrypoint default export is not a valid CliContribution: cli',
    );
    expect(process.exitCode).toBe(1);
  });

  it('fails verify when browser build output is missing', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'makaio-extension-init-'));
    tempDirs.push(tempRoot);
    const extensionRoot = path.join(tempRoot, 'missing-browser');

    const program = createProgram();
    await program.parseAsync(
      ['extension', 'init', 'missing-browser', '--surface', 'browser', '--out-dir', extensionRoot],
      {
        from: 'user',
      },
    );

    await rm(path.join(extensionRoot, 'src'), { recursive: true, force: true });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await program.parseAsync(['extension', 'verify', '--cwd', extensionRoot], { from: 'user' });

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Extension verify failed: browser entrypoint "browser" has no resolvable candidate'),
    );
    expect(process.exitCode).toBe(1);
  });

  it(
    'fails verify when browser output contains unsupported bare imports',
    { timeout: EXTENSION_VERIFY_TEST_TIMEOUT_MS },
    async () => {
      const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'makaio-extension-init-'));
      tempDirs.push(tempRoot);
      const extensionRoot = path.join(tempRoot, 'unsupported-browser-import');
      const distDir = path.join(extensionRoot, 'dist');

      const program = createProgram();
      await program.parseAsync(
        ['extension', 'init', 'unsupported-browser-import', '--surface', 'browser', '--out-dir', extensionRoot],
        { from: 'user' },
      );

      await mkdir(distDir, { recursive: true });
      await writeFile(path.join(distDir, 'browser.mjs'), "import 'zod';\nexport default () => ({});\n", 'utf8');
      await rm(path.join(extensionRoot, 'src'), { recursive: true, force: true });

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      await program.parseAsync(['extension', 'verify', '--cwd', extensionRoot], { from: 'user' });

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Extension verify failed: Browser entrypoint contains unsupported bare imports: zod.'),
      );
      expect(process.exitCode).toBe(1);
    },
  );

  it(
    'fails verify when the browser bundle is not loadable ESM',
    { timeout: EXTENSION_VERIFY_TEST_TIMEOUT_MS },
    async () => {
      const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'makaio-extension-init-'));
      tempDirs.push(tempRoot);
      const extensionRoot = path.join(tempRoot, 'invalid-browser-esm');
      const distDir = path.join(extensionRoot, 'dist');

      const program = createProgram();
      await program.parseAsync(
        ['extension', 'init', 'invalid-browser-esm', '--surface', 'browser', '--out-dir', extensionRoot],
        { from: 'user' },
      );

      await mkdir(distDir, { recursive: true });
      await writeFile(
        path.join(distDir, 'browser.mjs'),
        "import './missing-chunk.mjs';\nexport default () => ({});\n",
        'utf8',
      );
      await rm(path.join(extensionRoot, 'src'), { recursive: true, force: true });

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      await program.parseAsync(['extension', 'verify', '--cwd', extensionRoot], { from: 'user' });

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Extension verify failed: Browser entrypoint is not parseable/loadable ESM:'),
      );
      expect(process.exitCode).toBe(1);
    },
  );

  it('fails fast when the target directory is non-empty', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'makaio-extension-init-'));
    tempDirs.push(tempRoot);
    const extensionRoot = path.join(tempRoot, 'occupied');
    await mkdir(extensionRoot, { recursive: true });
    await writeFile(path.join(extensionRoot, 'placeholder.txt'), 'busy', 'utf8');

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const program = createProgram();

    await program.parseAsync(['extension', 'init', 'busy-ext', '--out-dir', extensionRoot], { from: 'user' });

    expect(errorSpy).toHaveBeenCalledWith(`Extension init failed: Target directory must be empty: ${extensionRoot}`);
    expect(infoSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    await expect(access(path.join(extensionRoot, 'package.json'))).rejects.toThrow();
  });
});
