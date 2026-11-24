import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { launchLocalProcess, refuseLaunch, type LocalLaunchedProcess, type LaunchResult } from './launch.js';

import type {
  ExecutionSiteHandle,
  Launcher,
  OwnerLaunchOptions,
  OwnerQuiescence,
  ProcessOwner,
  SiteLaunchResult,
} from './launcher.js';

/** Local workspace and owner directory roots supplied by the worker. */
export interface LocalLauncherSetup {
  readonly workspaceRoot: string;
  /** Declared operating system, defaulting to the current host. The launcher refuses a mismatch. */
  readonly platform?: NodeJS.Platform;
  readonly stepHomeRoot: string;
  readonly runtimeHomeRoot: string;
}

/** Local paths used when building the allowlist for an owner. */
export interface LocalOwnerPaths {
  readonly home: string;
  readonly tmp: string;
}

/** Local composition, including access to the site's resolved paths. */
export interface LocalExecutionSite {
  readonly launcher: Launcher;
  paths(owner: ProcessOwner): LocalOwnerPaths;
}

const QUIESCENT = { kind: 'quiescent', boundary: 'process-group' } as const;

interface OwnerState {
  readonly kind: ProcessOwner['kind'];
  readonly running: Map<() => void, Promise<void>>;
  evidence: OwnerQuiescence;
  closing?: Promise<OwnerQuiescence>;
}

/**
 * Whether a directory resolves at or under its root.
 * @param root - Absolute canonical root.
 * @param path - Absolute canonical candidate.
 * @returns Whether the candidate is within the root.
 */
function contains(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

/**
 * Resolve the actual child working directory, including symlinks, within the workspace.
 * @param root - The configured workspace.
 * @param cwd - The relative directory, when supplied.
 * @returns The canonical directory, or undefined on a refusal.
 */
function workspaceDirectory(root: string, cwd = '.'): string | undefined {
  const requested = resolve(root, cwd);
  if (isAbsolute(cwd) || !contains(root, requested)) return undefined;
  try {
    const canonicalRoot = realpathSync(root);
    const actual = realpathSync(requested);
    return contains(canonicalRoot, actual) && statSync(actual).isDirectory() ? actual : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Encode authored keys as single path components with bounded size.
 * @param value - The step ID or operation name.
 * @returns Stable hex component.
 */
function pathKey(value: string): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * Create a managed directory and require its resolved path to stay at the expected position.
 * @param root - Configured home root.
 * @param path - Directory beneath that root.
 */
function prepareDirectory(root: string, path: string): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  let current = realpathSync(root);
  for (const component of relative(root, path).split(sep)) {
    current = join(current, component);
    try {
      mkdirSync(current, { mode: 0o700 });
    } catch (error) {
      if (!lstatSync(current, { throwIfNoEntry: false })?.isDirectory()) throw error;
    }
  }
}

/**
 * Project native process evidence onto the portable result.
 * @param result - Result from the local process supervisor.
 * @param cancellationSource - Source of cancellation when it occurred.
 * @returns The status, portable exit code, and scoped containment evidence.
 */
function siteResult(result: LaunchResult, cancellationSource: 'owner' | 'request'): SiteLaunchResult {
  const tree = result.group?.tree;
  const containment: OwnerQuiescence | undefined =
    tree?.kind === 'quiescent'
      ? QUIESCENT
      : tree?.kind === 'unproven'
        ? {
            kind: 'unproven',
            boundary: 'process-group',
            reason:
              tree.reason === 'poll-timeout'
                ? 'members-remain'
                : tree.reason === 'ps-unavailable'
                  ? 'observation-unavailable'
                  : 'termination-unconfirmed',
          }
        : undefined;
  const exitCode = result.exit?.kind === 'exited' ? (result.exit.code ?? undefined) : undefined;
  const refusal =
    result.refusal === 'unsupported-platform'
      ? 'unsupported-site'
      : result.refusal === 'invalid-stop-timing'
        ? 'spawn-error'
        : result.refusal;
  const facts = { containment, exitCode, refusal, output: result.output } as const;
  return result.status === 'cancelled'
    ? { ...facts, status: result.status, cancellationSource }
    : { ...facts, status: result.status };
}

/**
 * Adapt native streams without exposing the underlying child or process identifiers.
 * @param child - Native launched process.
 * @param cancellationSource - Source of cancellation, recorded by the request signal.
 * @returns The portable handle.
 */
function siteHandle(
  child: LocalLaunchedProcess,
  cancellationSource: () => 'owner' | 'request' = () => 'request',
): ExecutionSiteHandle {
  const result = child.result.then((outcome) => siteResult(outcome, cancellationSource()));
  // Node may allocate pipes even when spawn failed. Only a started child exposes them.
  if (child.pid === undefined) return { result };
  return {
    result,
    stdin: child.stdin && Writable.toWeb(child.stdin),
    stdout: child.stdout && Readable.toWeb(child.stdout),
    stderr: child.stderr && Readable.toWeb(child.stderr),
  };
}

/**
 * Report a refusal before a local process is created.
 * @param refusal - Portable refusal code.
 * @returns Settled handle with no streams.
 */
function siteRefusal(refusal: NonNullable<SiteLaunchResult['refusal']>): ExecutionSiteHandle {
  return { result: Promise.resolve({ status: 'spawn-failed', refusal }) };
}

/**
 * Recognize variables reserved for the site's owner directories.
 * @param name - Name in the worker's allowlist.
 * @returns Whether the launcher sets this name itself.
 */
function reservedEnvironmentName(name: string): boolean {
  const normalized = name.toUpperCase();
  return name === 'HOME' || name === 'TMPDIR' || normalized === 'TEMP' || normalized === 'TMP';
}

class LocalLauncher implements Launcher {
  public readonly boundary = 'process-group' as const;
  private readonly owners = new Map<string, OwnerState>();
  private stepsClosing?: Promise<OwnerQuiescence>;

  public constructor(private readonly setup: LocalLauncherSetup) {}

  public paths(owner: ProcessOwner): LocalOwnerPaths {
    const home = join(this.homeRoot(owner), pathKey(owner.kind === 'step' ? owner.stepId : owner.operation));
    const tmp = join(home, 'tmp', owner.kind === 'step' ? String(owner.execution) : 'operation');
    return { home, tmp };
  }

  public launch(options: OwnerLaunchOptions): ExecutionSiteHandle {
    const { owner, signal, env, command, args, output, stdin, timeoutMs } = options;
    if (process.platform === 'win32' || this.setup.platform !== process.platform)
      return siteRefusal('unsupported-site');
    if (signal?.aborted === true) return siteHandle(refuseLaunch('cancelled'));
    if (owner.kind === 'step' && (!Number.isSafeInteger(owner.execution) || owner.execution < 1)) {
      return siteRefusal('invalid-owner');
    }
    const state = this.ownerState(owner);
    if (state.closing !== undefined || (owner.kind === 'step' && this.stepsClosing !== undefined)) {
      return siteRefusal('owner-closed');
    }
    if (Object.keys(env).some(reservedEnvironmentName)) {
      return siteRefusal('reserved-entry');
    }
    const cwd = workspaceDirectory(this.setup.workspaceRoot, options.cwd);
    if (cwd === undefined) return siteRefusal('cwd-outside-workspace');
    const { home, tmp } = this.paths(owner);
    try {
      prepareDirectory(this.homeRoot(owner), home);
      prepareDirectory(home, tmp);
    } catch {
      return siteRefusal('home-unavailable');
    }
    const stopper = new AbortController();
    const ownerReason = Symbol();
    const stopOwner = (): void => stopper.abort(ownerReason);
    const combined = signal === undefined ? stopper.signal : AbortSignal.any([signal, stopper.signal]);
    const launched = launchLocalProcess(
      {
        command,
        args,
        output,
        stdin,
        timeoutMs,
        cwd,
        env: { ...env, HOME: home, TMPDIR: tmp },
        envMode: 'replace',
        signal: combined,
      },
      true,
    );
    const handle = siteHandle(launched, () => (combined.reason === ownerReason ? 'owner' : 'request'));
    const observed = handle.result.then(({ containment }) => {
      if (state.evidence.kind === 'quiescent' && containment?.kind === 'unproven') state.evidence = containment;
      state.running.delete(stopOwner);
    });
    state.running.set(stopOwner, observed);
    return handle;
  }

  public closeOwner(owner: ProcessOwner): Promise<OwnerQuiescence> {
    return this.close(this.ownerState(owner));
  }

  public closeAll(): Promise<OwnerQuiescence> {
    this.stepsClosing ??= Promise.all(
      Array.from(this.owners.values())
        .filter((state) => state.kind === 'step')
        .map((state) => this.close(state)),
    ).then((results) => results.find((evidence) => evidence.kind === 'unproven') ?? QUIESCENT);
    return this.stepsClosing;
  }

  private close(state: OwnerState): Promise<OwnerQuiescence> {
    if (state.closing !== undefined) return state.closing;
    state.closing = Promise.all(state.running.values()).then(() => state.evidence);
    for (const stopOwner of state.running.keys()) stopOwner();
    return state.closing;
  }

  private ownerState(owner: ProcessOwner): OwnerState {
    const key = JSON.stringify(
      owner.kind === 'step' ? ['step', owner.stepId, String(owner.execution)] : ['runtime', owner.operation],
    );
    const existing = this.owners.get(key);
    if (existing !== undefined) return existing;
    const state: OwnerState = { kind: owner.kind, running: new Map(), evidence: QUIESCENT };
    this.owners.set(key, state);
    return state;
  }

  private homeRoot(owner: ProcessOwner): string {
    return owner.kind === 'step' ? this.setup.stepHomeRoot : this.setup.runtimeHomeRoot;
  }
}

/**
 * Create a launcher that uses the local host's process groups for one run.
 * It provides environment scoping and process group supervision under the
 * worker's UID. It does not isolate files, process metadata or the network.
 * Use it only where the reachable worker environment and files contain no
 * credentials, or select an execution site with stronger containment.
 * Worker composition must also prevent inheritance of unrelated file descriptors.
 * @param setup - Workspace and home roots for the run.
 * @returns The runtime's launcher. The boundary is a process group on the same host.
 */
export function createLocalLauncher(setup: LocalLauncherSetup): LocalExecutionSite {
  const launcher = new LocalLauncher({
    platform: setup.platform ?? process.platform,
    workspaceRoot: resolve(setup.workspaceRoot),
    stepHomeRoot: resolve(setup.stepHomeRoot),
    runtimeHomeRoot: resolve(setup.runtimeHomeRoot),
  });
  return { launcher, paths: (owner) => launcher.paths(owner) };
}
