import { mkdtemp, mkdir, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLocalLauncher, type LocalExecutionSite, type OwnerLaunchOptions } from '../index.js';

const step = { kind: 'step', stepId: '../review', execution: 1 } as const;
let root: string;
let workspace: string;
let site: LocalExecutionSite;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'local-launcher-'));
  workspace = join(root, 'workspace');
  await mkdir(workspace);
  site = createLocalLauncher({
    workspaceRoot: workspace,
    stepHomeRoot: join(root, 'steps'),
    runtimeHomeRoot: join(root, 'runtime'),
  });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await site?.launcher.closeAll();
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

/**
 * Start a real test program under the default step policy.
 * @param source - Program to execute.
 * @param overrides - Launch options specific to the test.
 * @returns The started process.
 */
function run(source: string, overrides: Partial<OwnerLaunchOptions> = {}) {
  return site.launcher.launch({
    owner: step,
    command: process.execPath,
    args: ['-e', source],
    cwd: '.',
    env: {},
    timeoutMs: 10_000,
    output: { kind: 'capture', limitBytes: 4096 },
    ...overrides,
  });
}

describe('local process launcher', () => {
  it.skipIf(process.platform === 'win32')(
    'rejects invalid execution identities and native temp overrides',
    async () => {
      const owner = { ...step, execution: Number.NaN };
      await expect(run('process.exit(0)', { owner }).result).resolves.toMatchObject({ refusal: 'invalid-owner' });
      await expect(run('process.exit(0)', { env: { tEmP: 'override' } }).result).resolves.toMatchObject({
        refusal: 'reserved-entry',
      });
    },
  );

  it.each([
    'win32',
    process.platform === 'linux' ? 'darwin' : 'linux',
  ] as const)('refuses a declared %s site before any process or owner directory is created', async (platform) => {
    site = createLocalLauncher({
      platform,
      workspaceRoot: workspace,
      stepHomeRoot: join(root, 'steps'),
      runtimeHomeRoot: join(root, 'runtime'),
    });
    await expect(run('process.exit(0)').result).resolves.toEqual({
      status: 'spawn-failed',
      refusal: 'unsupported-site',
    });
    await expect(readFile(site.paths(step).home)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.skipIf(process.platform === 'win32')(
    'ignores caller-supplied local stop controls',
    async () => {
      const abort = new AbortController();
      const controls = {
        signal: abort.signal,
        killGraceMs: 60_000,
        signalPort: {
          kill: () => {
            throw new Error('Caller stop controls must not be invoked');
          },
        },
      };
      const child = run(
        "process.on('SIGTERM', () => require('node:fs').writeFileSync('got-term', 'yes')); require('node:fs').writeFileSync('ready', 'yes'); setInterval(() => {}, 1000);",
        controls,
      );
      try {
        await expect
          .poll(() => readFile(join(workspace, 'ready'), 'utf8').catch(() => ''), { timeout: 4000 })
          .toBe('yes');
      } finally {
        abort.abort();
      }
      await expect(child.result).resolves.toMatchObject({ status: 'cancelled', containment: { kind: 'quiescent' } });
      await expect(readFile(join(workspace, 'got-term'))).rejects.toMatchObject({ code: 'ENOENT' });
    },
    15_000,
  );

  it.skipIf(process.platform === 'win32')('runs with the allowlist and paths chosen by the launcher', async () => {
    vi.stubEnv('LAUNCHER_TEST_PARENT_ONLY', 'synthetic');
    const { home, tmp } = site.paths(step);
    const later = site.paths({ ...step, execution: 2 });
    expect(later.home).toBe(home);
    expect(later.tmp).not.toBe(tmp);

    const result = await run(
      `console.log(JSON.stringify({
        keys: Object.keys(process.env).filter((key) => process.platform !== 'darwin' || key !== '__CF_USER_TEXT_ENCODING'),
        home: process.env.HOME,
        tmp: process.env.TMPDIR,
        allowed: process.env.LAUNCHER_TEST_ALLOWED,
      }));`,
      { env: { LAUNCHER_TEST_ALLOWED: 'yes' } },
    ).result;
    expect(result.status).toBe('completed');
    // Node on macOS adds __CF_USER_TEXT_ENCODING during startup, after spawn's environment is set.
    expect(JSON.parse(result.output?.stdout ?? '')).toEqual({
      keys: expect.arrayContaining(['HOME', 'TMPDIR', 'LAUNCHER_TEST_ALLOWED']),
      home,
      tmp,
      allowed: 'yes',
    });
    expect(JSON.parse(result.output?.stdout ?? '').keys).toHaveLength(3);
  });

  it.skipIf(process.platform === 'win32')(
    'keeps Node startup from copying the parent coverage directory into a replacement environment',
    async () => {
      vi.stubEnv('NODE_V8_COVERAGE', join(root, 'host-coverage'));
      const source = "console.log(JSON.stringify({ hasCoverage: 'NODE_V8_COVERAGE' in process.env }));";
      const isolated = await run(source).result;
      expect(isolated.status).toBe('completed');
      expect(JSON.parse(isolated.output?.stdout ?? '')).toEqual({ hasCoverage: false });
      const allowed = await run(source, { env: { NODE_V8_COVERAGE: join(root, 'allowed-coverage') } }).result;
      expect(JSON.parse(allowed.output?.stdout ?? '')).toEqual({ hasCoverage: true });
    },
  );

  it.skipIf(process.platform === 'win32')(
    'refuses reserved variables and working directories outside the workspace',
    async () => {
      await expect(run('process.exit(0)', { env: { HOME: root } }).result).resolves.toMatchObject({
        status: 'spawn-failed',
        refusal: 'reserved-entry',
      });
      await expect(run('process.exit(0)', { cwd: '..' }).result).resolves.toMatchObject({
        status: 'spawn-failed',
        refusal: 'cwd-outside-workspace',
      });
    },
  );

  it.skipIf(process.platform === 'win32')('detects a symlink that would escape the workspace', async () => {
    await symlink(root, join(workspace, 'outside'));
    await expect(run('process.exit(0)', { cwd: 'outside' }).result).resolves.toMatchObject({
      status: 'spawn-failed',
      refusal: 'cwd-outside-workspace',
    });
  });

  it.skipIf(process.platform === 'win32')('reports when a member outlives a naturally exited leader', async () => {
    const child = run(
      `
      const { spawn } = require('node:child_process');
      const member = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      console.log(member.pid);
      member.unref();
    `,
    );
    const result = await child.result;
    const survivor = Number(result.output?.stdout);
    try {
      expect(survivor).toBeGreaterThan(1);
      expect(result).toMatchObject({
        status: 'stop-failed',
        exitCode: 0,
        containment: { kind: 'unproven', boundary: 'process-group', reason: 'members-remain' },
      });
    } finally {
      if (survivor > 1) {
        try {
          process.kill(survivor, 'SIGKILL');
        } catch {
          /* It has already stopped. */
        }
      }
    }
  });

  it.skipIf(process.platform === 'win32').each([false, true])(
    'checks the actual cancellation boundary with a grandchild (detached: %s)',
    async (detached) => {
      const abort = new AbortController();
      const child = run(
        `
        const { spawn } = require('node:child_process');
        const script = "process.on('SIGTERM', () => {}); require('node:fs').writeFileSync('grandchild.pid', String(process.pid)); setInterval(() => {}, 1000);";
        spawn(process.execPath, ['-e', script], { detached: ${detached}, stdio: 'ignore' }).unref();
        setInterval(() => {}, 1000);
      `,
        { signal: abort.signal },
      );
      let pid = 0;
      let groupStopped = false;
      try {
        await expect
          .poll(
            async () => {
              pid = Number(await readFile(join(workspace, 'grandchild.pid'), 'utf8').catch(() => '0'));
              return pid;
            },
            { timeout: 4000 },
          )
          .toBeGreaterThan(1);
        abort.abort();
        const result = await child.result;
        groupStopped = result.containment?.kind === 'quiescent';
        expect(result).toMatchObject({
          status: 'cancelled',
          containment: { kind: 'quiescent', boundary: 'process-group' },
        });
        if (detached) expect(() => process.kill(pid, 0)).not.toThrow();
      } finally {
        abort.abort();
        if (pid > 1 && (detached || !groupStopped)) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            /* The group already stopped it. */
          }
        }
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'waits for owner shutdown and refuses later launches for that owner',
    async () => {
      const child = run("require('node:fs').writeFileSync('ready', 'running'); setInterval(() => {}, 1000);");
      await expect
        .poll(() => readFile(join(workspace, 'ready'), 'utf8').catch(() => ''), { timeout: 4000 })
        .toBe('running');

      const closing = site.launcher.closeOwner(step);
      expect(site.launcher.closeOwner(step)).toBe(closing);
      await expect(closing).resolves.toEqual({ kind: 'quiescent', boundary: 'process-group' });
      await expect(child.result).resolves.toMatchObject({
        status: 'cancelled',
        containment: { kind: 'quiescent', boundary: 'process-group' },
      });
      await expect(run('process.exit(0)').result).resolves.toMatchObject({
        status: 'spawn-failed',
        refusal: 'owner-closed',
      });
      await expect(run('process.exit(0)', { owner: { ...step, execution: 2 } }).result).resolves.toMatchObject({
        status: 'completed',
      });
    },
  );
});
