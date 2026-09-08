/** Consumer modules: every framework import resolves from the installed tarball. */
export const HEADLESS_GIT_CONSUMER = String.raw`
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createBusInstance } from '@makaio/framework/bus';
import {
  ExecutionAttemptSubjects,
  FrameworkContractNamespaces,
  FrameworkStorageNamespaces,
  WorkerSubjects,
} from '@makaio/framework/contracts';
import { HmacAuth, WebSocketClientTransport } from '@makaio/framework/node/transports';
import { BusServerTransportProvider } from '@makaio/framework/runtime-node';
import {
  createLocalGitWorkspacePreparation,
  runHeadlessWorkflowWorker,
} from '@makaio/framework/runtime-node/workflow-worker';
import { registerMemorySessionStorage } from '@makaio/framework/services/session';
import {
  ExecutionAttemptAuthority,
  buildWorkflowAttemptInstruction,
  decodeWorkflowAttemptOutcome,
  registerBootstrapStartHandler,
  registerExecutionAttemptHandlers,
  registerOperationAdmissionHandler,
  registerRuntimeRegistrationHandler,
  workflowAttemptOutcomeCodec,
} from '@makaio/framework/workflow-engine';
import { createInMemoryAttemptRepository, driveTestAttemptToAllocated } from '@makaio/framework/workflow-engine/testing';

const secret = 'installed-headless-git-secret';
const executionId = 'installed-headless-git';
const root = await mkdtemp(join(tmpdir(), 'installed-headless-git-'));
const repository = join(root, 'repository');
const executableRoot = join(root, 'executable');
const workspaceRoot = join(root, 'workspace');
const operations = [];

function git(...args) {
  return execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd: repository, encoding: 'utf8' },
  ).trim();
}

function createConfigRepository() {
  return {
    async loadAdapterConfigs() { return { configs: new Map() }; },
    async loadProviderConfigs() { return { configs: new Map() }; },
    async writeProviderConfig() { throw new Error('read only'); },
    async deleteProviderConfig() { throw new Error('read only'); },
    async writeAdapterFile() { throw new Error('read only'); },
    async deleteAdapterFile() { throw new Error('read only'); },
  };
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address !== null && typeof address !== 'string');
  return address.port;
}

try {
  await Promise.all([mkdir(repository), mkdir(executableRoot)]);
  git('init', '--quiet');
  await writeFile(join(repository, 'content.txt'), 'selected revision');
  git('add', '.');
  git('commit', '--quiet', '-m', 'first');
  const revision = git('rev-parse', 'HEAD');
  await writeFile(join(repository, 'content.txt'), 'later revision');
  git('add', '.');
  git('commit', '--quiet', '-m', 'second');
  await writeFile(join(executableRoot, 'workflow.ts'), 'export const executable = true;\n');

  const runContext = {
    executionId,
    workflowId: 'installed-workflow',
    source: { kind: 'definition', workflowId: 'installed-workflow' },
    definitionSnapshot: {
      id: 'installed-workflow', name: 'Installed Workflow', root: { id: 'root', type: 'sequence', nodes: [] }, scope: { type: 'global' },
    },
    workerManifest: { contributionRefs: [] },
    inputs: {},
    scope: { type: 'global' },
    triggerPayload: {},
    coordinatorSessionId: 'installed-session',
    cancelSubject: 'workflow.installed-headless-git.cancel',
    env: {},
    createdAt: 0,
    suspensionStrategy: 'wait-in-process',
  };
  const workspace = {
    provisioning: 'create',
    custody: 'disposable',
    sourceRoots: [{ id: 'primary', path: 'source', source: { kind: 'git', input: { repositoryId: 'project', revision } } }],
    setup: [{
      command: process.execPath,
      args: ['-e', "require('fs').writeFileSync('ready.txt',require('fs').readFileSync('source/content.txt','utf8')+' prepared')"],
      env: {},
      timeoutMs: 5_000,
    }],
  };
  const instruction = buildWorkflowAttemptInstruction({
    id: 'installed-instruction',
    revision: '1',
    config: { ...runContext, definition: runContext.definitionSnapshot },
    runContext,
    workspace,
    preservation: { required: [] },
  });

  const authorityBus = createBusInstance();
  authorityBus.registerNamespaces([...FrameworkContractNamespaces, ...FrameworkStorageNamespaces]);
  const offStorage = registerMemorySessionStorage(authorityBus);
  const authority = new ExecutionAttemptAuthority(createInMemoryAttemptRepository(workflowAttemptOutcomeCodec), { bootstrapTimeoutMs: 30_000 });
  const created = await authority.createAttempt(executionId, instruction);
  assert(created.bootstrapDeadlineAt !== null);
  void authority.waitForOutcome(created.executionAttemptId)?.catch(() => undefined);
  await driveTestAttemptToAllocated(authority, created.executionAttemptId, executionId);
  const offIngress = registerExecutionAttemptHandlers(authorityBus, {
    authority,
    decodeOutcome: async (input) => decodeWorkflowAttemptOutcome(input),
    convergence: { async converge() {} },
  });
  const offRegister = registerRuntimeRegistrationHandler(authorityBus, { bus: authorityBus, authority });
  const offBootstrap = registerBootstrapStartHandler(authorityBus, authority);
  const offAdmit = registerOperationAdmissionHandler(authorityBus, { bus: authorityBus, authority });
  const offOperations = authorityBus.on(ExecutionAttemptSubjects.operation.admitted, (ctx) => operations.push(ctx.payload.operationKind));
  const offInputs = authorityBus.on(WorkerSubjects.runtime.inputs.get, (ctx) => {
    ctx.setResult({ runtimeInputs: { workerManifest: runContext.workerManifest, suspensionStrategy: runContext.suspensionStrategy } });
  }, { filter: { executionAttemptId: created.executionAttemptId } });

  const server = createServer();
  let serverTransport;
  try {
    const port = await listen(server);
    serverTransport = new BusServerTransportProvider({
      httpServer: server,
      auth: new HmacAuth({
        secret,
        resolveSecret: (id) => id === created.executionAttemptId ? secret : null,
        resolvePeer: (id) => id === created.executionAttemptId
          ? { kind: 'workflow-execution-attempt', id, authenticated: true, claims: { executionId } }
          : null,
      }),
    });
    await serverTransport.connect(authorityBus, 'installed-authority');
    const result = await runHeadlessWorkflowWorker({
      executionId,
      executionAttemptId: created.executionAttemptId,
      bootstrapDeadlineAt: created.bootstrapDeadlineAt,
      workflowEnv: {},
      workspaceRoot,
      preparation: createLocalGitWorkspacePreparation({ resolveRepository: async (id) => {
        assert.equal(id, 'project');
        return repository;
      }, timeoutMs: 10_000 }),
      bootstrap: async () => ({ busUrl: 'ws://unused', busAuthSecret: 'unused' }),
      connectBus: async (bus) => {
        const transport = new WebSocketClientTransport({
          url: 'ws://127.0.0.1:' + port + '/bus', autoReconnect: false,
          auth: new HmacAuth({ secret, identityId: created.executionAttemptId }),
        });
        bus.registerTransport(transport);
        await bus.connect();
      },
      materialize: async () => ({ context: {
        workspaceRoot: executableRoot,
        sourcePath: join(executableRoot, 'workflow.ts'),
        contributionEntrypoints: [], platform: 'linux', arch: 'x64',
      } }),
      loadContributions: async () => [],
      execute: async (_bus, context, runtimeContext) => {
        assert.equal(context.executionId, executionId);
        assert.equal(runtimeContext.workspaceRoot, await realpath(workspaceRoot));
        assert.equal(runtimeContext.sourcePath, join(executableRoot, 'workflow.ts'));
        assert.equal(await readFile(join(runtimeContext.workspaceRoot, 'ready.txt'), 'utf8'), 'selected revision prepared');
        assert.equal(await readFile(runtimeContext.sourcePath, 'utf8'), 'export const executable = true;\n');
        return { executionId, workflowId: context.workflowId, status: 'completed' };
      },
      configRepository: createConfigRepository(),
      toolsets: [],
    }, new AbortController().signal);
    assert.equal(result.outcome.kind, 'workload-result');
    assert.equal(result.decision, 'accepted');
    assert.deepEqual(operations, ['workspace-preparation', 'workload-invocation']);
    await writeFile('result.json', JSON.stringify({ operations, decision: result.decision }));
  } finally {
    offInputs(); offOperations(); offAdmit(); offBootstrap(); offRegister(); offIngress(); offStorage();
    try {
      await serverTransport?.disconnect();
    } finally {
      if (server.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
`;

/** Type witnesses compile against installed declarations rather than source aliases. */
export const TYPES_CONSUMER = String.raw`
import {
  createLocalGitWorkspacePreparation,
  type HeadlessWorkflowWorkerDeps,
  type LocalGitSourceOptions,
  type WorkloadInvocationPreparation,
} from '@makaio/framework/runtime-node/workflow-worker';

export const options: LocalGitSourceOptions = {
  timeoutMs: 10_000,
  async resolveRepository(repositoryId, signal) {
    signal?.throwIfAborted();
    return '/repositories/' + repositoryId;
  },
};
export const preparation: WorkloadInvocationPreparation = createLocalGitWorkspacePreparation(options);
declare const base: HeadlessWorkflowWorkerDeps;
export const withPreparation: HeadlessWorkflowWorkerDeps = { ...base, preparation };
`;
