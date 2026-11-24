import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { WorkflowDefinition } from '@makaio/contracts';
import { WorkflowStorageSubjects } from '@makaio/subsystem-workflow-engine';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { runProcessWorkflowWithFixedOperations } from '../fixed-operation-workflow.js';
import { computeContributionPackageDigest, verifyContribution } from '../local-directory-materializer.js';
import {
  registerFixedOperations,
  type FixedOperationContribution,
  type FixedOperationExtension,
  type FixedOperationRun,
} from '../runtime/fixed-operations.js';
import { makeBusWithStorage, makeWorkerConfig } from './fixtures.js';

vi.setConfig({ testTimeout: 30_000 });

/**
 * Install, verify and import a package with real runner-side operations.
 * @param workspace - Materialized task root.
 * @param sourceOutcome - Optional JavaScript expression for the source operation's raw return value.
 * @returns Operations from the verified worker entrypoint.
 */
async function loadVerifiedExtension(workspace: string, sourceOutcome?: string): Promise<FixedOperationExtension> {
  const packageName = 'source-tools';
  const version = '1.0.0';
  const entrypoint = 'worker.mjs';
  const directory = join(workspace, 'node_modules', packageName);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: packageName, version }));
  await writeFile(
    join(directory, entrypoint),
    `import { appendFile } from 'node:fs/promises';
    import { join, sep } from 'node:path';
    const mark = (workspace, value) => appendFile(join(workspace, 'events'), value + '\\n');
    export default {
      name: 'source-tools',
      fixedOperations: [
        { name: 'source-tools.provide', phase: 'workflow-source', applies: () => true,
          async run(ctx) {
            if (ctx.declaration.pin !== 'revision-1' || ctx.block.pin !== 'revision-1') throw Error('Wrong source pin');
            await mark(ctx.workspace, 'source');
            return ${sourceOutcome ?? "{ ok: true, workflowRoot: join(ctx.workspace, 'prepared'), facts: { revision: ctx.declaration.pin } }"};
          } },
        { name: 'source-tools.prepare', phase: 'before-steps', applies: (decl) => decl.enabled,
          async run(ctx) {
            if (ctx.block.purpose !== 'prepare' || ctx.facts.revision !== 'revision-1') throw Error('Wrong preparation scope');
            const [definition] = await ctx.definitions('test-kind');
            const address = await ctx.addresses.open('prepare');
            if (address !== 'source-tools.prepare/prepare') throw Error('Wrong mediated scope');
            const processResult = await ctx.launch({
              command: process.execPath,
              args: ['-e', 'process.exit(process.env.HOME.split(' + JSON.stringify(sep) + ').includes("runtime") ? 0 : 1)'],
              owner: { kind: 'step', stepId: 'foreign', execution: 1 },
              env: {}, output: { kind: 'ignore' }, timeoutMs: 5000,
            }).result;
            await ctx.addresses.close('prepare');
            if (processResult.status !== 'completed') {
              throw Error('Expected a runtime-owned process');
            }
            await mark(ctx.workspace, 'prepare-source');
            return { ok: true, facts: { definition } };
          } },
        { name: 'source-tools.finish', phase: 'after-steps', applies: (decl) => decl.enabled,
          async run(ctx) {
            if (ctx.quiescence.kind !== 'quiescent' || ctx.facts.definition !== 'revision-1') throw Error('Wrong cleanup scope');
            await mark(ctx.workspace, 'finish-source');
            return { ok: true, facts: { closed: true } };
          } },
      ],
    };`,
  );
  const integrity = await computeContributionPackageDigest(directory, 'sha256');
  const verified = await verifyContribution({ packageName, version, entrypoint, integrity }, workspace);
  const module: unknown = await import(pathToFileURL(verified).href);
  return z
    .object({
      default: z.object({
        name: z.literal(packageName),
        fixedOperations: z.array(
          z.object({
            name: z.string(),
            phase: z.enum(['workflow-source', 'before-steps', 'after-steps']),
            applies: z.custom<FixedOperationContribution['applies']>((value) => typeof value === 'function'),
            run: z.custom<FixedOperationContribution['run']>((value) => typeof value === 'function'),
          }),
        ),
      }),
    })
    .parse(module).default;
}

/**
 * Make an authority-owned run backed by the in-memory storage protocol and a real code-step program.
 * @param extensions - Declarations on the frozen workflow.
 * @param signal - Optional cancellation signal for the run.
 * @param fail - Whether the code step should fail.
 * @returns Execution inputs and cleanup.
 */
async function createRun(
  extensions?: WorkflowDefinition['extensions'],
  signal = new AbortController().signal,
  fail = false,
) {
  const workspace = await mkdtemp(join(tmpdir(), 'workflow-fixed-operations-'));
  const [bus, cleanup] = makeBusWithStorage();
  const off = bus.on(WorkflowStorageSubjects.getRunContext, (ctx) => ctx.setResult({ runContext: null }));
  const definition: WorkflowDefinition = {
    id: 'workflow-1',
    scope: { type: 'global' },
    extensions,
    root: { id: 'root', type: 'sequence', nodes: [{ id: 'record', type: 'code-step' }] },
  };
  const config = { ...makeWorkerConfig({ definition }), terminalAuthority: 'authority' as const };
  await mkdir(join(workspace, 'prepared'));
  await writeFile(
    join(workspace, 'prepared', 'flow.mjs'),
    `import { appendFile } from 'node:fs/promises';
     export default {
       definition: ${JSON.stringify(definition)},
       runtimeHandlers: new Map([['record', async (ctx) => {
         for (const key of ['registry', 'fixedOperations', 'definitions', 'addresses']) {
           if (key in ctx) throw new Error('Unexpected worker capability');
         }
         await appendFile(${JSON.stringify(join(workspace, 'events'))}, 'step\\n');
         if (${JSON.stringify(fail)}) throw new Error('Step failed');
         return null;
       }]]),
     };`,
  );
  return {
    options: { call: bus.own('root'), bus, config, workspace, signal },
    events: async () => (await readFile(join(workspace, 'events'), 'utf8')).trim().split('\n'),
    async cleanup() {
      off();
      cleanup();
      await rm(workspace, { recursive: true, force: true });
    },
  };
}

const source = {
  extension: 'source-tools',
  path: 'flow.mjs',
  declaration: { pin: 'revision-1', enabled: true },
  block: { pin: 'revision-1' },
};

const ports = {
  definitions: async () => ['revision-1'],
  withAddresses: async (_operation, run) =>
    run({
      open: async () => {
        throw new Error('No mediated address is granted');
      },
      close: async () => {},
    }),
  afterStepsSignal: new AbortController().signal,
} satisfies Pick<FixedOperationRun, 'definitions' | 'withAddresses' | 'afterStepsSignal'>;

/**
 * Make an operation that records execution in the workspace.
 * @param name - Qualified operation name.
 * @param phase - Phase in which the operation executes.
 * @param applies - Selection predicate.
 * @returns A filesystem-backed operation.
 */
function mark(
  name: string,
  phase: FixedOperationContribution['phase'],
  applies: FixedOperationContribution['applies'] = () => true,
): FixedOperationContribution {
  return {
    name,
    phase,
    applies,
    async run({ workspace, stepStatus }) {
      const event = stepStatus === undefined ? name : `${name}:${stepStatus}`;
      await appendFile(join(workspace, 'events'), `${event}\n`);
      return { ok: true, facts: {} };
    },
  };
}

it('runs verified source, resolver, extension phases and isolated steps in dependency order', async () => {
  const run = await createRun({
    'source-tools': source.declaration,
    dependent: { enabled: true },
    disabled: false,
  });
  try {
    const extension = await loadVerifiedExtension(run.options.workspace);
    const registry = registerFixedOperations([
      extension,
      {
        name: 'dependent',
        fixedOperations: [
          {
            ...mark('dependent.resolve', 'workflow-source', () => {
              throw new Error('The named resolver does not call applies');
            }),
            async run({ block, declaration, facts, workflowRoot, workspace }) {
              expect(block).toBeUndefined();
              expect(declaration).toEqual({ resolver: 'dependent.resolve' });
              expect(facts).toEqual({});
              expect(workflowRoot).toBe(join(workspace, 'prepared'));
              await appendFile(join(workspace, 'events'), 'resolver\n');
              return { ok: true, facts: {} };
            },
          },
          mark('dependent.first', 'before-steps'),
          mark('dependent.second', 'before-steps'),
          mark('dependent.finish', 'after-steps'),
        ],
      },
      {
        name: 'disabled',
        fixedOperations: [
          mark('disabled.prepare', 'before-steps', () => false),
          mark('disabled.finish', 'after-steps'),
        ],
      },
      { name: 'undeclared', fixedOperations: [mark('undeclared.prepare', 'before-steps')] },
    ]);
    const leases = new Set<string>();
    const execution = await runProcessWorkflowWithFixedOperations(run.options, {
      ...ports,
      async withAddresses(operation, runOperation) {
        try {
          return await runOperation({
            open: async (purpose) => {
              const address = `${operation}/${purpose}`;
              leases.add(address);
              return address;
            },
            close: async (purpose) => {
              expect(leases.delete(`${operation}/${purpose}`)).toBe(true);
            },
          });
        } finally {
          expect(leases.size).toBe(0);
        }
      },
      registry,
      source: { ...source, dependencies: { resolver: 'dependent.resolve' } },
      blocks: { 'source-tools': { purpose: 'prepare' }, dependent: { other: true } },
    });
    expect(execution.result.status).toBe('completed');
    expect(leases.size).toBe(0);
    expect(execution.facts.get('source-tools')).toEqual({
      revision: 'revision-1',
      definition: 'revision-1',
      closed: true,
    });
    await expect(run.events()).resolves.toEqual([
      'source',
      'resolver',
      'prepare-source',
      'dependent.first',
      'dependent.second',
      'step',
      'dependent.finish:completed',
      'finish-source',
    ]);
  } finally {
    await run.cleanup();
  }
});

it.each([
  ['foreign-owner', [mark('other.prepare', 'before-steps')]],
  ['duplicate-operation', [mark('own.prepare', 'before-steps'), mark('own.prepare', 'after-steps')]],
  ['duplicate-source', [mark('own.first', 'workflow-source'), mark('own.second', 'workflow-source')]],
])('rejects %s during registration', (code, fixedOperations) => {
  expect(() => registerFixedOperations([{ name: 'own', fixedOperations }])).toThrow(
    `Fixed operation registration: ${code}`,
  );
});

it.each([
  ['missing-source', { ...source, extension: 'absent' }],
  ['invalid-resolver', { ...source, dependencies: { resolver: 'source-tools.provide' } }],
  ['invalid-resolver', { ...source, dependencies: { resolver: 'source-tools.prepare' } }],
])('rejects %s before any operation or step runs', async (code, requestedSource) => {
  const run = await createRun({ 'source-tools': source.declaration });
  try {
    const extension = await loadVerifiedExtension(run.options.workspace);
    const registry = registerFixedOperations([extension]);
    await expect(
      runProcessWorkflowWithFixedOperations(run.options, { ...ports, registry, source: requestedSource }),
    ).rejects.toMatchObject({ code, phase: 'workflow-source' });
    await expect(run.events()).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await run.cleanup();
  }
});

it.each([
  ['missing', {}],
  ['different', { 'source-tools': { pin: 'revision-2' } }],
])('rejects a %s frozen source declaration before any operation or step', async (_case, extensions) => {
  const run = await createRun(extensions);
  try {
    const registry = registerFixedOperations([await loadVerifiedExtension(run.options.workspace)]);
    await expect(
      runProcessWorkflowWithFixedOperations(run.options, { ...ports, registry, source }),
    ).rejects.toMatchObject({
      code: 'source-declaration-mismatch',
      phase: 'workflow-source',
    });
    await expect(run.events()).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await run.cleanup();
  }
});

it.each([
  true,
  false,
])('runs only prepared owners after a later preparation fails (follow-up fails: %s)', async (failFollowUp) => {
  const run = await createRun({ ready: true, blocked: true });
  try {
    const registry = registerFixedOperations([
      {
        name: 'ready',
        fixedOperations: [
          mark('ready.prepare', 'before-steps'),
          {
            ...mark('ready.finish', 'after-steps'),
            async run(ctx) {
              const outcome = await mark('ready.finish', 'after-steps').run(ctx);
              return failFollowUp ? { ok: false, detail: 'cleanup-failed', facts: {} } : outcome;
            },
          },
        ],
      },
      {
        name: 'blocked',
        fixedOperations: [
          {
            ...mark('blocked.prepare', 'before-steps'),
            run: async () => ({ ok: false, detail: 'not-ready', facts: {} }),
          },
          mark('blocked.finish', 'after-steps'),
        ],
      },
    ]);
    const primary = { code: 'operation-failed', phase: 'before-steps', detail: 'not-ready' };
    const failure = failFollowUp
      ? {
          cause: expect.objectContaining(primary),
          errors: [expect.objectContaining(primary), expect.objectContaining({ detail: 'cleanup-failed' })],
        }
      : primary;
    await expect(runProcessWorkflowWithFixedOperations(run.options, { ...ports, registry })).rejects.toMatchObject(
      failure,
    );
    await expect(run.events()).resolves.toEqual(['ready.prepare', 'ready.finish:not-started']);
  } finally {
    await run.cleanup();
  }
});

it('runs the follow-up after successful preparation races with cancellation', async () => {
  const controller = new AbortController();
  const run = await createRun({ stopping: true }, controller.signal);
  try {
    const registry = registerFixedOperations([
      {
        name: 'stopping',
        fixedOperations: [
          {
            ...mark('stopping.prepare', 'before-steps'),
            async run(ctx) {
              expect(ctx.signal).toBe(controller.signal);
              const outcome = await mark('stopping.prepare', 'before-steps').run(ctx);
              controller.abort(new Error('Cancelled during preparation'));
              return outcome;
            },
          },
          mark('stopping.finish', 'after-steps'),
        ],
      },
    ]);
    await expect(runProcessWorkflowWithFixedOperations(run.options, { ...ports, registry })).rejects.toMatchObject({
      code: 'operation-aborted',
      phase: 'before-steps',
    });
    await expect(run.events()).resolves.toEqual(['stopping.prepare', 'stopping.finish:not-started']);
  } finally {
    await run.cleanup();
  }
});

it.each([
  ['null outcome', 'null'],
  ['missing facts', '{ ok: true }'],
  ['invalid workflow root type', '{ ok: true, facts: {}, workflowRoot: 1 }'],
  ['function fact', '{ ok: true, facts: { value: () => 1 } }'],
  ['map fact', '{ ok: true, facts: { value: new Map() } }'],
  ['cyclic facts', '(() => { const facts = {}; facts.self = facts; return { ok: true, facts }; })()'],
])('rejects a dynamically loaded operation with %s', async (_case, rawOutcome) => {
  const run = await createRun({ 'source-tools': source.declaration });
  try {
    const registry = registerFixedOperations([await loadVerifiedExtension(run.options.workspace, rawOutcome)]);
    await expect(
      runProcessWorkflowWithFixedOperations(run.options, { ...ports, registry, source }),
    ).rejects.toMatchObject({
      code: 'operation-failed',
      phase: 'workflow-source',
    });
    await expect(run.events()).resolves.toEqual(['source']);
  } finally {
    await run.cleanup();
  }
});

it('uses a stable abort code when a preparation callback rejects on cancellation', async () => {
  const controller = new AbortController();
  const run = await createRun({ stopping: true }, controller.signal);
  try {
    const registry = registerFixedOperations([
      {
        name: 'stopping',
        fixedOperations: [
          {
            ...mark('stopping.prepare', 'before-steps'),
            run: async ({ signal }) => {
              controller.abort(new Error('Stopped in preparation'));
              signal.throwIfAborted();
              return { ok: true, facts: {} };
            },
          },
          mark('stopping.finish', 'after-steps'),
        ],
      },
    ]);
    await expect(runProcessWorkflowWithFixedOperations(run.options, { ...ports, registry })).rejects.toMatchObject({
      code: 'operation-aborted',
      phase: 'before-steps',
    });
    await expect(run.events()).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await run.cleanup();
  }
});

it.each(['failed', 'cancelled'] as const)('runs eligible after-operations when steps end %s', async (status) => {
  const controller = new AbortController();
  const run = await createRun(
    { 'source-tools': { ...source.declaration, enabled: false }, cleanup: true },
    controller.signal,
    status === 'failed',
  );
  const off = run.options.bus.on(
    WorkflowStorageSubjects.setFrame,
    async (ctx) => {
      if (status === 'cancelled' && ctx.payload.frame.nodeId === 'record') controller.abort();
      await ctx.next();
    },
    { priority: 100 },
  );
  try {
    const registry = registerFixedOperations([
      await loadVerifiedExtension(run.options.workspace),
      {
        name: 'cleanup',
        fixedOperations: [
          mark('cleanup.prepare', 'before-steps'),
          {
            ...mark('cleanup.finish', 'after-steps'),
            async run({ quiescence, signal, stepStatus }) {
              expect(stepStatus).toBe(status);
              expect(quiescence?.kind).toBe('quiescent');
              expect(signal.aborted).toBe(false);
              return { ok: true, facts: { finished: true } };
            },
          },
        ],
      },
    ]);
    const outcome = await runProcessWorkflowWithFixedOperations(run.options, {
      ...ports,
      registry,
      source: { ...source, declaration: { ...source.declaration, enabled: false } },
    });
    expect(outcome.result.status).toBe(status);
    expect(outcome.facts.get('cleanup')).toEqual({ finished: true });
  } finally {
    off();
    await run.cleanup();
  }
});

it('runs follow-ups with closure evidence after an infrastructure failure', async () => {
  const run = await createRun({ ready: true });
  const failure = new Error('Authority storage unavailable');
  const off = run.options.bus.on(
    WorkflowStorageSubjects.getRunContext,
    () => {
      throw failure;
    },
    { priority: 100 },
  );
  try {
    const registry = registerFixedOperations([
      {
        name: 'ready',
        fixedOperations: [
          mark('ready.prepare', 'before-steps'),
          {
            ...mark('ready.finish', 'after-steps'),
            async run(ctx) {
              expect(ctx.quiescence?.kind).toBe('quiescent');
              return mark('ready.finish', 'after-steps').run(ctx);
            },
          },
        ],
      },
    ]);
    await expect(runProcessWorkflowWithFixedOperations(run.options, { ...ports, registry })).rejects.toMatchObject({
      subject: 'getRunContext',
      message: expect.stringContaining(failure.message),
    });
    await expect(run.events()).resolves.toEqual(['ready.prepare', 'ready.finish:failed']);
  } finally {
    off();
    await run.cleanup();
  }
});

it('keeps the step result and facts while attempting every follow-up', async () => {
  const run = await createRun({ 'source-tools': source.declaration });
  try {
    const extension = await loadVerifiedExtension(run.options.workspace);
    const registry = registerFixedOperations([
      {
        ...extension,
        fixedOperations: [
          ...extension.fixedOperations.filter(({ phase }) => phase === 'workflow-source'),
          mark('source-tools.ready', 'before-steps'),
          {
            ...mark('source-tools.broken', 'after-steps'),
            async run() {
              return { ok: false, detail: 'cleanup-failed', facts: { attempted: true } };
            },
          },
          mark('source-tools.last', 'after-steps'),
        ],
      },
    ]);
    const outcome = await runProcessWorkflowWithFixedOperations(run.options, { ...ports, registry, source });
    expect(outcome.result.status).toBe('completed');
    expect(outcome.facts.get('source-tools')).toEqual({ revision: 'revision-1', attempted: true });
    expect(outcome.afterStepsErrors).toEqual([
      expect.objectContaining({ code: 'operation-failed', detail: 'cleanup-failed' }),
    ]);
    await expect(run.events()).resolves.toEqual([
      'source',
      'source-tools.ready',
      'step',
      'source-tools.last:completed',
    ]);
  } finally {
    await run.cleanup();
  }
});

it("runs a successful source owner's follow-up without a before-steps operation", async () => {
  const run = await createRun({ 'source-tools': source.declaration });
  try {
    const extension = await loadVerifiedExtension(run.options.workspace);
    const registry = registerFixedOperations([
      {
        ...extension,
        fixedOperations: [
          ...extension.fixedOperations.filter(({ phase }) => phase === 'workflow-source'),
          mark('source-tools.finish', 'after-steps'),
        ],
      },
    ]);
    const outcome = await runProcessWorkflowWithFixedOperations(run.options, { ...ports, registry, source });
    expect(outcome.result.status).toBe('completed');
    await expect(run.events()).resolves.toEqual(['source', 'step', 'source-tools.finish:completed']);
  } finally {
    await run.cleanup();
  }
});

it('passes the prepared source root to its follow-up when dependency resolution fails', async () => {
  const run = await createRun({ 'source-tools': source.declaration });
  try {
    const extension = await loadVerifiedExtension(run.options.workspace);
    const finish = mark('source-tools.finish', 'after-steps');
    const registry = registerFixedOperations([
      {
        ...extension,
        fixedOperations: [
          ...extension.fixedOperations.filter(({ phase }) => phase === 'workflow-source'),
          {
            ...finish,
            async run(ctx) {
              expect(ctx.workflowRoot).toBe(join(ctx.workspace, 'prepared'));
              return finish.run(ctx);
            },
          },
        ],
      },
      {
        name: 'dependent',
        fixedOperations: [
          {
            ...mark('dependent.resolve', 'workflow-source'),
            async run() {
              return { ok: false, detail: 'resolver-failed', facts: {} };
            },
          },
        ],
      },
    ]);
    await expect(
      runProcessWorkflowWithFixedOperations(run.options, {
        ...ports,
        registry,
        source: { ...source, dependencies: { resolver: 'dependent.resolve' } },
      }),
    ).rejects.toMatchObject({ code: 'operation-failed', detail: 'resolver-failed' });
    await expect(run.events()).resolves.toEqual(['source', 'source-tools.finish:not-started']);
  } finally {
    await run.cleanup();
  }
});
