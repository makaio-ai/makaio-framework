/**
 * SDK send_message E2E test — live API.
 *
 * Spawns a real `makaio serve` instance with the `claude-code` adapter
 * configured via `anthropic-oauth` (SDK-embedded OAuth, no API key needed).
 * Runs the Python and Rust `send_message` examples against it with
 * `--model claude-code::haiku` and asserts the model replies with "OK".
 *
 * This test costs money and is NOT included in the standard test suite.
 * Run explicitly via `yarn test:sdks`.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { createServer } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { AdapterSubsystemSubjects } from '@makaio/services-core/adapter-subsystem';
import { startCliServe, type ServeProcess } from '../../apps/cli/e2e/harness/spawn-serve.js';
import { connectTestBus, waitForBoot, waitForRuntimeReady } from '../../apps/cli/e2e/harness/bus-helpers.js';

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const CLI_SERVE_ENTRY = path.resolve(REPO_ROOT, 'framework/apps/cli/e2e/harness/cli-serve-entry.ts');
const PYTHON_SDK_ROOT = path.resolve(REPO_ROOT, 'framework/sdks/python');
const PYTHON_SEND_MESSAGE = path.resolve(PYTHON_SDK_ROOT, 'examples/send_message.py');
const PYTHON_REQUIREMENTS = path.resolve(PYTHON_SDK_ROOT, 'requirements.txt');
const RUST_SDK_ROOT = path.resolve(REPO_ROOT, 'framework/sdks/rust');

const CANONICAL_MODEL = 'claude-code::haiku';
const TEST_MESSAGE = 'Reply with the single word: OK';
const BOOT_TIMEOUT_MS = 60_000;
const RUNTIME_READY_TIMEOUT_MS = 30_000;
const ADAPTER_READY_TIMEOUT_MS = 30_000;
const PYTHON_VENV_TIMEOUT_MS = 60_000;
const PYTHON_INSTALL_TIMEOUT_MS = 120_000;
const EXAMPLE_TIMEOUT_MS = 60_000;
const RUST_BUILD_TIMEOUT_MS = 300_000;

// ---------------------------------------------------------------------------
// Python runtime helpers
// ---------------------------------------------------------------------------

interface PythonRuntime {
  readonly command: string;
  readonly prefixArgs: readonly string[];
}

const PYTHON_CANDIDATES: readonly PythonRuntime[] =
  process.platform === 'win32'
    ? [
        { command: 'py', prefixArgs: ['-3'] },
        { command: 'python3', prefixArgs: [] },
        { command: 'python', prefixArgs: [] },
      ]
    : [
        { command: 'python3', prefixArgs: [] },
        { command: 'python', prefixArgs: [] },
      ];

/**
 * Resolve a Python interpreter with platform fallback.
 * @returns Python runtime command and prefix arguments.
 */
async function resolvePythonRuntime(): Promise<PythonRuntime> {
  for (const candidate of PYTHON_CANDIDATES) {
    try {
      await execFileAsync(candidate.command, [...candidate.prefixArgs, '--version'], {
        encoding: 'utf8',
        timeout: 5_000,
      });
      return candidate;
    } catch {
      // ENOENT (command missing), non-zero exit (py launcher without Python 3
      // registered), or timeout — try the next candidate.
      continue;
    }
  }
  throw new Error('No Python interpreter found');
}

/**
 * Create an isolated Python venv with the local SDK installed.
 * @param python - Python runtime to create the venv with.
 * @param venvRoot - Directory to create the venv in.
 * @returns Python runtime inside the venv.
 */
async function createPythonVenv(python: PythonRuntime, venvRoot: string): Promise<PythonRuntime> {
  const venvDir = path.join(venvRoot, '.venv');
  await execFileAsync(python.command, [...python.prefixArgs, '-m', 'venv', venvDir], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: PYTHON_VENV_TIMEOUT_MS,
  });

  const venvPython =
    process.platform === 'win32' ? path.join(venvDir, 'Scripts', 'python.exe') : path.join(venvDir, 'bin', 'python');

  await execFileAsync(venvPython, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', PYTHON_REQUIREMENTS], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: PYTHON_INSTALL_TIMEOUT_MS,
  });

  await execFileAsync(
    venvPython,
    [
      '-m',
      'pip',
      'install',
      '--disable-pip-version-check',
      '--no-build-isolation',
      '--no-deps',
      '--editable',
      PYTHON_SDK_ROOT,
    ],
    { cwd: REPO_ROOT, encoding: 'utf8', timeout: PYTHON_INSTALL_TIMEOUT_MS },
  );

  return { command: venvPython, prefixArgs: [] };
}

// ---------------------------------------------------------------------------
// Rust build helper
// ---------------------------------------------------------------------------

/**
 * Build the Rust send_message example and return the binary path.
 * @returns Absolute path to the compiled example binary.
 */
async function buildRustExample(): Promise<string> {
  await execFileAsync('cargo', ['build', '--example', 'send_message'], {
    cwd: RUST_SDK_ROOT,
    encoding: 'utf8',
    timeout: RUST_BUILD_TIMEOUT_MS,
  });

  const binaryName = process.platform === 'win32' ? 'send_message.exe' : 'send_message';
  return path.join(RUST_SDK_ROOT, 'target/debug/examples', binaryName);
}

// ---------------------------------------------------------------------------
// Config and infrastructure helpers
// ---------------------------------------------------------------------------

/**
 * Write minimal OAuth provider + adapter config files into a temp HOME.
 *
 * The `anthropic-oauth` provider definition has no `credentialEnvVars`, so
 * credential resolution short-circuits (empty refs → `{}`). The `claude`
 * binary handles auth via its own OAuth credential store.
 * @param homeDir - Temp HOME directory to write config into.
 */
async function writeOAuthConfig(homeDir: string): Promise<void> {
  const makaioHome = path.join(homeDir, '.makaio');
  const providerConfigDir = path.join(makaioHome, 'provider-configs');
  const adapterConfigDir = path.join(makaioHome, 'adapters');

  await fs.mkdir(providerConfigDir, { recursive: true });
  await fs.mkdir(adapterConfigDir, { recursive: true });

  await fs.writeFile(
    path.join(providerConfigDir, 'anthropic-oauth.json'),
    JSON.stringify(
      {
        $schema: 'makaio/provider-config/v1',
        definitionId: 'anthropic-oauth',
        name: 'Anthropic (Subscription)',
        enabled: true,
        isDefault: true,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  await fs.writeFile(
    path.join(adapterConfigDir, 'claude-code.json'),
    JSON.stringify(
      {
        $schema: 'makaio/adapter-config/v1',
        enabled: true,
        displayName: 'Claude Code',
        bindings: [{ providerConfigId: 'anthropic-oauth', isDefault: true }],
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
}

/**
 * Symlink the `claude` binary's credential files into the temp HOME.
 *
 * The `claude` binary reads OAuth credentials from `$HOME/.claude/` and may
 * consult `$HOME/.claude.json` for local configuration. By linking/copying
 * these paths we allow the binary to find its auth while Makaio config is
 * isolated in the temp HOME. Writes during the test (e.g. token refresh) go
 * to the real credential store — this is safe and intentional.
 * @param realHome - User's actual HOME directory.
 * @param tempHome - Temp HOME directory for the test.
 */
async function symlinkClaudeCredentials(realHome: string, tempHome: string): Promise<void> {
  await symlinkIfPresent(path.join(realHome, '.claude'), path.join(tempHome, '.claude'), 'dir');
  // On Windows, file symlinks require elevated privileges — copy instead.
  if (process.platform === 'win32') {
    await copyIfPresent(path.join(realHome, '.claude.json'), path.join(tempHome, '.claude.json'));
  } else {
    await symlinkIfPresent(path.join(realHome, '.claude.json'), path.join(tempHome, '.claude.json'), 'file');
  }
}

/**
 * Symlink a credential path when it exists, preserving unexpected filesystem errors.
 * @param sourcePath - Real credential path.
 * @param targetPath - Temp HOME symlink path.
 * @param type - Symlink target type.
 */
async function symlinkIfPresent(sourcePath: string, targetPath: string, type: 'dir' | 'file'): Promise<void> {
  try {
    await fs.stat(sourcePath);
    // Use 'junction' for directories on Windows — junctions don't require elevated privileges.
    const linkType = type === 'dir' && process.platform === 'win32' ? 'junction' : type;
    await fs.symlink(sourcePath, targetPath, linkType);
  } catch (error) {
    const missingCredentials = (error as NodeJS.ErrnoException).code === 'ENOENT';
    if (!missingCredentials) throw error;
    // Missing Claude credentials/config — test will fail at adapter level with a clear auth error.
  }
}

/**
 * Copy a file if it exists, ignoring missing files.
 * @param sourcePath - Source file path.
 * @param targetPath - Destination file path.
 */
async function copyIfPresent(sourcePath: string, targetPath: string): Promise<void> {
  try {
    await fs.copyFile(sourcePath, targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/**
 * Poll until the `claude-code` adapter reports `readiness: 'ready'`.
 * @param port - Bus port of the spawned CLI runtime.
 * @param timeoutMs - Maximum wait time.
 */
async function waitForAdapterReady(port: number, timeoutMs: number): Promise<void> {
  const bus = await connectTestBus(port);
  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const { adapters } = await bus.request(AdapterSubsystemSubjects.listAdapters, {});
      const claudeCode = adapters.find((a) => a.name === 'claude-code');
      if (claudeCode?.readiness === 'ready') return;
      await new Promise((r) => setTimeout(r, 1_000));
    }
    throw new Error(`claude-code adapter did not become ready within ${timeoutMs}ms`);
  } finally {
    bus.disconnect();
  }
}

// ---------------------------------------------------------------------------
// Network helpers
// ---------------------------------------------------------------------------

/**
 * Bind to an ephemeral port, capture the assigned port, then close the server.
 * The returned port was available at call time and is now closed/refused,
 * which is safe to use as a "nothing is listening" address in tests.
 * @returns The ephemeral port number that was reserved and immediately closed.
 */
async function reserveClosedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close();
        reject(new Error('Could not resolve ephemeral port'));
        return;
      }
      const port = addr.port;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('SDK send_message E2E (live API)', { timeout: 600_000 }, () => {
  let serve: ServeProcess | null = null;
  let tempRoot: string;
  let busPort: number;
  let pythonVenv: PythonRuntime;

  beforeAll(async () => {
    const realHome = process.env['HOME'] ?? os.homedir();
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'makaio-sdk-e2e-'));
    const homeDir = path.join(tempRoot, 'home');
    await fs.mkdir(homeDir, { recursive: true });

    await writeOAuthConfig(homeDir);
    await symlinkClaudeCredentials(realHome, homeDir);

    serve = await startCliServe({
      entryPath: CLI_SERVE_ENTRY,
      env: { HOME: homeDir, USERPROFILE: homeDir },
      timeoutMs: BOOT_TIMEOUT_MS,
    });
    busPort = serve.port;

    const bus = await connectTestBus(busPort);
    try {
      await waitForBoot(bus, BOOT_TIMEOUT_MS);
      await waitForRuntimeReady(bus, RUNTIME_READY_TIMEOUT_MS);
    } finally {
      bus.disconnect();
    }

    await waitForAdapterReady(busPort, ADAPTER_READY_TIMEOUT_MS);

    pythonVenv = await createPythonVenv(await resolvePythonRuntime(), tempRoot);
  });

  afterAll(async () => {
    try {
      if (serve) {
        await serve.sendSignal('SIGTERM');
        serve = null;
      }
    } finally {
      if (tempRoot) {
        await fs.rm(tempRoot, { recursive: true, force: true });
      }
    }
  });

  it('Python send_message.py receives OK from claude-code::haiku', async () => {
    const { stdout, stderr } = await execFileAsync(
      pythonVenv.command,
      [...pythonVenv.prefixArgs, PYTHON_SEND_MESSAGE, '--model', CANONICAL_MODEL, '--message', TEST_MESSAGE],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          MAKAIO_BUS_URL: `ws://127.0.0.1:${busPort}/bus`,
        },
        encoding: 'utf8',
        timeout: EXAMPLE_TIMEOUT_MS,
      },
    );

    expect(stderr).not.toMatch(/error/i);
    expect(stdout).toContain('session_id=');
    expect(stdout).toMatch(/^agent\..+\bOK\b/m);
    expect(stdout).toContain('turn.completed');
  });

  it('Python send_message.py fails with clear error when bus is unreachable', async () => {
    const deadPort = await reserveClosedPort();
    try {
      await execFileAsync(
        pythonVenv.command,
        [...pythonVenv.prefixArgs, PYTHON_SEND_MESSAGE, '--model', CANONICAL_MODEL, '--message', TEST_MESSAGE],
        {
          cwd: REPO_ROOT,
          env: {
            ...process.env,
            MAKAIO_BUS_URL: `ws://127.0.0.1:${deadPort}/bus`,
          },
          encoding: 'utf8',
          timeout: EXAMPLE_TIMEOUT_MS,
        },
      );
      expect.fail('Expected non-zero exit from send_message.py against dead bus');
    } catch (error) {
      const execError = error as { code: number | null; stderr: string };
      expect(execError.code).not.toBe(0);
      expect(execError.stderr).toMatch(/(connection refused|connect call failed|econnrefused)/i);
    }
  });

  it('Rust send_message receives OK from claude-code::haiku', async () => {
    const binary = await buildRustExample();

    const { stdout, stderr } = await execFileAsync(binary, ['--model', CANONICAL_MODEL], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        MAKAIO_BUS_URL: `ws://127.0.0.1:${busPort}/bus`,
        MAKAIO_MESSAGE: TEST_MESSAGE,
      },
      encoding: 'utf8',
      timeout: EXAMPLE_TIMEOUT_MS,
    });

    expect(stderr).not.toMatch(/error/i);
    expect(stdout).toContain('session_id=');
    expect(stdout).toMatch(/^agent\..+\bOK\b/m);
    expect(stdout).toContain('turn.completed');
  });
});
