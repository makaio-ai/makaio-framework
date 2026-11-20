/**
 * How `launch` derives its status from the proof of a quiescent process group when the proof is disturbed.
 *
 * This file carries the one mock of the package's launch tests, and only because a real host cannot produce
 * on demand what these cases need: `ps` output that is malformed, empty, lists the wrong group, or fails once
 * and then answers. `execFile` of `node:child_process` is wrapped at the boundary to `ps`; the real `spawn`
 * and every other `execFile` call stay real. A replaced `ps` answer is still produced by a real process (a
 * Node child that prints the text or exits non-zero). A missing `ps` is NOT mocked: it comes from an empty
 * `PATH`. Denied signals come from the injected `signalPort` in front of a real child.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { launch, type LaunchOptions, type LaunchResult } from '../launch.js';
import type { ProcessSignalPort } from '../process-tree.js';

/** What a replaced `ps` query answers: the text it prints, or a failure that is not a missing executable. */
type PsAnswer = string | 'fail';

const psBoundary = vi.hoisted(() => ({
  /** Every `ps` query of the test, replaced or not. */
  queries: 0,
  /** Decides the answer of a query (1-based); `undefined` lets the real `ps` run. */
  answer: undefined as ((query: number) => PsAnswer) | undefined,
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: vi.fn((...args: Parameters<typeof actual.execFile>) => {
      const [file, , options, callback] = args;
      if (file !== 'ps') return actual.execFile(...args);
      psBoundary.queries += 1;
      const answer = psBoundary.answer?.(psBoundary.queries);
      if (answer === undefined) return actual.execFile(...args);
      const script = answer === 'fail' ? 'process.exit(1)' : `process.stdout.write(${JSON.stringify(answer)})`;
      return actual.execFile(process.execPath, ['-e', script], options, callback);
    }),
  };
});

const describePosix = process.platform === 'win32' ? describe.skip : describe;

/** Bounds small enough to keep every case short. */
const BOUNDS = { killGraceMs: 150, exitObservationMs: 1_000, quiescenceProofTimeoutMs: 400 } as const;

/** Proof budget of the cases that must end quiescent: a replaced ps answer costs a Node start. */
const PROOF_BUDGET_MS = 3_000;

/** A leader that reports readiness through a file, ignores SIGTERM, and stays. */
const READY_IGNORING_SIGTERM =
  "process.on('SIGTERM',()=>{});require('fs').writeFileSync('ready','yes');setInterval(()=>{},100)";
/** A leader that reports readiness through a file and stays; SIGTERM ends it. */
const READY_AND_STAY = "require('fs').writeFileSync('ready','yes');setInterval(()=>{},100)";
/** A leader that exits 0 at once while a grandchild of its group runs for 700 ms. */
const EXIT_LEAVING_SHORT_GRANDCHILD = `require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},700)'],{stdio:'ignore'});process.exit(0)`;

/** Directories and groups a test created; cleaned after it. */
const temporaryDirectories: string[] = [];
const startedGroups: number[] = [];

let workDirectory: string;

beforeEach(async () => {
  psBoundary.queries = 0;
  psBoundary.answer = undefined;
  workDirectory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'launch-proof-')));
  temporaryDirectories.push(workDirectory);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  psBoundary.answer = undefined;
  for (const pid of startedGroups.splice(0)) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // The group already ended, which is what every passing test leaves behind.
    }
  }
  for (const directory of temporaryDirectories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

/**
 * Put an empty directory on the `PATH`, so that no `ps` executable can be found.
 */
async function removePsFromPath(): Promise<void> {
  const emptyPath = await fs.mkdtemp(path.join(os.tmpdir(), 'no-ps-'));
  temporaryDirectories.push(emptyPath);
  vi.stubEnv('PATH', emptyPath);
}

/** A signal the injected port treats in a particular way. */
type SignalRule =
  /** Reaches the real group. */
  | 'pass'
  /** Answers `EPERM`; nothing reaches the group. */
  | 'deny'
  /** Answers success and sends nothing. */
  | 'swallow'
  /** Reaches the real group, then answers `EPERM` (the host reports it after the effect). */
  | 'pass-then-deny'
  /** Ends the leader alone, then answers `EPERM` (the group counts as not signalled). */
  | 'leader-then-deny';

interface PortRules {
  /** What a group liveness probe (`kill(-pid, 0)`) does; defaults to `pass`. */
  readonly probe?: () => 'pass' | 'deny';
  /** What a stop signal does; defaults to `pass`. */
  readonly signal?: (signal: NodeJS.Signals) => SignalRule;
}

interface RecordingPort {
  readonly port: ProcessSignalPort;
  /** Every stop signal that was attempted on the group, in order. */
  readonly signals: NodeJS.Signals[];
  /** Number of liveness probes. */
  readonly probes: () => number;
}

/**
 * Build a signal port in front of the real host that records what reaches it.
 * @param rules - How probes and stop signals are treated.
 * @returns The port and its record.
 */
function recordingPort(rules: PortRules = {}): RecordingPort {
  const signals: NodeJS.Signals[] = [];
  let probes = 0;
  const denied = (): never => {
    throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
  };
  return {
    signals,
    probes: () => probes,
    port: {
      kill: (target, signal) => {
        if (signal === 0) {
          probes += 1;
          if ((rules.probe?.() ?? 'pass') === 'deny') denied();
          process.kill(target, 0);
          return;
        }
        signals.push(signal);
        const rule = rules.signal?.(signal) ?? 'pass';
        if (rule === 'swallow') return;
        if (rule === 'deny') denied();
        if (rule === 'leader-then-deny') {
          process.kill(-target, signal);
          denied();
        }
        process.kill(target, signal);
        if (rule === 'pass-then-deny') denied();
      },
    },
  };
}

/**
 * Start an inline Node program with short bounds and remember its group for the cleanup.
 * @param source - Inline Node program; its working directory is the test's temporary directory.
 * @param overrides - Options that replace the defaults of the helper.
 * @returns The handle of the launch.
 */
function start(source: string, overrides: Partial<LaunchOptions> = {}): ReturnType<typeof launch> {
  const handle = launch({
    command: process.execPath,
    args: ['-e', source],
    cwd: workDirectory,
    envMode: 'merge',
    timeoutMs: 20_000,
    output: { kind: 'ignore' },
    ...BOUNDS,
    ...overrides,
  });
  if (handle.pid !== undefined) startedGroups.push(handle.pid);
  return handle;
}

/**
 * Wait until the leader reported that it is ready.
 */
async function leaderReady(): Promise<void> {
  await expect.poll(() => fs.readFile(path.join(workDirectory, 'ready'), 'utf8').catch(() => '')).toBe('yes');
}

/**
 * Start a long-running leader, wait for it, and abort it.
 * @param source - Program of the leader.
 * @param overrides - Options that replace the defaults of the helper.
 * @returns The handle and the result of the aborted launch.
 */
async function startAndAbort(
  source: string,
  overrides: Partial<LaunchOptions> = {},
): Promise<{ readonly handle: ReturnType<typeof launch>; readonly result: LaunchResult }> {
  const abort = new AbortController();
  const handle = start(source, { ...overrides, signal: abort.signal });
  await leaderReady();
  abort.abort();
  return { handle, result: await handle.result };
}

describePosix('launch: the proof of a quiescent group under a disturbed ps', () => {
  it('waits for a group that ends by itself when no ps exists, and queries ps only once', async () => {
    await removePsFromPath();
    const result = await start(EXIT_LEAVING_SHORT_GRANDCHILD, { quiescenceProofTimeoutMs: PROOF_BUDGET_MS }).result;
    expect(result).toMatchObject({
      status: 'completed',
      exit: { kind: 'exited', code: 0 },
      group: { tree: { kind: 'quiescent' }, signalDelivered: false },
    });
    // A host without a ps executable never grows one: the first ENOENT latches, and the probe
    // waits for the group to answer ESRCH instead of spending its budget on the same failure.
    expect(psBoundary.queries).toBe(1);
  });

  it.each([
    ['malformed', 'not-a-process-row\n'],
    ['empty', ''],
    ['unmatched zombie', '999999 Z\n'],
  ] as const)('treats %s ps output as live until the group disappears', async (_name, stdout) => {
    psBoundary.answer = () => stdout;
    const result = await start(EXIT_LEAVING_SHORT_GRANDCHILD, { quiescenceProofTimeoutMs: PROOF_BUDGET_MS }).result;
    expect(result).toMatchObject({
      status: 'completed',
      exit: { kind: 'exited', code: 0 },
      group: { tree: { kind: 'quiescent' }, signalDelivered: false },
    });
    // The group only ended when the grandchild did; ps never decided that.
    expect(psBoundary.queries).toBeGreaterThanOrEqual(2);
  });

  it.each([
    ['zombie-only', 'cancelled', 'quiescent'],
    ['disappeared', 'cancelled', 'quiescent'],
    ['live', 'stop-failed', 'unproven'],
    ['unavailable', 'stop-failed', 'unproven'],
    ['malformed', 'stop-failed', 'unproven'],
    ['empty', 'stop-failed', 'unproven'],
    ['unmatched zombie', 'stop-failed', 'unproven'],
  ] as const)('requires quiescence proof when the group probes are denied with %s group evidence', async (evidence, status, tree) => {
    let leaderPid = 0;
    psBoundary.answer = () => {
      switch (evidence) {
        case 'zombie-only':
          return `${leaderPid} Z\n`;
        case 'live':
          return `${leaderPid} S\n`;
        case 'unmatched zombie':
          return `${leaderPid + 1} Z\n`;
        case 'malformed':
          return 'not-a-process-row\n';
        case 'unavailable':
          return 'fail';
        default:
          return '';
      }
    };
    // The real SIGTERM ends the real leader; only the probes are denied. A `disappeared` group is
    // then found by the first probe that follows an unhelpful ps answer.
    const recorded = recordingPort({
      probe: () => (evidence === 'disappeared' && psBoundary.queries > 0 ? 'pass' : 'deny'),
    });
    const abort = new AbortController();
    const handle = start(READY_AND_STAY, {
      signal: abort.signal,
      signalPort: recorded.port,
      quiescenceProofTimeoutMs: tree === 'quiescent' ? PROOF_BUDGET_MS : BOUNDS.quiescenceProofTimeoutMs,
    });
    leaderPid = handle.pid ?? 0;
    await leaderReady();
    abort.abort();
    const result = await handle.result;
    expect(result.status).toBe(status);
    expect(result.group?.tree.kind).toBe(tree);
    expect(result.group?.signalDelivered).toBe(true);
    // Nothing is signalled after the close; only the probes are denied.
    expect(recorded.signals).toEqual(['SIGTERM']);
    expect(recorded.probes()).toBeGreaterThan(0);
    expect(psBoundary.queries).toBeGreaterThan(0);
  });

  it('does not latch a transient ps failure: the next query still proves quiescence', async () => {
    let leaderPid = 0;
    // The first query fails without being a missing executable; the second lists only a zombie.
    psBoundary.answer = (query) => (query === 1 ? 'fail' : `${leaderPid} Z\n`);
    const recorded = recordingPort({ probe: () => 'deny' });
    const abort = new AbortController();
    const handle = start(READY_AND_STAY, {
      signal: abort.signal,
      signalPort: recorded.port,
      quiescenceProofTimeoutMs: PROOF_BUDGET_MS,
    });
    leaderPid = handle.pid ?? 0;
    await leaderReady();
    abort.abort();
    const result = await handle.result;
    // The command keeps its own cancelled status instead of being downgraded to stop-failed.
    expect(result).toMatchObject({
      status: 'cancelled',
      group: { tree: { kind: 'quiescent' }, signalDelivered: true },
    });
    expect(psBoundary.queries).toBe(2);
  });

  it('reports a missing ps as unproven ps-unavailable after one query, and the stop as delivered', async () => {
    await removePsFromPath();
    // Group probes are denied, so only ps could prove the group quiescent.
    const recorded = recordingPort({ probe: () => 'deny' });
    const { result } = await startAndAbort(READY_AND_STAY, { signalPort: recorded.port });
    expect(result).toMatchObject({
      status: 'stop-failed',
      group: { tree: { kind: 'unproven', reason: 'ps-unavailable' }, signalDelivered: true },
    });
    // Permanent unavailability is the one case that latches the whole poll.
    expect(psBoundary.queries).toBe(1);
  });

  it('counts no delivered signal when both stop signals are denied and the proof is impossible', async () => {
    await removePsFromPath();
    // SIGTERM is denied for the group, yet the leader is ended directly; the group probe is denied too.
    const recorded = recordingPort({
      probe: () => 'deny',
      signal: () => 'leader-then-deny',
    });
    const { result } = await startAndAbort(READY_AND_STAY, { signalPort: recorded.port });
    expect(result).toMatchObject({
      status: 'stop-failed',
      exit: { kind: 'exited' },
      group: { tree: { kind: 'unproven', reason: 'ps-unavailable' }, signalDelivered: false },
    });
  });

  it('settles within its bounds when every signal is denied, while the command keeps running', async () => {
    await removePsFromPath();
    const recorded = recordingPort({ signal: () => 'deny' });
    const abort = new AbortController();
    const handle = start(READY_AND_STAY, { signal: abort.signal, signalPort: recorded.port });
    await leaderReady();
    const abortedAt = Date.now();
    abort.abort();
    const result = await handle.result;
    // Grace, exit observation and the final proof are each bounded.
    expect(Date.now() - abortedAt).toBeLessThan(5_000);
    expect(result).toMatchObject({
      status: 'stop-failed',
      exit: { kind: 'unobserved' },
      group: { signalDelivered: false },
    });
    expect(result.group?.tree.kind).toBe('unproven');
    // The leader outlives the launch; the cleanup kills its group.
    expect(() => process.kill(handle.pid ?? 0, 0)).not.toThrow();
  });

  it.each([
    ['term', 'cancelled', false],
    ['term', 'timed-out', false],
    ['escalation', 'cancelled', false],
    ['escalation', 'timed-out', false],
    ['term', 'cancelled', true],
    ['escalation', 'cancelled', true],
  ] as const)('verifies quiescence after %s EPERM for %s (unverifiable: %s)', async (phase, reason, unverifiable) => {
    const recorded = recordingPort({
      // An unverifiable group can only be proven by ps, which then fails.
      probe: () => (unverifiable ? 'deny' : 'pass'),
      signal: (signal) => {
        if (signal === 'SIGTERM') {
          if (phase === 'term') return 'deny';
          // A short deadline may fire before the leader installed its handler: do not let SIGTERM end it.
          return reason === 'timed-out' ? 'swallow' : 'pass';
        }
        // The forceful stage proceeds, yet the host reports EPERM, as in the exiting-group race.
        return phase === 'escalation' ? 'pass-then-deny' : 'pass';
      },
    });
    if (unverifiable) psBoundary.answer = () => 'fail';
    const abort = new AbortController();
    const handle = start(READY_IGNORING_SIGTERM, {
      signal: abort.signal,
      signalPort: recorded.port,
      timeoutMs: reason === 'timed-out' ? 100 : 20_000,
    });
    if (reason === 'cancelled') {
      await leaderReady();
      abort.abort();
    }
    const result = await handle.result;
    expect(result.status).toBe(unverifiable ? 'stop-failed' : reason);
    expect(result.group?.tree.kind).toBe(unverifiable ? 'unproven' : 'quiescent');
    // Exactly one TERM and, as the only forceful signal, one KILL: the close sends no cleanup signal.
    expect(recorded.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });
});
