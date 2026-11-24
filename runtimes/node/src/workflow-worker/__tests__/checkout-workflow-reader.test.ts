import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkflowErrorCode } from '@makaio/contracts';
import { createLocalLauncher } from '@makaio/subprocess';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bindCheckoutWorkflow,
  loadWorkflowFromCheckout,
  type CheckoutWorkflowBinding,
} from '../checkout-workflow-reader.js';
import { runCheckoutCodeStep, type CheckoutCodeStepInvocation } from '../checkout-code-step.js';
import { STEP_EXECUTION_FAILED } from '../step-interface-schemas.js';

const binding: CheckoutWorkflowBinding = {
  workflowId: 'review',
  source: { path: 'workflows/Review.mjs' },
  sourceRootId: 'home',
  gitRevision: 'a'.repeat(40),
  sourceRoots: [
    { id: 'work', path: '/checkout/work' },
    { id: 'home', path: '/checkout/home' },
  ],
};

describe('checkout workflow binding', () => {
  it('selects the referenced source root and preserves the projected path', () => {
    expect(bindCheckoutWorkflow(binding)).toEqual({
      checkoutRoot: '/checkout/home',
      workflowPath: 'workflows/Review.mjs',
      workflowId: 'review',
    });
  });

  it.each([
    { ...binding, gitRevision: 'main' },
    { ...binding, gitRevision: '' },
    { ...binding, sourceRootId: 'unknown' },
    { ...binding, sourceRoots: [...binding.sourceRoots, { id: 'home', path: '/checkout/duplicate' }] },
  ])('rejects an invalid checkout binding', (input) => {
    expect(() => bindCheckoutWorkflow(input)).toThrow(
      expect.objectContaining({ code: WorkflowErrorCode.SOURCE_MISMATCH }),
    );
  });

  it('requires a revision even when a source root is present', () => {
    const { workflowId, source, sourceRootId, sourceRoots } = binding;
    expect(() => bindCheckoutWorkflow({ workflowId, source, sourceRootId, sourceRoots })).toThrow(
      expect.objectContaining({ code: WorkflowErrorCode.SOURCE_MISMATCH }),
    );
  });
});

const workflowSource = `
export default {
  definition: {
    id: 'review', name: 'Review', triggers: [], scope: { type: 'global' },
    root: { id: 'root', type: 'sequence', nodes: [{ id: 'step', type: 'code-step' }] }
  },
  runtimeHandlers: new Map([['step', () => 'done']])
};
`;

describe('checkout workflow reader', () => {
  let directory: string;
  let checkoutRoot: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'checkout-workflow-'));
    checkoutRoot = join(directory, 'checkout');
    await mkdir(join(checkoutRoot, 'workflows'), { recursive: true });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  /**
   * Prepare a checked workflow entry for a real step process.
   * @param workflowPath - Workflow file relative to the checkout.
   * @param stepId - Registered handler to invoke.
   * @returns Local site, invocation and observations.
   */
  function checkoutProcess(workflowPath: string, stepId = 'step') {
    const { launcher } = createLocalLauncher({
      workspaceRoot: checkoutRoot,
      stepHomeRoot: join(directory, 'steps'),
      runtimeHomeRoot: join(directory, 'runtime'),
    });
    const launch = vi.spyOn(launcher, 'launch');
    const onRequestRefused = vi.fn();
    const invocation: CheckoutCodeStepInvocation = {
      binding: {
        ...binding,
        source: { path: workflowPath },
        sourceRoots: [{ id: 'home', path: checkoutRoot }],
      },
      preparedSource: { rootId: 'home', revision: 'a'.repeat(40) },
      owner: { kind: 'step', stepId: 'step', execution: 1 },
      step: {
        step: stepId,
        workspace: checkoutRoot,
        input: {
          executionId: 'run',
          workflowId: 'review',
          config: {},
          inputs: null,
          previousSteps: {},
          item: 'review-item',
        },
      },
      command: process.execPath,
      args: [
        '--import',
        import.meta.resolve('tsx'),
        fileURLToPath(new URL('../checkout-code-step-entry.ts', import.meta.url)),
      ],
      timeoutMs: 10_000,
      onRequestRefused,
    };
    return { launcher, invocation, launch, onRequestRefused };
  }

  it.skipIf(process.platform === 'win32')(
    'launches the checkout handler with data and typed refusals',
    async () => {
      vi.stubEnv('CHECKOUT_PARENT_CREDENTIAL', 'synthetic-credential');
      const workflowPath = 'workflows/review.mjs';
      const source =
        "process.stdout.write('workflow module diagnostic\\n');\n" +
        workflowSource.replace(
          "() => 'done'",
          `async (context) => {
      console.log('workflow diagnostic');
      process.stdout.write('workflow handler diagnostic\\n');
      setInterval(() => {}, 1_000);
      const { request, launchProcess, item } = { ...context };
      return ({
        request: await request({ subject: 'example.lookup', payload: null }),
        invalidRequest: await request({ subject: '', payload: null }),
        process: await launchProcess({ program: 'example', args: [], cwd: '.', stdin: 'none' }),
        inheritedCredential: 'CHECKOUT_PARENT_CREDENTIAL' in process.env,
        contextKeys: Object.keys(context).sort(),
        item,
      });
      }`,
        );
      await writeFile(join(checkoutRoot, workflowPath), source);
      const { launcher, invocation, launch, onRequestRefused } = checkoutProcess(workflowPath);
      try {
        await expect(
          runCheckoutCodeStep(launcher, {
            ...invocation,
            preparedSource: { rootId: 'home', revision: 'b'.repeat(40) },
          }),
        ).rejects.toMatchObject({ code: WorkflowErrorCode.SOURCE_MISMATCH });
        expect(launch).not.toHaveBeenCalled();
        await expect(runCheckoutCodeStep(launcher, invocation)).resolves.toMatchObject({
          kind: 'reported',
          result: {
            status: 'completed',
            output: {
              request: { ok: false, code: 'request-not-granted' },
              invalidRequest: { ok: false, code: 'request-rejected' },
              process: { ok: false, code: 'site-unreachable' },
              inheritedCredential: false,
              contextKeys: [
                'config',
                'executionId',
                'inputs',
                'item',
                'launchProcess',
                'previousSteps',
                'request',
                'signal',
                'workflowId',
              ],
              item: 'review-item',
            },
          },
        });
        expect(onRequestRefused).toHaveBeenCalledExactlyOnceWith('example.lookup', 'request-not-granted');
      } finally {
        await launcher.closeAll();
      }
    },
    15_000,
  );

  it('relays cancellation to the running checkout handler', async () => {
    const workflowPath = 'workflows/review.mjs';
    const ready = join(checkoutRoot, 'ready');
    const aborted = join(checkoutRoot, 'aborted');
    const source = `import { writeFileSync } from 'node:fs';
${workflowSource.replace(
  "() => 'done'",
  `async (context) => {
    context.signal?.addEventListener('abort', () => writeFileSync(${JSON.stringify(aborted)}, 'yes'));
    writeFileSync(${JSON.stringify(ready)}, 'yes');
    return new Promise(() => {});
  }`,
)}`;
    await writeFile(join(checkoutRoot, workflowPath), source);
    const { invocation } = checkoutProcess(workflowPath);
    const child = spawn(invocation.command, [...(invocation.args ?? [])], { stdio: ['pipe', 'ignore', 'ignore'] });
    const ended = once(child, 'close');
    try {
      child.stdin.write(
        `${JSON.stringify({ ...invocation.step, source: bindCheckoutWorkflow(invocation.binding) })}\n`,
      );
      await expect.poll(() => readFile(ready, 'utf8').catch(() => ''), { timeout: 4000 }).toBe('yes');
      if (process.platform === 'win32') child.stdin.end();
      else child.kill('SIGTERM');
      await ended;
      await expect(readFile(aborted, 'utf8')).resolves.toBe('yes');
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await ended;
    }
  }, 15_000);

  it.skipIf(process.platform === 'win32').each([
    {
      workflowPath: 'workflows/review.mjs',
      stepId: 'step',
      workflowId: 'other',
      error: WorkflowErrorCode.SOURCE_MISMATCH,
    },
    { workflowPath: 'missing.mjs', stepId: 'step', workflowId: 'review', error: WorkflowErrorCode.NOT_EXECUTABLE },
    {
      workflowPath: 'workflows/review.mjs',
      stepId: 'throws',
      workflowId: 'review',
      error: STEP_EXECUTION_FAILED,
    },
    {
      workflowPath: 'workflows/review.mjs',
      stepId: 'missing',
      workflowId: 'review',
      error: WorkflowErrorCode.HANDLER_UNAVAILABLE,
    },
  ])(
    'returns $error from the checkout process',
    async ({ workflowPath, stepId, workflowId, error }) => {
      const withThrowingHandler = workflowSource.replace(
        "['step', () => 'done']",
        `['step', () => 'done'], ['throws', () => {
          throw new WorkflowError('${WorkflowErrorCode.SOURCE_MISMATCH}', 'handler detail');
        }]`,
      );
      const source = `import { WorkflowError } from ${JSON.stringify(import.meta.resolve('@makaio/contracts'))};
${withThrowingHandler}`;
      await writeFile(join(checkoutRoot, 'workflows/review.mjs'), source);
      const { launcher, invocation } = checkoutProcess(workflowPath, stepId);
      try {
        await expect(
          runCheckoutCodeStep(launcher, {
            ...invocation,
            binding: { ...invocation.binding, workflowId },
          }),
        ).resolves.toMatchObject({ kind: 'reported', result: { status: 'failed', error } });
      } finally {
        await launcher.closeAll();
      }
    },
    15_000,
  );

  it('loads the expected workflow module and its registered handlers', async () => {
    const workflowPath = 'workflows/review.mjs';
    await writeFile(join(checkoutRoot, workflowPath), workflowSource);
    const readerInput = bindCheckoutWorkflow({
      ...binding,
      source: { path: workflowPath },
      gitRevision: 'b'.repeat(64),
      sourceRoots: [
        { id: 'work', path: checkoutRoot },
        { id: 'home', path: checkoutRoot },
      ],
    });
    const loaded = await loadWorkflowFromCheckout(readerInput);
    expect(loaded.definition.id).toBe('review');
    expect(loaded.runtimeHandlers.get('step')).toBeTypeOf('function');
    await expect(
      loadWorkflowFromCheckout({ checkoutRoot, workflowPath, workflowId: 'different' }),
    ).rejects.toMatchObject({ code: WorkflowErrorCode.SOURCE_MISMATCH });
  });

  it('selects the frozen workflow ID from a bundle', async () => {
    const workflowPath = 'workflows/bundle.mjs';
    const review = workflowSource.replace('export default', 'const review =');
    await writeFile(
      join(checkoutRoot, workflowPath),
      `${review}
      const other = { ...review, definition: { ...review.definition, id: 'other' }, runtimeHandlers: new Map() };
      export default { workflows: [other, review] };`,
    );
    const loaded = await loadWorkflowFromCheckout({ checkoutRoot, workflowPath, workflowId: 'review' });
    expect(loaded.definition.id).toBe('review');
    expect(loaded.runtimeHandlers.get('step')).toBeTypeOf('function');
    await expect(loadWorkflowFromCheckout({ checkoutRoot, workflowPath, workflowId: 'absent' })).rejects.toMatchObject({
      code: WorkflowErrorCode.SOURCE_MISMATCH,
      message: expect.stringContaining('identity'),
    });
  });

  it('rejects an ambiguous frozen workflow ID in a bundle', async () => {
    const workflowPath = 'workflows/duplicate.mjs';
    const review = workflowSource.replace('export default', 'const review =');
    await writeFile(join(checkoutRoot, workflowPath), `${review}\nexport default { workflows: [review, review] };`);
    await expect(loadWorkflowFromCheckout({ checkoutRoot, workflowPath, workflowId: 'review' })).rejects.toMatchObject({
      code: WorkflowErrorCode.SOURCE_MISMATCH,
      message: expect.stringContaining('ambiguous'),
    });
  });

  it.each([
    '',
    '/outside.mjs',
    '../outside.mjs',
    'workflows/../review.mjs',
    'C:outside.mjs',
    'a\\b.mjs',
  ])('rejects a non-checkout path %j', async (workflowPath) => {
    await expect(loadWorkflowFromCheckout({ checkoutRoot, workflowPath, workflowId: 'review' })).rejects.toMatchObject({
      code: WorkflowErrorCode.SOURCE_MISMATCH,
    });
  });

  it.skipIf(process.platform === 'win32')('rejects a symlink to a module outside the checkout', async () => {
    const externalModule = join(directory, 'outside.mjs');
    const workflowPath = 'workflows/review.mjs';
    await writeFile(externalModule, workflowSource);
    await symlink(externalModule, join(checkoutRoot, workflowPath), 'file');
    await expect(loadWorkflowFromCheckout({ checkoutRoot, workflowPath, workflowId: 'review' })).rejects.toMatchObject({
      code: WorkflowErrorCode.SOURCE_MISMATCH,
    });
  });

  it.each([
    'missing.mjs',
    'workflows',
    'invalid.mjs',
  ])('reports a file or module failure for %s', async (workflowPath) => {
    await writeFile(join(checkoutRoot, 'invalid.mjs'), 'export default null;');
    await expect(loadWorkflowFromCheckout({ checkoutRoot, workflowPath, workflowId: 'review' })).rejects.toMatchObject({
      code: WorkflowErrorCode.NOT_EXECUTABLE,
    });
  });
});
