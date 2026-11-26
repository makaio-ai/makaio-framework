import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import type {
  FixedOperationContext,
  FixedOperationContribution,
  FixedOperationOutcome,
  MakaioExtension,
} from '@makaio/contracts/extension';
import {
  BootNamespace,
  ExtensionCoordinator,
  type ExtensionCoordinatorOptions,
  ExtensionNamespace,
  KernelNamespace,
} from '@makaio/kernel';
import { useJournalHostFixture } from '@makaio/storage-conformance';
import { WorkflowStorageSubjects } from '@makaio/subsystem-workflow-engine';
import { createFixedOperationHost } from '../fixed-operation-host.js';
import type { FixedProcessWorkflow, FixedSourceIdentity } from '../fixed-operation-workflow.js';
import { makeBusWithStorage } from './fixtures.js';

const exec = promisify(execFile);
const { constructContext } = useJournalHostFixture();

export const runPorts = {
  definitions: async () => [],
  withAddresses: async (_name, run) =>
    run({
      open: async () => {
        throw new Error('Address unavailable');
      },
      close: async () => {},
    }),
  afterStepsSignal: new AbortController().signal,
} satisfies FixedProcessWorkflow;

/**
 * Declare an extension for worker operation tests.
 * @param name - Owner of the fixed operation names.
 * @param fixedOperations - Contributions activated by the coordinator.
 * @returns An extension declaration to load.
 */
export function makeFixedOperationExtension(name: string, fixedOperations: readonly FixedOperationContribution[]) {
  return { name, displayName: name, version: '1.0.0', critical: true, fixedOperations } satisfies MakaioExtension<
    ReturnType<typeof constructContext>
  >;
}

/**
 * Compose the real extension coordinator and its fixed operation processor.
 * @param extensions - Extensions to activate.
 * @param workspace - Test root.
 * @param options - Optional credential contribution support for the coordinator.
 * @returns The coordinator, ports and workflow bus.
 */
export function composeFixedOperationHost(
  extensions: readonly MakaioExtension<ReturnType<typeof constructContext>>[],
  workspace: string,
  options?: Pick<ExtensionCoordinatorOptions, 'enableCredentialResolver'>,
) {
  const [bus, dispose] = makeBusWithStorage();
  bus.registerNamespace(BootNamespace);
  bus.registerNamespace(ExtensionNamespace);
  bus.registerNamespace(KernelNamespace);
  bus.on(WorkflowStorageSubjects.getRunContext, (ctx) => ctx.setResult({ runContext: null }));
  const coordinator = new ExtensionCoordinator(bus, {
    ...options,
    extensionContextBase: {
      constructContext,
      platform: process.platform,
      homedir: workspace,
      makaioHome: workspace,
      username: 'test',
      machineId: 'machine-test',
      tryImport: async () => null,
    },
  });
  const { host, processor } = createFixedOperationHost<ReturnType<typeof constructContext>>(
    () => coordinator.list().map(({ name }) => name),
    (name) => coordinator.extensionStopBudgetMs(name),
  );
  coordinator.registerContributionProcessor(processor);
  coordinator.load(extensions);
  return {
    bus,
    host,
    coordinator,
    async close() {
      try {
        await coordinator.shutdown();
      } finally {
        dispose();
      }
    },
  };
}

/**
 * Run local Git and return its trimmed output.
 * @param root - Local repository.
 * @param args - Git arguments.
 * @returns Git's result.
 */
export async function git(root: string, ...args: string[]): Promise<string> {
  return (await exec('git', ['-C', root, ...args])).stdout.trim();
}

/**
 * Commit the staged fixture with local author data and read its pin.
 * @param root - Local fixture repository.
 * @param args - Additional commit arguments.
 * @returns Full revision of the new commit.
 */
export async function commitFixture(root: string, ...args: string[]): Promise<string> {
  await git(
    root,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'fixture',
    ...args,
  );
  return git(root, 'rev-parse', 'HEAD');
}

/**
 * Verify the fixture's tracked workflow file and observe the local checkout identity.
 * @param checkout - Prepared Git checkout.
 * @param path - Canonical path to the tracked module.
 * @returns Observed identity and revision.
 */
export async function verifyFixtureCheckout(checkout: string, path: string): Promise<FixedSourceIdentity> {
  const checkoutPath = relative(checkout, path);
  await git(checkout, 'cat-file', '-e', `HEAD:${checkoutPath}`);
  await git(checkout, 'diff', '--exit-code', 'HEAD', '--', checkoutPath);
  return {
    revision: await git(checkout, 'rev-parse', 'HEAD'),
    checkoutId: await realpath(await git(checkout, 'remote', 'get-url', 'origin')),
  };
}

/**
 * Prepare the fixture checkout through the worker's actual process launch port.
 * @param context - The source operation's context.
 * @param original - Canonical path to the local fixture repository.
 * @returns The source operation outcome.
 */
export async function cloneFixtureCheckout(
  context: FixedOperationContext,
  original: string,
): Promise<FixedOperationOutcome> {
  const root = join(context.sourceDirectory, 'checkout');
  const result = await context.launch({
    command: 'git',
    args: ['clone', '--quiet', original, root],
    env: {},
    timeoutMs: 5_000,
    output: { kind: 'ignore' },
  }).result;
  return result.status === 'completed'
    ? { ok: true, facts: {}, workflowRoot: root }
    : { ok: false, facts: {}, detail: 'git-clone-failed' };
}
