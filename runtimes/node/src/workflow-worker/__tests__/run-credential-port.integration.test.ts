import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type RequestListener } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { mintCallContext } from '@makaio/bus-core/kernel-api';
import type { StepRunConfig } from '@makaio/contracts';
import {
  createSecret,
  type CredentialResolverContribution,
  type RunCredentialPort,
  type RunCredentialScope,
} from '@makaio/contracts/credential';
import { MAKAIO_JOB_RUN_PARTY_KIND } from '@makaio/core';
import { DuplicateCredentialResolverError, type KernelMakaioExtension } from '@makaio/kernel';
import { createLocalLauncher } from '@makaio/subprocess';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootJournalHost } from '../../__tests__/boot-journal-fixture.js';
import { closeHttpServer, listenOnLoopback } from '../../__tests__/http-test-helpers.js';
import { createHttpWorkerModelPort } from '../agent-step/http-model-port.js';
import { openLocalModelAddress } from '../agent-step/model-mediator.js';
import { createProcessStepRunner } from '../process-step-runner.js';

const refused = { kind: 'purpose-not-granted' };
const acquired = { kind: 'granted', value: true, isCurrent: expect.any(Function) };
const owner = 'credential-fixture';
const git = promisify(execFile);
const step: Extract<StepRunConfig, { stepType: 'agent-step' }> = {
  stepId: 'review',
  stepType: 'agent-step',
  stepDefinition: {
    id: 'review',
    type: 'agent-step',
    role: 'reviewer',
    prompt: 'Review',
    completion: 'turn',
    outputSchema: { type: 'object' },
  },
  resolvedPrompt: 'Review',
  data: { executionId: 'execution', workflowId: 'workflow', inputs: {}, config: {}, previousSteps: {} },
  platformDefaults: { cwd: '.' },
};

const stepSource = `
import { createInterface } from 'node:readline';
const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
const receive = async () => JSON.parse((await lines.next()).value);
const send = (id, method, params) =>
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\\n');
const input = await receive();
send(1, 'credential.resolve', { purpose: 'model.use' });
const denial = await receive();
const response = await fetch(process.env.MAKAIO_MODEL_ADDRESS, {
  method: 'POST',
  body: JSON.stringify({ model: input.model, prompt: input.initialMessage }),
});
const reply = await response.json();
const observed = JSON.stringify([process.env, process.argv, input, denial, reply]);
send(2, 'output.submit', {
  status: 'completed',
  telemetry: { duration: 0 },
  output: {
    approved: response.ok && JSON.parse(reply.text).approved === true,
    invalidReply: reply.code === 'reply-invalid',
    revoked: reply.code === 'environmentMissing',
    credentialRpcRefused: denial.result?.code === 'makaio.step-method-not-supported',
    noCredential: !observed.includes('fixture-authorization-'),
    dataOnly: Object.keys(input).sort().join(',') === 'adapterId,initialMessage,model,ownerInstanceId,responseSchema',
  },
});
await receive();
process.exit(0);
`;

/**
 * Mint the run call at the fixture's trusted owner boundary.
 * @param id - Booked run identifier.
 * @returns Authenticated run call used for local mediation.
 */
function runCall(id: string) {
  const party = { kind: MAKAIO_JOB_RUN_PARTY_KIND, id };
  return mintCallContext({ caller: party, principal: party });
}

/**
 * Declare a real resolver contribution for boot to activate.
 * @param resolver - Credential contribution of the fixture extension.
 * @returns The manifest discovered during boot.
 */
function resolverExtension(resolver: CredentialResolverContribution): KernelMakaioExtension {
  return { name: owner, displayName: 'Credentials', version: '1.0.0', credentialResolver: resolver };
}

/**
 * Open a loopback model server with cleanup on either test outcome.
 * @param handler - HTTP upstream implementation.
 * @returns The upstream URL and server close operation.
 */
async function openUpstream(handler: RequestListener) {
  const server = createServer(handler);
  const port = await listenOnLoopback(server);
  return { url: new URL(`http://127.0.0.1:${port}/turn`), close: () => closeHttpServer(server) };
}

describe('run-scoped credential mediation', () => {
  let workspace: string;
  let activate: Awaited<Awaited<ReturnType<typeof bootJournalHost>>['boot']>;
  let lifetime: AbortController;
  let secret: ReturnType<typeof createSecret>;
  let resolverCalls: number;
  let beforeResolve: (() => Promise<void>) | undefined;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'run-credential-port-'));
    lifetime = new AbortController();
    secret = createSecret(`fixture-authorization-${crypto.randomUUID()}`);
    resolverCalls = 0;
    beforeResolve = undefined;
  });

  /**
   * Start the real Node host with its journal and one resolver.
   * @param second - Additional resolver extension, when testing activation conflicts.
   */
  async function start(second?: KernelMakaioExtension): Promise<void> {
    const first = resolverExtension({
      /**
       * @param _call - Run call.
       * @param request - Frozen credential request.
       * @returns Synthetic credential for the fixture.
       */
      async resolve(_call, request) {
        resolverCalls += 1;
        if (!Object.isFrozen(request) || request.requester !== owner) {
          return { success: false, error: { code: 'refused', message: 'Refused' } };
        }
        await beforeResolve?.();
        return { success: true, value: secret };
      },
    });
    const { boot } = await bootJournalHost(second ? [first, second] : [first], undefined, undefined, {
      writeJournal: { authorizeWrite: async () => false, deadline: () => Date.now() },
    });
    activate = await boot;
  }

  afterEach(async () => {
    lifetime.abort();
    await rm(workspace, { recursive: true, force: true });
  });

  const call = runCall('booked-run');
  const scope = Object.freeze({
    purpose: 'review.generate',
    target: 'https://example.invalid/turn',
    baseEquipment: 'model',
  } as const);

  /**
   * Bind the fixture's authenticated run.
   * @param scopes - Exact scope pairs decoded by the fixture's booking owner.
   * @returns The worker port for that booking.
   */
  function bind(scopes: readonly RunCredentialScope[] = [scope]) {
    return activate.coordinator.credentials.bindRun({ call, requester: owner, scopes, signal: lifetime.signal });
  }

  /**
   * Run the actual step child against the booked local upstream.
   * @param url - Upstream issued for the fixture.
   * @returns The step result with boolean observations only.
   */
  async function runModelStep(url: URL) {
    const { launcher } = createLocalLauncher({
      workspaceRoot: workspace,
      stepHomeRoot: join(workspace, 'steps'),
      runtimeHomeRoot: join(workspace, 'runtime'),
    });
    try {
      const entry = join(workspace, 'step.mjs');
      await writeFile(entry, stepSource);
      const command = { command: process.execPath, args: [entry] };
      const runner = createProcessStepRunner({
        launcher,
        workspace,
        call,
        agentCommand: command,
        codeCommand: command,
        timeoutMs: 10_000,
        resolveRole: async () => ({ adapterName: 'text-model', model: 'booked-model' }),
        runModel: {
          adapterName: 'text-model',
          ownerInstanceId: owner,
          target: { name: 'model', url },
          credentialSource: bind([{ ...scope, target: url.href }]),
        },
      });
      return await runner.run(step, new AbortController().signal);
    } finally {
      await launcher.closeAll();
    }
  }

  it.each([
    'approved',
    'reflected',
    'base64',
    'base64url',
  ] as const)('mediates a real step and keeps the credential out of its %s reply', async (mode) => {
    await start();
    let upstreamCalls = 0;
    let authorized = false;
    const upstream = await openUpstream((request, response) => {
      upstreamCalls += 1;
      authorized = request.headers.authorization === `Bearer ${secret.reveal()}`;
      request.resume();
      const reflected =
        mode === 'reflected'
          ? secret.reveal()
          : Buffer.from(secret.reveal(), 'utf8').toString(mode === 'base64url' ? mode : 'base64');
      response.writeHead(authorized ? 200 : 401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ text: mode === 'approved' ? '{"approved":true}' : reflected }));
    });
    try {
      await expect(runModelStep(upstream.url)).resolves.toMatchObject({
        status: 'completed',
        output: {
          approved: mode === 'approved',
          invalidReply: mode !== 'approved',
          credentialRpcRefused: true,
          noCredential: true,
          dataOnly: true,
        },
      });
      expect(upstreamCalls).toBe(1);
      expect(authorized).toBe(true);
    } finally {
      await upstream.close();
    }
  });

  it.each([
    { bytes: 15, value: 'fixture-auth-15', accepted: false },
    { bytes: 16, value: 'fixture-auth-016', accepted: true },
  ])('enforces the $bytes-byte authorization boundary for a booked run', async ({ value, accepted }) => {
    secret = createSecret(value);
    await start();
    const authorizations: (string | undefined)[] = [];
    const upstream = await openUpstream((request, response) => {
      authorizations.push(request.headers.authorization);
      request.resume();
      response.end(JSON.stringify({ text: '{"approved":true}' }));
    });
    try {
      await expect(runModelStep(upstream.url)).resolves.toMatchObject({
        status: 'completed',
        output: { approved: accepted, revoked: !accepted },
      });
      expect(authorizations).toEqual(accepted ? [`Bearer ${value}`] : []);
    } finally {
      await upstream.close();
    }
  });

  it('rejects the first credential when the second upstream attempt reflects it', async () => {
    await start();
    const initial = secret.reveal();
    const refreshed = 'fixture-authorization-refreshed';
    const seen: (string | undefined)[] = [];
    const upstream = await openUpstream((request, response) => {
      request.resume();
      seen.push(request.headers.authorization);
      if (seen.length === 1) {
        secret = createSecret(refreshed);
        response.writeHead(401).end(initial);
      } else {
        response.end(JSON.stringify({ text: initial }));
      }
    });
    try {
      await expect(runModelStep(upstream.url)).resolves.toMatchObject({
        status: 'completed',
        output: { invalidReply: true, noCredential: true },
      });
      expect(seen).toEqual([`Bearer ${initial}`, `Bearer ${refreshed}`]);
    } finally {
      await upstream.close();
    }
  });

  it.each(['deactivation', 'revocation'] as const)('aborts a started upstream on %s', async (reason) => {
    await start();
    const entered = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const upstream = await openUpstream((request, response) => {
      request.resume();
      response.once('close', () => closed.resolve());
      entered.resolve();
      void release.promise.then(() => response.end(JSON.stringify({ text: '{"approved":true}' })));
    });
    const running = runModelStep(upstream.url);
    try {
      await Promise.race([
        entered.promise,
        running.then(() => {
          throw new Error('Step finished before upstream started');
        }),
      ]);
      if (reason === 'deactivation') {
        await expect(activate.coordinator.applyExtensionTransition(owner, false)).resolves.toBe('applied');
      } else {
        lifetime.abort();
      }
      await closed.promise;
      await expect(running).resolves.toMatchObject({
        status: 'completed',
        output: { approved: false, revoked: true, noCredential: true },
      });
    } finally {
      release.resolve();
      await upstream.close();
      await running;
    }
  });

  it('checks the run again after the upstream operation and before writing the reply', async () => {
    await start();
    const upstream = await openUpstream((request, response) => {
      request.resume();
      response.end(JSON.stringify({ text: 'upstream output' }));
    });
    const model = createHttpWorkerModelPort('booked-model', { name: 'model', url: upstream.url });
    const credentials: RunCredentialPort = bind([{ ...scope, target: upstream.url.href }]);
    const lease = await openLocalModelAddress({
      call,
      credentialSource: credentials,
      model: {
        ...model,
        complete: async (invocation) => {
          const result = await model.complete(invocation);
          expect(result.kind).toBe('completed');
          lifetime.abort();
          return result;
        },
      },
      target: 'model',
      signal: new AbortController().signal,
      requestTimeoutMs: 10_000,
    });
    try {
      const response = await fetch(lease.address, {
        method: 'POST',
        body: JSON.stringify({ model: 'booked-model', prompt: 'Review' }),
      });
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({ code: 'environmentMissing' });
    } finally {
      await lease.close();
      await upstream.close();
    }
  });

  it.each([false, true])('rejects a duplicate resolver (critical: %s)', async (critical) => {
    const second: KernelMakaioExtension = {
      ...resolverExtension({ resolve: async () => ({ success: true, value: secret }) }),
      name: 'second-resolver',
      critical,
      dependencies: [{ type: 'extension', name: owner, version: '*' }],
    };
    if (critical) {
      const errorLog = vi.spyOn(console, 'error');
      try {
        await expect(start(second)).rejects.toBeInstanceOf(DuplicateCredentialResolverError);
        expect(errorLog.mock.calls.filter(([message]) => String(message).startsWith('[boot] Startup failed'))).toEqual([
          ['[boot] Startup failed (%s) — rolling back started resources', 'DuplicateCredentialResolverError'],
        ]);
      } finally {
        errorLog.mockRestore();
      }
    } else {
      await start(second);
      await expect(activate.coordinator.applyExtensionTransition(second.name, true)).resolves.toBe('rejected');
      await expect(bind().withCredential(call, scope, lifetime.signal, async () => true)).resolves.toEqual(acquired);
      expect(resolverCalls).toBe(1);
    }
  });

  it('refuses an unbooked upstream even when the model target name matches', async () => {
    await start();
    const source = bind();
    const model = createHttpWorkerModelPort('booked-model', {
      name: 'model',
      url: new URL('https://example.invalid/another-turn'),
    });
    await expect(
      model.complete({
        call,
        credentialSource: source,
        request: { model: 'booked-model', prompt: 'Review' },
        target: 'model',
        signal: lifetime.signal,
      }),
    ).resolves.toEqual({ kind: 'failed', code: 'environmentMissing' });
    expect(resolverCalls).toBe(0);
  });

  it('binds a local Git read to the booked repository without passing a credential to Git', async () => {
    await start();
    await git('git', ['init', '--quiet', '--bare', workspace]);
    const repository = { purpose: 'git.read', target: pathToFileURL(workspace).href };
    const result = await bind([repository]).withCredential(call, repository, lifetime.signal, async () => {
      const { stdout } = await git('git', ['-C', workspace, 'symbolic-ref', 'HEAD'], {
        env: { PATH: process.env.PATH },
      });
      return stdout.startsWith('refs/heads/');
    });
    expect(result).toEqual(acquired);
    expect(resolverCalls).toBe(1);
  });

  it.each([
    ['wrong purpose', call, { ...scope, purpose: 'git.read' }],
    ['wrong target', call, { ...scope, target: 'https://example.invalid/another-turn' }],
    ['foreign run', runCall('foreign-run'), scope],
    ['different call for the same run', runCall('booked-run'), scope],
  ] as const)('refuses %s without resolving or using a credential', async (_label, requestCall, requestScope) => {
    await start();
    let effects = 0;
    const result = await bind().withCredential(requestCall, requestScope, lifetime.signal, async () => {
      effects += 1;
      return true;
    });
    expect(result).toEqual(refused);
    expect(resolverCalls).toBe(0);
    expect(effects).toBe(0);
  });

  it.each(['completion', 'cancellation', 'revocation'])('refuses a request after run %s', async () => {
    await start();
    const port = bind();
    lifetime.abort();
    let effects = 0;
    const result = await port.withCredential(call, scope, new AbortController().signal, async () => {
      effects += 1;
      return true;
    });
    expect(result).toEqual(refused);
    expect(resolverCalls).toBe(0);
    expect(effects).toBe(0);
  });

  it('drops a pending grant even if the same resolver has been reactivated', async () => {
    await start();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    beforeResolve = () => {
      entered.resolve();
      return release.promise;
    };
    const port = bind();
    let effects = 0;
    const pending = port.withCredential(call, scope, lifetime.signal, async () => {
      effects += 1;
      return true;
    });
    await entered.promise;
    try {
      await activate.coordinator.applyExtensionTransition(owner, false);
      await expect(pending).resolves.toEqual(refused);
      await activate.coordinator.applyExtensionTransition(owner, true);
    } finally {
      release.resolve();
    }
    expect(effects).toBe(0);
    await expect(port.withCredential(call, scope, lifetime.signal, async () => true)).resolves.toEqual(refused);
    await expect(bind().withCredential(call, scope, lifetime.signal, async () => true)).resolves.toEqual(acquired);
  });

  it('keeps the booked scopes and request snapshot immutable', async () => {
    await start();
    const booked: { purpose: string; target: string } = { ...scope };
    const port = bind([booked]);
    booked.target = 'https://example.invalid/new-target';
    await expect(port.withCredential(call, booked, lifetime.signal, async () => true)).resolves.toEqual(refused);
    await expect(port.withCredential(call, scope, lifetime.signal, async () => true)).resolves.toEqual(acquired);
    expect(resolverCalls).toBe(1);
  });
});
