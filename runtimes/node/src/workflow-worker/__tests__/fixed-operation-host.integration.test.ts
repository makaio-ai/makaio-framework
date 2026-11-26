import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { WorkflowErrorCode, type WorkflowDefinition } from '@makaio/contracts';
import { dep, type FixedOperationContribution } from '@makaio/contracts/extension';
import { WorkflowStorageSubjects } from '@makaio/subsystem-workflow-engine';
import { expect, it } from 'vitest';
import type { AdmittedFixedWorkflowSource } from '../fixed-operation-workflow.js';
import type { FixedOperationFailure } from '../runtime/fixed-operations.js';
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

/**
 * Compose the real extension coordinator and its fixed operation processor.
 * @param fixedOperations - Test extension contributions.
 * @param workspace - Test root.
 * @returns The coordinator, ports and workflow bus.
 */
function compose(fixedOperations: readonly FixedOperationContribution[], workspace: string) {
  return composeFixedOperationHost([makeFixedOperationExtension(extension, fixedOperations)], workspace);
}

/** A source operation whose successful result is supplied by each fixture. */
const sourceOperation = {
  name: `${extension}.source`,
  phase: 'workflow-source',
  applies: () => true,
  async run() {
    return { ok: true, facts: {} };
  },
} satisfies FixedOperationContribution;

it('activates, removes and reactivates the contribution through the coordinator', async () => {
  const host = compose([sourceOperation], tmpdir());
  const staged = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  host.coordinator.registerContributionProcessor({
    async processActivated() {
      staged.resolve();
      await finish.promise;
    },
  });
  try {
    expect(host.host.catalog().entries).toEqual({});
    const startup = host.coordinator.startAll();
    await Promise.race([staged.promise, startup]);
    expect(host.host.catalog().entries).toEqual({});
    finish.resolve();
    await startup;
    expect(host.host.catalog().entries).toEqual({ [sourceOperation.name]: { extension, phase: 'workflow-source' } });
    await expect(host.coordinator.applyExtensionTransition(extension, false)).resolves.toBe('applied');
    expect(host.host.catalog().entries).toEqual({});
    await expect(host.coordinator.applyExtensionTransition(extension, true)).resolves.toBe('applied');
    expect(host.host.catalog().entries).toEqual({ [sourceOperation.name]: { extension, phase: 'workflow-source' } });
  } finally {
    finish.resolve();
    await host.close();
  }
});

const asynchronous = { ...sourceOperation, phase: 'before-steps' as const };
Reflect.set(asynchronous, 'applies', async () => true);

it.each([
  ['duplicate-operation', [sourceOperation, { ...sourceOperation, phase: 'after-steps' as const }]],
  ['invalid-registration', [asynchronous]],
])('rejects %s atomically on activation', async (code, entries) => {
  const host = compose(entries, tmpdir());
  try {
    await expect(host.coordinator.startAll()).rejects.toMatchObject({ code, phase: 'registration' });
    expect(host.host.catalog().entries).toEqual({});
  } finally {
    await host.close();
  }
});

it('rejects a second owner of an operation name without altering the first catalog', async () => {
  const second = `${extension}.nested`;
  const shared = { ...sourceOperation, name: `${second}.source` };
  const { host, coordinator, close } = composeFixedOperationHost(
    [
      makeFixedOperationExtension(extension, [shared]),
      {
        ...makeFixedOperationExtension(second, [
          { ...shared, name: `${second}.prepare`, phase: 'before-steps' },
          shared,
        ]),
        dependencies: [dep(extension)],
      },
    ],
    tmpdir(),
  );
  try {
    await expect(coordinator.startAll()).rejects.toMatchObject({ code: 'duplicate-operation', phase: 'registration' });
    expect(host.catalog().entries).toEqual({ [shared.name]: { extension, phase: 'workflow-source' } });
  } finally {
    await close();
  }
});

it('keeps dependency and teardown order when an optional dependency is reactivated', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'fixed-operation-order-'));
  const events: string[] = [];
  const dependent = 'dependent-tools';
  const operations = (owner: string): FixedOperationContribution[] =>
    (['before-steps', 'after-steps'] as const).map((phase) => ({
      name: `${owner}.${phase}`,
      phase,
      applies: () => true,
      async run() {
        events.push(`${owner}.${phase}`);
        return { ok: true, facts: {} };
      },
    }));
  const { host, bus, coordinator, close } = composeFixedOperationHost(
    [
      { ...makeFixedOperationExtension(dependent, operations(dependent)), dependencies: [dep(extension, '*', true)] },
      makeFixedOperationExtension(extension, operations(extension)),
    ],
    workspace,
  );
  try {
    await coordinator.startAll();
    await expect(coordinator.applyExtensionTransition(extension, false)).resolves.toBe('applied');
    expect(coordinator.getInfo(dependent)?.state).toBe('active');
    await expect(coordinator.applyExtensionTransition(extension, true)).resolves.toBe('applied');
    const config = {
      ...makeWorkerConfig({
        definition: {
          id: 'workflow-1',
          scope: { type: 'global' },
          extensions: { [extension]: true, [dependent]: true },
          root: { id: 'root', type: 'sequence', nodes: [] },
        },
      }),
      terminalAuthority: 'authority' as const,
    };
    const outcome = await host.run(
      { bus, call: bus.own('root'), workspace, config, signal: new AbortController().signal },
      { ...runPorts, allowSourceFree: true },
    );
    expect(outcome.result.status).toBe('completed');
    expect(outcome.afterStepsErrors).toEqual([]);
    expect(events).toEqual([
      `${extension}.before-steps`,
      `${dependent}.before-steps`,
      `${dependent}.after-steps`,
      `${extension}.after-steps`,
    ]);
  } finally {
    await close();
    await rm(workspace, { recursive: true, force: true });
  }
});

type RunCase =
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'path'
  | 'revision'
  | 'identity'
  | 'phase'
  | 'replaced'
  | 'first-step-revision'
  | 'second-step-revision'
  | 'follow-up-revision'
  | 'follow-up-unproven'
  | 'early-follow-up-unproven'
  | 'follow-up-abort';

// The parent exits after recording its live group member so closure is unconfirmed.
const leaveGroupMember = `
  const member = spawn(process.execPath, [
    '-e', 'require("node:net").createServer().listen(0, "127.0.0.1")'
  ], { stdio: 'ignore' });
  await once(member, 'spawn');
  member.unref();
  await appendFile(memberPidFile, String(member.pid));
`;

/**
 * Prepare an admitted local Git workflow for the process runner.
 * @param root - Fixture root.
 * @param mode - Outcome or admission fault to exercise.
 * @param extensions - Additional declarations in the admitted workflow.
 * @returns Git source, operation, run configuration and external step marker.
 */
async function prepare(root: string, mode: RunCase, extensions?: WorkflowDefinition['extensions']) {
  const original = join(root, 'original');
  const workspace = join(root, 'runs');
  await mkdir(original);
  await mkdir(workspace);
  const marker = join(root, 'events');
  const imported = join(root, 'imports');
  const prepared = join(root, 'prepared');
  const followedUp = join(root, 'follow-up');
  const nodes = [{ id: 'record', type: 'code-step' as const }];
  if (mode === 'second-step-revision') nodes.push({ id: 'next', type: 'code-step' });
  const definition = {
    id: 'workflow-1',
    scope: { type: 'global' },
    extensions: { ...extensions, [extension]: true },
    root: { id: 'root', type: 'sequence', nodes },
  } as const;
  await writeFile(
    join(original, 'flow.mjs'),
    `
    import { execFileSync, spawn } from 'node:child_process';
    import { once } from 'node:events';
    import { appendFile } from 'node:fs/promises';
    import { dirname, join } from 'node:path';
    await appendFile(${JSON.stringify(imported)}, process.cwd() + '\\n');
    const record = async () => {
      await appendFile(${JSON.stringify(marker)}, 'step\\n');
      if (${JSON.stringify(mode === 'failed')}) throw new Error('Step failed');
      if (${JSON.stringify(mode === 'follow-up-revision')}) {
        const checkout = join(dirname(process.cwd()), 'source', 'checkout');
        execFileSync('git', ['-C', checkout, 'checkout', '--quiet', '--detach', 'origin/alternate']);
      }
      if (${JSON.stringify(mode === 'follow-up-unproven')}) {
        const memberPidFile = ${JSON.stringify(join(root, 'member.pid'))};
        ${leaveGroupMember}
      }
      return null;
    };
    export default {
      definition: ${JSON.stringify(definition)},
      runtimeHandlers: new Map([['record', record], ['next', record]]),
    };`,
  );
  await git(original, 'init', '--quiet');
  await git(original, 'add', 'flow.mjs');
  const revision = await commitFixture(original);
  if (mode === 'first-step-revision' || mode === 'second-step-revision' || mode === 'follow-up-revision') {
    const alternate = await commitFixture(original, '--allow-empty');
    await git(original, 'update-ref', 'refs/heads/alternate', alternate);
    await git(original, 'reset', '--hard', revision);
  }
  const checkoutId = await realpath(original);
  const source: AdmittedFixedWorkflowSource = {
    extension,
    declaration: true,
    block: null,
    path: mode === 'path' ? 'missing.mjs' : 'flow.mjs',
    revision: mode === 'revision' ? 'f'.repeat(40) : revision,
    checkoutId: mode === 'identity' ? 'other-checkout' : checkoutId,
    verify: verifyFixtureCheckout,
  };
  const operation: FixedOperationContribution = {
    ...sourceOperation,
    phase: mode === 'phase' ? 'before-steps' : 'workflow-source',
    run: (ctx) => cloneFixtureCheckout(ctx, original),
  };
  const config = {
    ...makeWorkerConfig({
      definition: { ...definition, root: { ...definition.root, nodes: [...definition.root.nodes] } },
    }),
    terminalAuthority: 'authority' as const,
  };
  const preparation: FixedOperationContribution = {
    name: `${extension}.prepare`,
    phase: 'before-steps',
    applies: () => true,
    async run({ workspace }) {
      await writeFile(prepared, await realpath(workspace));
      return { ok: true, facts: {} };
    },
  };
  const followUp: FixedOperationContribution = {
    name: `${extension}.finish`,
    phase: 'after-steps',
    applies: () => true,
    async run({ launch }) {
      const result = await launch({
        command: process.execPath,
        args: ['-e', 'require("node:fs").writeFileSync(process.argv[1], "")', followedUp],
        env: {},
        timeoutMs: 5_000,
        output: { kind: 'ignore' },
      }).result;
      return result.status === 'completed'
        ? { ok: true, facts: {} }
        : { ok: false, facts: {}, detail: 'marker-failed' };
    },
  };
  return {
    workspace,
    source,
    operations: [operation, preparation, followUp],
    config,
    marker,
    imported,
    prepared,
    followedUp,
  };
}

const followUpOwner = 'follow-up-tools';

/**
 * Reap the fixture's surviving group member after testing unconfirmed closure.
 * @param root - Fixture root that holds the member's recorded process ID.
 */
async function stopFixtureMember(root: string): Promise<void> {
  const pid = Number(await readFile(join(root, 'member.pid'), 'utf8').catch(() => ''));
  if (pid <= 1) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
  }
}

const followUpCases: ReadonlyArray<{
  readonly mode: RunCase;
  readonly code: WorkflowErrorCode | FixedOperationFailure;
  readonly verifications: number;
}> = [
  { mode: 'follow-up-revision', code: WorkflowErrorCode.SOURCE_MISMATCH, verifications: 2 },
  { mode: 'follow-up-abort', code: 'operation-aborted', verifications: 1 },
  ...(process.platform === 'win32'
    ? []
    : [
        { mode: 'follow-up-unproven', code: 'process-closure-unconfirmed', verifications: 0 } as const,
        { mode: 'early-follow-up-unproven', code: 'process-closure-unconfirmed', verifications: 0 } as const,
      ]),
];

// The launcher may take 2 s to give up, in addition to Git setup and two process starts.
it.each(followUpCases)('records source-bound follow-up failures and retains the step outcome ($mode)', async ({
  mode,
  code,
  verifications,
}) => {
  const root = await mkdtemp(join(tmpdir(), 'fixed-operation-revised-follow-up-'));
  const { workspace, source, operations, config, marker, followedUp } = await prepare(root, mode, {
    [followUpOwner]: true,
  });
  const events: string[] = [];
  const earlyUnproven = mode === 'early-follow-up-unproven';
  const afterSteps = new AbortController();
  let afterStepVerifications = 0;
  let earlyContainment: string | undefined;
  const verify: AdmittedFixedWorkflowSource['verify'] = async (checkout, path) => {
    if ((await readFile(marker, 'utf8').catch(() => '')) === 'step\n') {
      afterStepVerifications += 1;
      if (mode === 'follow-up-abort') afterSteps.abort();
    }
    return verifyFixtureCheckout(checkout, path);
  };
  const recordOperation = (suffix: string, phase: FixedOperationContribution['phase']): FixedOperationContribution => ({
    name: `${followUpOwner}.${suffix}`,
    phase,
    applies: () => true,
    async run({ verifiedSource, workflowRoot }) {
      events.push(suffix);
      expect(verifiedSource).toBeUndefined();
      expect(workflowRoot).toBeUndefined();
      return { ok: true, facts: { [suffix]: true } };
    },
  });
  const earlyFollowUp: FixedOperationContribution = {
    ...recordOperation('early', 'after-steps'),
    async run({ launch }) {
      events.push('early');
      const result = await launch({
        command: process.execPath,
        args: [
          '--input-type=module',
          '-e',
          `import { spawn } from 'node:child_process';
           import { once } from 'node:events';
           import { appendFile } from 'node:fs/promises';
           const memberPidFile = process.argv[1];
           ${leaveGroupMember}`,
          join(root, 'member.pid'),
        ],
        env: {},
        timeoutMs: 5_000,
        output: { kind: 'ignore' },
      }).result;
      earlyContainment = result.containment?.kind;
      return { ok: true, facts: { early: true } };
    },
  };
  const { host, bus, coordinator, close } = composeFixedOperationHost(
    [
      makeFixedOperationExtension(extension, operations),
      makeFixedOperationExtension(followUpOwner, [
        recordOperation('prepared', 'before-steps'),
        ...(earlyUnproven ? [earlyFollowUp] : []),
        { ...recordOperation('blocked', 'after-steps'), requiresVerifiedSource: true },
        recordOperation('finished', 'after-steps'),
      ]),
    ],
    workspace,
  );
  try {
    await coordinator.startAll();
    const outcome = await host.run(
      { bus, call: bus.own('root'), workspace, config, signal: new AbortController().signal },
      { ...runPorts, source: { ...source, verify }, afterStepsSignal: afterSteps.signal },
    );
    const unproven = mode === 'follow-up-unproven';
    const aborted = mode === 'follow-up-abort';
    expect(outcome.result).toMatchObject({
      status: unproven ? 'failed' : 'completed',
      executionId: config.executionId,
    });
    if (unproven && outcome.result.status === 'failed')
      expect(outcome.result.error).not.toBe('stepRunnerClosureUnconfirmed');
    expect(outcome.facts.get(followUpOwner)).toEqual(aborted ? { prepared: true } : { prepared: true, finished: true });
    const error = expect.objectContaining(
      code === WorkflowErrorCode.SOURCE_MISMATCH ? { code } : { code, phase: 'after-steps' },
    );
    expect(outcome.afterStepsErrors).toEqual([...(aborted || earlyUnproven ? [error] : []), error, error]);
    expect(events).toEqual(['prepared', ...(earlyUnproven ? ['early'] : []), ...(aborted ? [] : ['finished'])]);
    expect(afterStepVerifications).toBe(verifications);
    if (earlyUnproven) expect(earlyContainment).toBe('unproven');
    await expect(readFile(marker, 'utf8')).resolves.toBe('step\n');
    await expect(readFile(followedUp)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readdir(workspace)).resolves.toHaveLength(unproven || earlyUnproven ? 1 : 0);
  } finally {
    try {
      await stopFixtureMember(root);
    } finally {
      await close();
      await rm(root, { recursive: true, force: true });
    }
  }
}, 15_000);

it.each([
  ['throws', 'operation-failed'],
  ['promise', 'invalid-registration'],
  ['retired', 'inactive-registration'],
] as const)('keeps completed results and facts when a follow-up selection %s', async (mode, code) => {
  const root = await mkdtemp(join(tmpdir(), 'fixed-operation-follow-up-'));
  const { workspace, source, operations, config, marker, followedUp } = await prepare(root, 'completed', {
    [followUpOwner]: true,
  });
  const events: string[] = [];
  const followUp: FixedOperationContribution = {
    name: `${followUpOwner}.finish`,
    phase: 'after-steps',
    applies() {
      events.push('predicate');
      throw new Error('Cannot select follow-up');
    },
    async run() {
      events.push('invalid follow-up ran');
      return { ok: true, facts: {} };
    },
  };
  if (mode === 'promise') {
    Reflect.set(followUp, 'applies', () => {
      events.push('predicate');
      return Promise.reject(new Error('Cannot select follow-up asynchronously'));
    });
  }
  const { host, bus, coordinator, close } = composeFixedOperationHost(
    [
      makeFixedOperationExtension(extension, operations),
      {
        ...makeFixedOperationExtension(followUpOwner, [
          {
            name: `${followUpOwner}.prepare`,
            phase: 'before-steps',
            applies: () => true,
            run: async () => ({ ok: true, facts: { prepared: true } }),
          },
          followUp,
        ]),
        dependencies: [dep(extension)],
      },
    ],
    workspace,
  );
  const off = bus.on(
    WorkflowStorageSubjects.setFrame,
    async (ctx) => {
      if (mode === 'retired' && ctx.payload.frame.nodeId === 'record' && ctx.payload.frame.status === 'completed') {
        const transition = await coordinator.applyExtensionTransition(followUpOwner, false);
        events.push(transition);
      }
      await ctx.next();
    },
    { priority: 100 },
  );
  try {
    await coordinator.startAll();
    const outcome = await host.run(
      { bus, call: bus.own('root'), workspace, config, signal: new AbortController().signal },
      {
        ...runPorts,
        source,
        withAddresses(name, run) {
          if (name === `${extension}.finish`) events.push('valid follow-up');
          return runPorts.withAddresses(name, run);
        },
      },
    );
    expect(outcome.result).toMatchObject({ status: 'completed', executionId: config.executionId });
    expect(outcome.facts.get(followUpOwner)).toEqual({ prepared: true });
    expect(outcome.afterStepsErrors).toEqual([expect.objectContaining({ code, phase: 'after-steps' })]);
    expect(events).toEqual([mode === 'retired' ? 'applied' : 'predicate', 'valid follow-up']);
    await expect(readFile(marker, 'utf8')).resolves.toBe('step\n');
    await expect(readFile(followedUp, 'utf8')).resolves.toBe('');
    await expect(readdir(workspace)).resolves.toEqual([]);
  } finally {
    off();
    await close();
    await rm(root, { recursive: true, force: true });
  }
});

it.each([
  'completed',
  'failed',
  'cancelled',
  'path',
  'revision',
  'identity',
  'phase',
  'replaced',
] as const)('verifies the real checkout and retires the private workspace (%s)', async (mode) => {
  const root = await mkdtemp(join(tmpdir(), 'fixed-operation-host-'));
  const { workspace, source, operations, config, marker, prepared, followedUp } = await prepare(root, mode);
  const { host, bus, coordinator, close } = compose(operations, workspace);
  const controller = new AbortController();
  const off = bus.on(
    WorkflowStorageSubjects.setFrame,
    async (ctx) => {
      if (mode === 'cancelled' && ctx.payload.frame.nodeId === 'record') controller.abort();
      await ctx.next();
    },
    { priority: 100 },
  );
  const verification = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const invoked: string[] = [];
  try {
    await coordinator.startAll();
    const attempt = (executionId: string) =>
      host.run(
        { bus, call: bus.own('root'), workspace, config: { ...config, executionId }, signal: controller.signal },
        {
          ...runPorts,
          withAddresses: async (name, run) => {
            invoked.push(name);
            return runPorts.withAddresses(name, run);
          },
          source: {
            ...source,
            verify: async (root, path, signal) => {
              if (mode === 'replaced') {
                verification.resolve();
                await resume.promise;
              }
              return source.verify(root, path, signal);
            },
          },
        },
      );
    const result = attempt('first');
    if (mode === 'replaced') {
      void result.catch(() => undefined);
      await Promise.race([verification.promise, result]);
      await coordinator.applyExtensionTransition(extension, false);
      await coordinator.applyExtensionTransition(extension, true);
      resume.resolve();
      await expect(result).rejects.toMatchObject({ code: 'inactive-registration' });
    } else if (mode === 'completed' || mode === 'failed' || mode === 'cancelled') {
      await expect(result).resolves.toMatchObject({ result: { status: mode } });
      if (mode === 'completed') {
        await expect(readdir(workspace)).resolves.toEqual([]);
        await expect(attempt('retry')).resolves.toMatchObject({ result: { status: mode } });
        await expect(readFile(marker, 'utf8')).resolves.toBe('step\nstep\n');
        await expect(readFile(followedUp, 'utf8')).resolves.toBe('');
      }
    } else {
      await expect(result).rejects.toMatchObject({
        code: mode === 'phase' ? 'missing-source' : WorkflowErrorCode.SOURCE_MISMATCH,
      });
    }
    await expect(readdir(workspace)).resolves.toEqual([]);
    if (mode !== 'completed' && mode !== 'failed' && mode !== 'cancelled') {
      await expect(readFile(prepared)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(followedUp)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(invoked).not.toContain(`${extension}.finish`);
    }
    if (mode !== 'completed' && mode !== 'failed') {
      await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  } finally {
    resume.resolve();
    off();
    await close();
    await rm(root, { recursive: true, force: true });
  }
});

it.each([
  ['first-step-revision', 'record'],
  ['second-step-revision', 'next'],
] as const)('rejects a changed checkout before code import (%s)', async (mode, nodeId) => {
  const root = await mkdtemp(join(tmpdir(), 'fixed-operation-host-'));
  const { workspace, source, operations, config, marker, imported, prepared, followedUp } = await prepare(root, mode, {
    [followUpOwner]: true,
  });
  const cleanupMarker = join(root, 'cleanup');
  const { host, bus, coordinator, close } = composeFixedOperationHost(
    [
      makeFixedOperationExtension(extension, operations),
      makeFixedOperationExtension(followUpOwner, [
        {
          name: `${followUpOwner}.prepare`,
          phase: 'before-steps',
          applies: () => true,
          run: async () => ({ ok: true, facts: {} }),
        },
        {
          name: `${followUpOwner}.cleanup`,
          phase: 'after-steps',
          applies: () => true,
          async run({ verifiedSource, workflowRoot, sourceDirectory }) {
            expect(verifiedSource).toBeUndefined();
            expect(workflowRoot).toBeUndefined();
            expect(await realpath(join(sourceDirectory, 'checkout'))).toBe(checkout);
            await appendFile(cleanupMarker, 'cleanup\n');
            return { ok: true, facts: {} };
          },
        },
      ]),
    ],
    workspace,
  );
  let checkout: string | undefined;
  const beforeImport = bus.on(
    WorkflowStorageSubjects.setFrame,
    async (ctx) => {
      const { frame } = ctx.payload;
      if (frame.nodeId === nodeId && frame.status === 'running') {
        assert.ok(checkout);
        await git(checkout, 'checkout', '--quiet', '--detach', 'origin/alternate');
      }
      await ctx.next();
    },
    { priority: 100 },
  );
  try {
    await coordinator.startAll();
    await expect(
      host.run(
        { bus, call: bus.own('root'), workspace, config, signal: new AbortController().signal },
        {
          ...runPorts,
          source: {
            ...source,
            async verify(root, path, signal) {
              checkout = root;
              return source.verify(root, path, signal);
            },
          },
        },
      ),
    ).rejects.toMatchObject({
      cause: { code: WorkflowErrorCode.SOURCE_MISMATCH },
      errors: [
        expect.objectContaining({ code: WorkflowErrorCode.SOURCE_MISMATCH }),
        expect.objectContaining({ code: 'missing-source', phase: 'after-steps' }),
      ],
    });
    if (mode === 'first-step-revision') {
      await expect(readFile(imported)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    } else {
      const cwd = await readFile(prepared, 'utf8');
      assert.ok(checkout);
      expect(relative(checkout, cwd)).toMatch(/^\.\.[/\\]/u);
      expect(relative(cwd, checkout)).toMatch(/^\.\.[/\\]/u);
      await expect(readFile(imported, 'utf8')).resolves.toBe(`${cwd}\n`);
      await expect(readFile(marker, 'utf8')).resolves.toBe('step\n');
    }
    await expect(readFile(followedUp)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(cleanupMarker, 'utf8')).resolves.toBe('cleanup\n');
    await expect(readdir(workspace)).resolves.toEqual([]);
  } finally {
    beforeImport();
    await close();
    await rm(root, { recursive: true, force: true });
  }
});

it.each([
  ['authority', { code: WorkflowErrorCode.NOT_EXECUTABLE }],
  ['verifier', { code: WorkflowErrorCode.SOURCE_MISMATCH }],
  ['path syntax', { code: WorkflowErrorCode.SOURCE_MISMATCH }],
  ['missing source', { code: 'missing-source', phase: 'workflow-source' }],
] as const)('rejects invalid %s before creating a private root', async (mode, error) => {
  const root = await mkdtemp(join(tmpdir(), 'fixed-operation-host-'));
  const { workspace, source, operations, config } = await prepare(root, 'completed');
  const { host, bus, coordinator, close } = compose(operations, workspace);
  try {
    await coordinator.startAll();
    if (mode === 'authority') Reflect.deleteProperty(config, 'terminalAuthority');
    if (mode === 'verifier') Reflect.deleteProperty(source, 'verify');
    await expect(
      host.run(
        {
          bus,
          call: bus.own('root'),
          config,
          // Directory allocation would fail before source checks if the boundary were entered.
          workspace: join(workspace, 'absent'),
          signal: new AbortController().signal,
        },
        {
          ...runPorts,
          source:
            mode === 'missing source'
              ? undefined
              : { ...source, path: mode === 'path syntax' ? '../flow.mjs' : source.path },
        },
      ),
    ).rejects.toMatchObject(error);
    await expect(readdir(workspace)).resolves.toEqual([]);
  } finally {
    await close();
    await rm(root, { recursive: true, force: true });
  }
});
