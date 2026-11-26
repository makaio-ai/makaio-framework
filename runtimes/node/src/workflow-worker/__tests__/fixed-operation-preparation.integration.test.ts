import { mkdir, mkdtemp, readdir, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkflowDefinition } from '@makaio/contracts';
import type { FixedOperationContext, FixedOperationOutcome } from '@makaio/contracts/extension';
import * as subprocess from '@makaio/subprocess';
import { WorkflowStorageSubjects } from '@makaio/subsystem-workflow-engine';
import { expect, it, vi } from 'vitest';
import {
  cloneFixtureCheckout,
  commitFixture,
  composeFixedOperationHost,
  git,
  makeFixedOperationExtension,
  runPorts,
  verifyFixtureCheckout,
} from './fixed-operation-host.fixture.js';
import { makeWorkerConfig } from './fixtures.js';

const sourceOwner = 'checkout-tools';
const prepOwner = 'prepare-tools';
const prepareName = `${prepOwner}.prepare`;
const definition: WorkflowDefinition = {
  id: 'workflow-1',
  scope: { type: 'global' },
  extensions: { [sourceOwner]: true, [prepOwner]: true },
  root: { id: 'root', type: 'sequence', nodes: [{ id: 'step', type: 'code-step' }] },
};

it('runs independent cleanup when the source owner stops during successful preparation closure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fixed-preparation-'));
  const workspace = join(root, 'runs');
  const original = join(root, 'original');
  const path = 'flow.mjs';
  const closed = Promise.withResolvers<subprocess.OwnerQuiescence>();
  const deliverClosure = Promise.withResolvers<void>();
  const retired = Promise.withResolvers<void>();
  const cleanup: Pick<FixedOperationContext, 'facts' | 'verifiedSource' | 'workflowRoot' | 'stepStatus'>[] = [];
  const effects: string[] = [];
  const createLauncher = subprocess.createLocalLauncher;
  // Pause delivery of real closure evidence to withdraw the source after callback success.
  const launcherSpy = vi.spyOn(subprocess, 'createLocalLauncher').mockImplementationOnce((setup) => {
    const site = createLauncher(setup);
    const { launcher } = site;
    return {
      ...site,
      launcher: {
        boundary: launcher.boundary,
        launch: (options) => launcher.launch(options),
        closeAll: () => launcher.closeAll(),
        async closeOwner(owner) {
          const evidence = await launcher.closeOwner(owner);
          if (owner.kind === 'runtime' && owner.operation === prepareName) {
            closed.resolve(evidence);
            await deliverClosure.promise;
          }
          return evidence;
        },
      },
    };
  });
  const { host, bus, coordinator, close } = composeFixedOperationHost(
    [
      makeFixedOperationExtension(sourceOwner, [
        {
          name: `${sourceOwner}.source`,
          phase: 'workflow-source',
          applies: () => true,
          run: (ctx) => cloneFixtureCheckout(ctx, original),
        },
      ]),
      makeFixedOperationExtension(prepOwner, [
        {
          name: prepareName,
          phase: 'before-steps',
          applies: () => true,
          async run(ctx): Promise<FixedOperationOutcome> {
            ctx.signal.addEventListener('abort', () => retired.resolve(), { once: true });
            const result = await ctx.launch({
              command: process.execPath,
              args: ['-e', "require('node:fs').writeFileSync('prepared', 'ready')"],
              env: {},
              timeoutMs: 5_000,
              output: { kind: 'ignore' },
            }).result;
            effects.push(`prepare:${result.status}`);
            return result.status === 'completed'
              ? { ok: true, facts: { stale: true } }
              : { ok: false, facts: {}, detail: 'preparation-process-failed' };
          },
        },
        {
          name: `${prepOwner}.cleanup`,
          phase: 'after-steps',
          applies: () => true,
          async run({ facts, verifiedSource, workflowRoot, stepStatus, workspace }) {
            await unlink(join(workspace, 'prepared'));
            cleanup.push({ facts, verifiedSource, workflowRoot, stepStatus });
            return { ok: true, facts: {} };
          },
        },
        {
          name: `${prepOwner}.source-cleanup`,
          phase: 'after-steps',
          requiresVerifiedSource: true,
          applies: () => true,
          async run() {
            effects.push('source-cleanup');
            return { ok: true, facts: {} };
          },
        },
      ]),
    ],
    workspace,
  );
  const stop = new AbortController();
  const offFrame = bus.on(
    WorkflowStorageSubjects.setFrame,
    async (ctx) => {
      effects.push(`frame:${ctx.payload.frame.nodeId}`);
      await ctx.next();
    },
    { priority: 100 },
  );
  try {
    await mkdir(workspace);
    await mkdir(original);
    const checkoutId = await realpath(original);
    await writeFile(join(original, path), `export default { definition: ${JSON.stringify(definition)} };`);
    await git(original, 'init', '--quiet');
    await git(original, 'add', path);
    const revision = await commitFixture(original);
    await coordinator.startAll();
    const config = { ...makeWorkerConfig({ definition }), terminalAuthority: 'authority' as const };
    const attempt = host.run(
      { bus, call: bus.own('root'), workspace, config, signal: stop.signal },
      {
        ...runPorts,
        admission: host.catalog().admission,
        source: {
          extension: sourceOwner,
          declaration: true,
          block: null,
          path,
          revision,
          checkoutId,
          verify: verifyFixtureCheckout,
        },
      },
    );
    try {
      await expect(Promise.race([closed.promise, attempt])).resolves.toMatchObject({ kind: 'quiescent' });
      expect(effects).toEqual(['prepare:completed']);
      const disable = coordinator.applyExtensionTransition(sourceOwner, false);
      await expect(Promise.race([retired.promise, attempt])).resolves.toBeUndefined();
      deliverClosure.resolve();
      await expect(disable).resolves.toBe('applied');
      const primary = { code: 'inactive-registration', phase: 'workflow-source' };
      await expect(attempt).rejects.toMatchObject({
        name: 'AggregateError',
        cause: primary,
        errors: [primary, { code: 'inactive-registration', phase: 'workflow-source' }],
      });
      expect(effects).toEqual(['prepare:completed']);
      expect(cleanup).toStrictEqual([
        { facts: {}, verifiedSource: undefined, workflowRoot: undefined, stepStatus: 'not-started' },
      ]);
      await expect(readdir(workspace)).resolves.toEqual([]);
    } finally {
      stop.abort();
      deliverClosure.resolve();
      await Promise.allSettled([attempt]);
    }
  } finally {
    launcherSpy.mockRestore();
    offFrame();
    await close();
    await rm(root, { recursive: true, force: true });
  }
});
