import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, type TestContext } from 'vitest';
import { AdapterSubsystemSubjects } from '@makaio/services-core/adapter-subsystem';
import { startCliServe } from './harness/spawn-serve.js';
import { connectTestBus, waitForBoot, waitForRuntimeReady } from './harness/bus-helpers.js';
import { useServeFixture } from './harness/serve-fixture.js';
import {
  DEVEX_SMOKE_ADAPTER_NAME,
  DEVEX_SMOKE_API_KEY_ENV,
  DEVEX_SMOKE_CANONICAL_MODEL,
  DEVEX_SMOKE_MODEL,
  DEVEX_SMOKE_PROVIDER_CONFIG_ID,
  DEVEX_SMOKE_PROVIDER_CONFIG_NAME,
  DEVEX_SMOKE_PROVIDER_ID,
} from './fixtures/devex-smoke/shared.js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SDK_SMOKE_ENTRY = path.resolve(__dirname, './harness/cli-serve-sdk-smoke-entry.ts');
const REPO_ROOT = path.resolve(__dirname, '../../../');
const PYTHON_SEND_MESSAGE_EXAMPLE = path.resolve(REPO_ROOT, 'sdks/python/examples/send_message.py');
const PYTHON_SDK_ROOT = path.resolve(REPO_ROOT, 'sdks/python');
const PYTHON_REQUIREMENTS_PATH = path.resolve(PYTHON_SDK_ROOT, 'requirements.txt');
const PYTHON_DISCOVERY_TIMEOUT_MS = 5_000;
const PYTHON_VENV_TIMEOUT_MS = 60_000;
const PYTHON_SDK_INSTALL_TIMEOUT_MS = 120_000;
// The example owns two sequential 30-second protocol deadlines; this outer guard only bounds a runaway process.
const PYTHON_EXAMPLE_TIMEOUT_MS = 70_000;
const CLI_SDK_SMOKE_TEST_TIMEOUT_MS = 480_000;
const PYTHON_SDK_MIN_MAJOR = 3;
const PYTHON_SDK_MIN_MINOR = 10;

interface PythonCandidate {
  readonly command: string;
  readonly prefixArgs: readonly string[];
}

interface PythonRuntime {
  readonly command: string;
  readonly prefixArgs: readonly string[];
}

class PythonRuntimeUnavailableError extends Error {
  public constructor() {
    super(`Unable to find Python ${PYTHON_SDK_MIN_MAJOR}.${PYTHON_SDK_MIN_MINOR}+ for the SDK smoke example`);
    this.name = 'PythonRuntimeUnavailableError';
  }
}

const PYTHON_CANDIDATES: readonly PythonCandidate[] =
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
 * Parses the major/minor version from `python --version` output.
 * @param output - Combined stdout/stderr text from the version command.
 * @returns Parsed major/minor pair, or null when the output is not recognized.
 */
function parsePythonVersion(output: string): { readonly major: number; readonly minor: number } | null {
  const match = /Python\s+(\d+)\.(\d+)/u.exec(output);
  if (match === null) return null;
  return { major: Number(match[1]), minor: Number(match[2]) };
}

/**
 * Checks compatibility with the Python SDK package metadata.
 * @param version - Parsed Python major/minor version.
 * @returns True when the runtime can install and run the local SDK.
 */
function isPythonSdkCompatible(version: { readonly major: number; readonly minor: number }): boolean {
  return (
    version.major > PYTHON_SDK_MIN_MAJOR ||
    (version.major === PYTHON_SDK_MIN_MAJOR && version.minor >= PYTHON_SDK_MIN_MINOR)
  );
}

/**
 * Resolve a Python interpreter with platform fallback.
 * @returns Python runtime command and prefix arguments.
 */
async function resolvePythonRuntime(): Promise<PythonRuntime> {
  for (const candidate of PYTHON_CANDIDATES) {
    try {
      const { stdout, stderr } = await execFileAsync(candidate.command, [...candidate.prefixArgs, '--version'], {
        encoding: 'utf8',
        timeout: PYTHON_DISCOVERY_TIMEOUT_MS,
      });
      const version = parsePythonVersion(`${stdout}\n${stderr}`);
      if (version === null || !isPythonSdkCompatible(version)) {
        continue;
      }
      return candidate;
    } catch (error) {
      const errorCode =
        typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code;
      const missingExecutable = errorCode === 'ENOENT';
      const probeFailed = typeof errorCode === 'number';
      if (missingExecutable || probeFailed) {
        continue;
      }
      throw error;
    }
  }

  throw new PythonRuntimeUnavailableError();
}

/**
 * Create an isolated Python environment with pinned SDK dependencies and the local SDK.
 * @param python - Python runtime used to create the environment.
 * @param tempRoot - Temporary test root.
 * @returns Python runtime inside the created virtual environment.
 */
async function createPythonSdkRuntime(python: PythonRuntime, tempRoot: string): Promise<PythonRuntime> {
  const venvDir = path.join(tempRoot, '.venv');
  await execFileAsync(python.command, [...python.prefixArgs, '-m', 'venv', venvDir], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: PYTHON_VENV_TIMEOUT_MS,
  });

  const venvPython =
    process.platform === 'win32' ? path.join(venvDir, 'Scripts', 'python.exe') : path.join(venvDir, 'bin', 'python');

  await execFileAsync(venvPython, ['-m', 'pip', 'install', '--disable-pip-version-check', '--upgrade', 'pip'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: PYTHON_SDK_INSTALL_TIMEOUT_MS,
  });

  await execFileAsync(
    venvPython,
    ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', PYTHON_REQUIREMENTS_PATH],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: PYTHON_SDK_INSTALL_TIMEOUT_MS,
    },
  );

  // The pinned requirements file owns third-party dependency resolution; this step only installs the checked-out SDK.
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
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: PYTHON_SDK_INSTALL_TIMEOUT_MS,
    },
  );

  return { command: venvPython, prefixArgs: [] };
}

/**
 * Execute the Python SDK example with its declared dependencies installed.
 * @param port - Bound bus port of the spawned CLI runtime.
 * @param python - Python runtime used to execute the example.
 * @returns Captured stdout/stderr from the example.
 */
async function runPythonSdkExample(port: number, python: PythonRuntime): Promise<{ stdout: string; stderr: string }> {
  const busUrl = `ws://127.0.0.1:${port}/bus`;

  try {
    return await execFileAsync(
      python.command,
      [
        ...python.prefixArgs,
        PYTHON_SEND_MESSAGE_EXAMPLE,
        '--model',
        DEVEX_SMOKE_CANONICAL_MODEL,
        '--message',
        'Hello from the SDK smoke test',
      ],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          MAKAIO_BUS_URL: busUrl,
          PYTHONUNBUFFERED: '1',
        },
        encoding: 'utf8',
        timeout: PYTHON_EXAMPLE_TIMEOUT_MS,
      },
    );
  } catch (error) {
    const failed = error as {
      code?: number;
      killed?: boolean;
      signal?: NodeJS.Signals;
      stdout?: string;
      stderr?: string;
    };
    throw new Error(
      `Python SDK example failed: ${JSON.stringify({
        code: failed.code,
        killed: failed.killed,
        signal: failed.signal,
        stdout: failed.stdout ?? '',
        stderr: failed.stderr ?? '',
      })}`,
      { cause: error },
    );
  }
}

/**
 * Write the canonical provider/adapter files used by the SDK smoke runtime.
 * @param homeDir - Isolated HOME directory for the spawned runtime.
 */
async function writeCanonicalFixtureConfig(homeDir: string): Promise<void> {
  const makaioHome = path.join(homeDir, '.makaio');
  const providerConfigPath = path.join(makaioHome, 'provider-configs', `${DEVEX_SMOKE_PROVIDER_CONFIG_ID}.json`);
  const adapterConfigPath = path.join(makaioHome, 'adapters', `${DEVEX_SMOKE_ADAPTER_NAME}.json`);

  await fs.mkdir(path.dirname(providerConfigPath), { recursive: true });
  await fs.mkdir(path.dirname(adapterConfigPath), { recursive: true });

  await fs.writeFile(
    providerConfigPath,
    `${JSON.stringify(
      {
        $schema: 'makaio/provider-config/v2',
        definitionId: DEVEX_SMOKE_PROVIDER_ID,
        name: DEVEX_SMOKE_PROVIDER_CONFIG_NAME,
        auth: {
          mode: 'none',
          method: {
            owner: 'provider',
            providerDefinitionId: DEVEX_SMOKE_PROVIDER_ID,
            methodId: 'none',
          },
        },
        enabled: true,
        isDefault: true,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  await fs.writeFile(
    adapterConfigPath,
    `${JSON.stringify(
      {
        $schema: 'makaio/adapter-config/v1',
        enabled: true,
        displayName: 'DevEx Smoke Adapter',
        providerDefinitionIds: [DEVEX_SMOKE_PROVIDER_ID],
        bindings: [{ providerConfigId: DEVEX_SMOKE_PROVIDER_CONFIG_ID, isDefault: true }],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

describe('CLI SDK example smoke test', { timeout: CLI_SDK_SMOKE_TEST_TIMEOUT_MS }, () => {
  const serve = useServeFixture();

  it('boots from canonical files and runs the Python send_message example against a local-only adapter', async (context: TestContext) => {
    let hostPython: PythonRuntime;
    try {
      hostPython = await resolvePythonRuntime();
    } catch (error) {
      if (error instanceof PythonRuntimeUnavailableError) {
        context.skip();
        return;
      }
      throw error;
    }

    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'makaio-cli-sdk-smoke-'));
    try {
      const homeDir = path.join(tempRoot, 'home');
      await fs.mkdir(homeDir, { recursive: true });
      await writeCanonicalFixtureConfig(homeDir);
      const python = await createPythonSdkRuntime(hostPython, tempRoot);

      serve.current = await startCliServe({
        entryPath: SDK_SMOKE_ENTRY,
        env: { HOME: homeDir, USERPROFILE: homeDir, [DEVEX_SMOKE_API_KEY_ENV]: 'devex-smoke-token' },
        timeoutMs: 40_000,
      });

      const bus = await connectTestBus(serve.current.port);
      try {
        await waitForBoot(bus, 30_000);
        await waitForRuntimeReady(bus, 20_000);

        const { adapters } = await bus.request(AdapterSubsystemSubjects.listAdapters, {});
        expect(adapters.find((adapter) => adapter.name === DEVEX_SMOKE_ADAPTER_NAME)).toMatchObject({
          name: DEVEX_SMOKE_ADAPTER_NAME,
          enabled: true,
          readiness: 'ready',
          providerDefinitionIds: [DEVEX_SMOKE_PROVIDER_ID],
        });
      } finally {
        bus.disconnect();
      }

      const { stdout, stderr } = await runPythonSdkExample(serve.current.port, python);

      expect(stderr.trim()).toBe('');
      expect(stdout).toContain('session.user_message.sent:');
      expect(stdout).toContain('session_id=');
      expect(stdout).toContain('messageId');
      expect(stdout).toContain('turnId');
      expect(stdout).toContain(DEVEX_SMOKE_MODEL);
    } finally {
      if (serve.current) {
        await serve.current.sendSignal('SIGTERM');
        serve.current = null;
      }
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});
