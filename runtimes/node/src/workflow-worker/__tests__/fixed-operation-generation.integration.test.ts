import { tracingChannel } from 'node:diagnostics_channel';
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowAgentStepNodeSchema, WorkflowSubjects, type WorkflowDefinition } from '@makaio/contracts';
import type { FixedOperationContribution, FixedOperationFacts } from '@makaio/contracts/extension';
import type { SiteLaunchResult } from '@makaio/core';
import { expect, it, vi } from 'vitest';
import { closeHttpServer, listenOnLoopback } from '../../__tests__/http-test-helpers.js';
import type { FixedProcessWorkflow, FixedWorkflowRunOptions } from '../fixed-operation-workflow.js';
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

const extension = 'checkout-tools';
const resolverExtension = 'dependency-tools';
const resolverName = `${resolverExtension}.resolve`;

type RunningChild = { readonly signal: AbortSignal; readonly result: Promise<SiteLaunchResult> };

/**
 * Compose a frozen workflow run with explicit terminal authority.
 * @param fixture - The host, bus and coordinator for the active extensions.
 * @param workspace - Parent of the private run directory.
 * @param signal - Test run cancellation.
 * @param definition - Workflow definition used by the fixed phases and steps.
 * @returns Run options for the fixed operation host.
 */
function makeRun(
  fixture: ReturnType<typeof composeFixedOperationHost>,
  workspace: string,
  signal: AbortSignal,
  definition: WorkflowDefinition,
): FixedWorkflowRunOptions {
  const { bus } = fixture;
  return {
    bus,
    call: bus.own('root'),
    workspace,
    signal,
    config: { ...makeWorkerConfig({ definition }), terminalAuthority: 'authority' },
  };
}

const definition: WorkflowDefinition = {
  id: 'workflow-1',
  scope: { type: 'global' },
  extensions: { [extension]: true },
  root: { id: 'root', type: 'sequence', nodes: [] },
};

/**
 * Create an operation that holds the first generation at a barrier after launch.
 * @param port - Test listener that confirms the process has started.
 * @param launched - Exposes the process result independently of the callback result.
 * @param release - Allows the old callback to submit a successful but stale outcome.
 * @param inputs - Records the incoming facts for each attempt.
 * @returns A fixed operation contribution.
 */
function holdOperation(
  port: number,
  launched: (child: RunningChild) => void,
  release: Promise<void>,
  inputs: FixedOperationFacts[],
): FixedOperationContribution {
  return {
    name: `${extension}.prepare`,
    phase: 'before-steps',
    applies: () => true,
    async run(ctx) {
      inputs.push(ctx.facts);
      if (inputs.length !== 1) return { ok: true, facts: { generation: 'current' } };
      const { result } = ctx.launch({
        command: process.execPath,
        args: ['-e', 'void fetch(process.argv[1]).catch(() => process.exitCode = 1)', `http://127.0.0.1:${port}`],
        env: {},
        timeoutMs: 5_000,
        output: { kind: 'ignore' },
      });
      launched({ signal: ctx.signal, result });
      await release;
      return { ok: true, facts: { generation: 'stale' }, workflowRoot: ctx.sourceDirectory };
    },
  };
}

it('stops the child immediately and drains a withdrawn callback before reactivation', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'fixed-operation-generation-'));
  const connected = Promise.withResolvers<void>();
  const launched = Promise.withResolvers<RunningChild>();
  const release = Promise.withResolvers<void>();
  const inputs: FixedOperationFacts[] = [];
  const followUps: FixedOperationFacts[] = [];
  const server = createServer(() => connected.resolve());
  const port = await listenOnLoopback(server);
  const operation = holdOperation(port, launched.resolve, release.promise, inputs);
  const followUp: FixedOperationContribution = {
    name: `${extension}.finish`,
    phase: 'after-steps',
    applies: () => true,
    async run(ctx) {
      followUps.push(ctx.facts);
      return { ok: true, facts: {} };
    },
  };
  const fixture = composeFixedOperationHost([makeFixedOperationExtension(extension, [operation, followUp])], workspace);
  const stop = new AbortController();
  try {
    await fixture.coordinator.startAll();
    const input = makeRun(fixture, workspace, stop.signal, definition);
    const ports = { ...runPorts, allowSourceFree: true } as const;
    const attempt = fixture.host.run(input, ports);
    void attempt.catch(() => undefined);
    try {
      const [child] = await Promise.race([
        Promise.all([launched.promise, connected.promise]),
        attempt.then(() => {
          throw new Error('Run finished before the operation child connected');
        }),
      ]);
      const disabled = fixture.coordinator.applyExtensionTransition(extension, false);
      const enabled = fixture.coordinator.applyExtensionTransition(extension, true);
      await expect(child.result).resolves.toMatchObject({
        status: 'cancelled',
        cancellationSource: 'request',
        containment: { kind: 'quiescent' },
      });
      expect(child.signal.aborted).toBe(true);
      expect(fixture.coordinator.getInfo(extension)?.state).toBe('active');
      expect(fixture.host.catalog().entries).toEqual({});
      expect(await readdir(workspace)).toHaveLength(1);
      release.resolve();
      await expect(disabled).resolves.toBe('applied');
      await expect(enabled).resolves.toBe('applied');
    } finally {
      release.resolve();
      await expect(attempt).rejects.toMatchObject({ code: 'inactive-registration', phase: 'before-steps' });
    }
    expect(followUps).toEqual([]);
    await expect(readdir(workspace)).resolves.toEqual([]);
    const next = await fixture.host.run({ ...input, config: { ...input.config, executionId: 'next' } }, ports);
    expect(next.result.status).toBe('completed');
    expect(next.facts.get(extension)).toEqual({ generation: 'current' });
    expect(next.afterStepsErrors).toEqual([]);
    expect(inputs).toEqual([{}, {}]);
    expect(followUps).toEqual([{ generation: 'current' }]);
    await expect(readdir(workspace)).resolves.toEqual([]);
  } finally {
    stop.abort();
    await fixture.close();
    server.closeAllConnections();
    await closeHttpServer(server);
    await rm(workspace, { recursive: true, force: true });
  }
});

it('releases the coordinator after the stop window while retaining a running generation', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'fixed-operation-stop-window-'));
  const entered = Promise.withResolvers<void>();
  const retired = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const other = 'independent-tools';
  let starts = 0;
  const owner = {
    ...makeFixedOperationExtension(extension, [
      {
        name: `${extension}.prepare`,
        phase: 'before-steps',
        applies: () => true,
        async run({ signal }) {
          if (starts === 1) {
            signal.addEventListener('abort', () => retired.resolve(), { once: true });
            entered.resolve();
            await release.promise;
            return { ok: true, facts: { generation: 'stale' } };
          }
          return { ok: true, facts: { generation: 'current' } };
        },
      },
    ]),
    create: () => {
      starts += 1;
      return {};
    },
  };
  const fixture = composeFixedOperationHost([owner, makeFixedOperationExtension(other, [])], workspace);
  const stop = new AbortController();
  try {
    await fixture.coordinator.startAll();
    const input = makeRun(fixture, workspace, stop.signal, definition);
    const ports = { ...runPorts, allowSourceFree: true } as const;
    const attempt = fixture.host.run(input, ports);
    void attempt.catch(() => undefined);
    try {
      await Promise.race([entered.promise, attempt]);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const disabling = fixture.coordinator.applyExtensionTransition(extension, false);
      await Promise.race([retired.promise, disabling]);
      await vi.advanceTimersByTimeAsync(fixture.coordinator.extensionStopBudgetMs(extension));
      await expect(disabling).resolves.toBe('applied');
      expect(fixture.coordinator.getInfo(extension)?.error).toContain('generation-retirement-unconfirmed');
      await expect(fixture.coordinator.applyExtensionTransition(other, false)).resolves.toBe('applied');
      await expect(fixture.coordinator.applyExtensionTransition(other, true)).resolves.toBe('applied');
      await expect(fixture.coordinator.applyExtensionTransition(extension, true)).resolves.toBe('rejected');
      expect(fixture.coordinator.getInfo(extension)?.error).toContain('generation-retirement-unconfirmed');
      expect(starts).toBe(1);
      expect(fixture.host.catalog().entries).toEqual({});
      await expect(readdir(workspace)).resolves.toHaveLength(1);
    } finally {
      vi.useRealTimers();
      release.resolve();
      await expect(attempt).rejects.toMatchObject({ code: 'inactive-registration', phase: 'before-steps' });
    }
    await expect(readdir(workspace)).resolves.toEqual([]);
    await expect(fixture.coordinator.applyExtensionTransition(extension, true)).resolves.toBe('applied');
    const next = await fixture.host.run({ ...input, config: { ...input.config, executionId: 'next' } }, ports);
    expect(next.result.status).toBe('completed');
    expect(next.facts.get(extension)).toEqual({ generation: 'current' });
  } finally {
    stop.abort();
    await fixture.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

type ResolverBoundary = 'before-address-port' | 'inside-address-port' | 'awaiting-address';

/**
 * Run a local Git workflow with a resolver and suspend it at the selected port boundary.
 * @param root - Fixture directory.
 * @param boundary - Point at which the owner or resolver will be withdrawn.
 * @param wait - Event barrier reached immediately before a potential effect.
 * @param retired - Observe retirement while the callback is still running.
 * @param effects - Observed address and operation effects.
 * @returns Real coordinator fixture and the admitted source and process options.
 */
async function prepareResolverRun(
  root: string,
  boundary: ResolverBoundary,
  wait: () => Promise<void>,
  retired: () => void,
  effects: string[],
) {
  const workspace = join(root, 'runs');
  const original = join(root, 'original');
  await mkdir(workspace);
  await mkdir(original);
  await git(original, 'init', '--quiet');
  await writeFile(join(original, 'workflow.mjs'), 'export default {};');
  await git(original, 'add', 'workflow.mjs');
  const revision = await commitFixture(original);
  const checkoutId = await realpath(original);
  const source: FixedOperationContribution = {
    name: `${extension}.source`,
    phase: 'workflow-source',
    applies: () => true,
    run: (ctx) => cloneFixtureCheckout(ctx, checkoutId),
  };
  const resolver: FixedOperationContribution = {
    name: resolverName,
    phase: 'workflow-source',
    applies: () => true,
    async run(ctx) {
      ctx.signal.addEventListener('abort', retired, { once: true });
      effects.push('resolver-run');
      await ctx.addresses.open('dependency-read');
      effects.push('address-delivered');
      return { ok: true, facts: { resolved: true } };
    },
  };
  const fixture = composeFixedOperationHost(
    [makeFixedOperationExtension(extension, [source]), makeFixedOperationExtension(resolverExtension, [resolver])],
    workspace,
  );
  const ports: FixedProcessWorkflow = {
    ...runPorts,
    source: {
      extension,
      declaration: true,
      block: null,
      dependencies: { resolver: resolverName },
      path: 'workflow.mjs',
      revision,
      checkoutId,
      async verify(checkout, path) {
        if (boundary === 'before-address-port') await wait();
        return verifyFixtureCheckout(checkout, path);
      },
    },
    async withAddresses(name, run) {
      if (name !== resolverName) return runPorts.withAddresses(name, run);
      effects.push('address-scope');
      if (boundary === 'inside-address-port') await wait();
      return run({
        async open() {
          effects.push('address-open');
          if (boundary === 'awaiting-address') await wait();
          return 'local-test-address';
        },
        close: async () => {},
      });
    },
  };
  return { fixture, ports, workspace };
}

it.each([
  ['before-address-port', resolverExtension, []],
  ['inside-address-port', extension, ['address-scope']],
  ['awaiting-address', extension, ['address-scope', 'resolver-run', 'address-open']],
] satisfies Array<
  [ResolverBoundary, string, string[]]
>)('revalidates both owners when a resolver resumes %s', async (boundary, owner, expectedEffects) => {
  const root = await mkdtemp(join(tmpdir(), 'fixed-resolver-generation-'));
  const reached = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const retired = Promise.withResolvers<void>();
  const effects: string[] = [];
  const { fixture, ports, workspace } = await prepareResolverRun(
    root,
    boundary,
    async () => {
      reached.resolve();
      await resume.promise;
    },
    retired.resolve,
    effects,
  );
  const stop = new AbortController();
  try {
    await fixture.coordinator.startAll();
    const options = makeRun(fixture, workspace, stop.signal, {
      ...definition,
      extensions: { ...definition.extensions, [resolverExtension]: true },
    });
    const attempt = fixture.host.run(options, ports);
    void attempt.catch(() => undefined);
    try {
      await Promise.race([reached.promise, attempt]);
      const disabled = fixture.coordinator.applyExtensionTransition(owner, false);
      await Promise.race([disabled, retired.promise]);
      resume.resolve();
      await expect(disabled).resolves.toBe('applied');
      await expect(fixture.coordinator.applyExtensionTransition(owner, true)).resolves.toBe('applied');
    } finally {
      resume.resolve();
      await expect(attempt).rejects.toMatchObject({ code: 'inactive-registration', phase: 'workflow-source' });
    }
    expect(effects).toEqual(expectedEffects);
    await expect(readdir(workspace)).resolves.toEqual([]);
  } finally {
    stop.abort();
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('checks the generation after resolving an agent role and before opening its model address', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'fixed-agent-generation-'));
  const fixture = composeFixedOperationHost(
    [
      makeFixedOperationExtension(extension, [
        {
          name: `${extension}.prepare`,
          phase: 'before-steps',
          applies: () => true,
          run: async () => ({ ok: true, facts: {} }),
        },
      ]),
    ],
    workspace,
  );
  const resolving = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const offRole = fixture.bus.on(WorkflowSubjects.resolveRole, async (ctx) => {
    resolving.resolve();
    await resume.promise;
    ctx.setResult({ adapterName: 'text-model', model: 'test-model' });
  });
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ text: '{"ok":true}' }));
  });
  const listen = tracingChannel('net.server.listen').asyncStart;
  // Observe the actual listener boundary, including leases closed before a child can use them.
  let listenersOpened = 0;
  const countListeners = (): void => {
    listenersOpened += 1;
  };
  const stop = new AbortController();
  const agentDefinition: WorkflowDefinition = {
    ...definition,
    root: {
      ...definition.root,
      nodes: [
        WorkflowAgentStepNodeSchema.parse({
          id: 'review',
          type: 'agent-step',
          role: 'reviewer',
          prompt: 'Review',
          completion: 'turn',
          outputSchema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } },
        }),
      ],
    },
  };
  try {
    const port = await listenOnLoopback(server);
    await fixture.coordinator.startAll();
    const options = {
      ...makeRun(fixture, workspace, stop.signal, agentDefinition),
      model: {
        adapterName: 'text-model',
        ownerInstanceId: 'test-worker',
        target: { name: 'test-model', url: new URL(`http://127.0.0.1:${port}`) },
        credentialSource: { request: async () => ({ kind: 'issued' as const, credential: 'dummy-model-credential' }) },
      },
    };
    listen.subscribe(countListeners);
    const ports = { ...runPorts, allowSourceFree: true } as const;
    const attempt = fixture.host.run(options, ports);
    try {
      await Promise.race([resolving.promise, attempt]);
      await expect(fixture.coordinator.applyExtensionTransition(extension, false)).resolves.toBe('applied');
      await expect(fixture.coordinator.applyExtensionTransition(extension, true)).resolves.toBe('applied');
    } finally {
      resume.resolve();
      await expect(attempt).resolves.toMatchObject({
        result: { status: 'failed', error: expect.stringContaining('inactive-registration') },
      });
    }
    expect(listenersOpened).toBe(0);
    await expect(
      fixture.host.run({ ...options, config: { ...options.config, executionId: 'next' } }, ports),
    ).resolves.toMatchObject({ result: { status: 'completed' } });
    expect(listenersOpened).toBe(1);
    await expect(readdir(workspace)).resolves.toEqual([]);
  } finally {
    stop.abort();
    listen.unsubscribe(countListeners);
    offRole();
    await fixture.close();
    if (server.listening) await closeHttpServer(server);
    await rm(workspace, { recursive: true, force: true });
  }
});
