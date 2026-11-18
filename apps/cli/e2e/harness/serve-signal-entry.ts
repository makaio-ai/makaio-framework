/**
 * CLI serve entry for the signal-handling E2E tests.
 *
 * Runs the real `makaio serve` command path (extra CLI arguments are forwarded,
 * so `--ignore-hangup` reaches the command) with two fixture extensions whose
 * lifecycle the test controls through the environment:
 *
 * - `signal-fixture-child` starts a detached child through the shared JSONL
 *   transport, which is the owner that stops it, and records the child's PID.
 *   Its `init()` settles once the child has announced itself, so the PID is
 *   on record by then. Its `destroy()` can be slowed, made to never settle or
 *   made to fail.
 * - `signal-fixture-slow-start` starts after it and takes a while to initialise,
 *   so a signal can arrive while the boot is still running and a child exists.
 *   It can also fail its (critical) initialisation, which fails the boot.
 *
 * The boot itself can be held in a phase that reaches no checkpoint, by a
 * handler of its first phase event that never settles.
 *
 * Do NOT import from the application code path — this file is only ever
 * spawned as a child process.
 */
import { setTimeout as delay } from 'node:timers/promises';
import { MakaioBus, type IMakaioBus } from '@makaio/bus-core';
import { KernelSubjects } from '@makaio/kernel';
import { dep, type ExtensionServiceLifecycle, type MakaioNodeExtension } from '@makaio/contracts';
import type { DetachedDescriptor } from '@makaio/contracts/extension';
import { ExplicitDescriptorDiscovery, type DiscoveredExtension } from '@makaio/runtime-node';
import { createJsonlTransport, type IJsonlTransport } from '@makaio/subprocess';
import { main } from '../../src/main.js';
import {
  BOOT_HANG_ENV,
  CHILD_PID_FILE_ENV,
  DETACHED_NEVER_READY_HEALTH_ENV,
  DESTROY_DELAY_ENV,
  DESTROY_FAIL_ENV,
  SECOND_CHILD_ENV,
  SECOND_DESTROY_HANG_ENV,
  SECOND_STOP_BUDGET_ENV,
  SLOW_START_ENV,
  SLOW_START_FAIL_ENV,
  STUBBORN_KILL_GRACE_ENV,
} from './serve-signal-env.js';

/** Graceful stage of a stop, when the children ignore `SIGTERM`; `undefined` when they do not. */
const stubbornKillGraceMs =
  process.env[STUBBORN_KILL_GRACE_ENV] === undefined ? undefined : Number(process.env[STUBBORN_KILL_GRACE_ENV]);

/**
 * Script of the fixture child: records its PID, then idles until it is stopped.
 * A stubborn child ignores `SIGTERM`, so only the owner's escalation ends it.
 */
const CHILD_SCRIPT = `
${stubbornKillGraceMs === undefined ? '' : "process.on('SIGTERM', () => {});"}
require('node:fs').appendFileSync(process.env.${CHILD_PID_FILE_ENV}, process.pid + '\\n');
process.stdout.write('{"ready":true}\\n');
setInterval(() => {}, 1000);
`;

/** Service that starts one detached child and stops it through its owner. */
class ChildOwnerService implements ExtensionServiceLifecycle {
  private transport: IJsonlTransport | undefined;

  private readonly hangs: boolean;
  public readonly stopBudgetMs: number | undefined;

  /**
   * @param hangs - Whether `destroy()` never settles.
   * @param stopBudgetMs - Stop window the service declares; the host's default when `undefined`.
   */
  public constructor(hangs: boolean, stopBudgetMs?: number) {
    this.hangs = hangs;
    this.stopBudgetMs = stopBudgetMs;
  }

  public async init(): Promise<void> {
    const transport = createJsonlTransport({
      command: process.execPath,
      args: ['-e', CHILD_SCRIPT],
      cwd: process.cwd(),
      onStdoutEnd: 'ignore',
      killGraceMs: stubbornKillGraceMs,
    });
    this.transport = transport;
    // The child records its PID before it announces itself, so once this
    // settles a test can rely on the PID file.
    await new Promise<void>((resolve, reject) => {
      const unsubscribe = transport.onMessage(() => {
        unsubscribe();
        resolve();
      });
      void transport.ended.then((end) => {
        unsubscribe();
        reject(new Error(`fixture child ended before announcing itself (${end.cause})`));
      });
    });
  }

  public async destroy(): Promise<void> {
    console.info('[fixture] destroy begins');
    if (this.hangs) {
      await new Promise<void>(() => undefined);
    }
    await delay(Number(process.env[DESTROY_DELAY_ENV] ?? 0));
    await this.transport?.close();
    if (process.env[DESTROY_FAIL_ENV] === '1') throw new Error('fixture destroy failed');
  }
}

/** Service whose initialisation takes `SLOW_START_ENV` milliseconds. */
class SlowStartService implements ExtensionServiceLifecycle {
  public async init(): Promise<void> {
    console.info('[fixture] slow start begins');
    await delay(Number(process.env[SLOW_START_ENV] ?? 0));
    if (process.env[SLOW_START_FAIL_ENV] === '1') throw new Error('fixture slow start failed');
  }
}

/**
 * Build a preloaded discovery entry for a fixture extension.
 * @param extension - Fixture extension module.
 * @returns Discovery entry consumed by `ExplicitDescriptorDiscovery`.
 */
function preloaded(extension: MakaioNodeExtension<IMakaioBus>): DiscoveredExtension {
  return {
    descriptor: {
      name: extension.name,
      displayName: extension.displayName,
      version: extension.version,
      makaio: { framework: '>=0.1.0' },
      entrypoints: { server: true },
    },
    extensionPath: process.cwd(),
    source: 'local',
    preloadedModule: { default: extension },
  };
}

/** Script of the detached child that never becomes ready: records its PID and idles without a readiness message. */
const NEVER_READY_SCRIPT = `
require('node:fs').appendFileSync(process.env.${CHILD_PID_FILE_ENV}, process.pid + '\\n');
setInterval(() => {}, 1000);
`;

/**
 * Build the discovery entry of a detached extension whose child never becomes
 * ready, so its start waits for the health timeout unless it is cancelled.
 * @param healthTimeoutMs - Health timeout of the extension.
 * @returns Discovery entry; the runtime builds the extension from the descriptor.
 */
function detachedNeverReady(healthTimeoutMs: number): DiscoveredExtension {
  const descriptor: DetachedDescriptor = {
    name: 'signal-fixture-detached',
    displayName: 'Signal Fixture Detached',
    version: '0.1.0',
    makaio: { framework: '>=0.1.0' },
    dependencies: [dep('signal-fixture-child')],
    execution: 'detached',
    transport: {
      type: 'bus-websocket',
      command: process.execPath,
      args: ['-e', NEVER_READY_SCRIPT],
      env: { [CHILD_PID_FILE_ENV]: String(process.env[CHILD_PID_FILE_ENV]) },
      healthTimeoutMs,
    },
  };
  return { descriptor, extensionPath: process.cwd(), source: 'local' };
}

const childExtension: MakaioNodeExtension<IMakaioBus> = {
  name: 'signal-fixture-child',
  displayName: 'Signal Fixture Child',
  version: '0.1.0',
  create: () => new ChildOwnerService(false),
};

const secondBudget = process.env[SECOND_STOP_BUDGET_ENV];
const neverReadyHealthMs = process.env[DETACHED_NEVER_READY_HEALTH_ENV];
/** Owns a second child; it starts after the first extension, so a stop reaches it before it. */
const secondChildExtension: MakaioNodeExtension<IMakaioBus> = {
  name: 'signal-fixture-child-two',
  displayName: 'Signal Fixture Child Two',
  version: '0.1.0',
  dependencies: [dep('signal-fixture-child')],
  create: () =>
    new ChildOwnerService(
      process.env[SECOND_DESTROY_HANG_ENV] === '1',
      secondBudget === undefined ? undefined : Number(secondBudget),
    ),
};

const slowStartExtension: MakaioNodeExtension<IMakaioBus> = {
  name: 'signal-fixture-slow-start',
  displayName: 'Signal Fixture Slow Start',
  version: '0.1.0',
  dependencies: [dep(process.env[SECOND_CHILD_ENV] === '1' ? 'signal-fixture-child-two' : 'signal-fixture-child')],
  critical: process.env[SLOW_START_FAIL_ENV] === '1',
  create: () => new SlowStartService(),
};

if (process.env[BOOT_HANG_ENV] === '1') {
  MakaioBus.on(KernelSubjects.phase.busCreated, async () => {
    console.info('[fixture] boot phase begins');
    await new Promise<void>(() => undefined);
  });
}

await main(['node', 'serve-signal-entry.ts', 'serve', '--port', '0', ...process.argv.slice(2)], [], undefined, {
  boot: {
    discovery: new ExplicitDescriptorDiscovery([
      preloaded(childExtension),
      ...(process.env[SECOND_CHILD_ENV] === '1' ? [preloaded(secondChildExtension)] : []),
      ...(neverReadyHealthMs === undefined ? [] : [detachedNeverReady(Number(neverReadyHealthMs))]),
      preloaded(slowStartExtension),
    ]),
  },
});
