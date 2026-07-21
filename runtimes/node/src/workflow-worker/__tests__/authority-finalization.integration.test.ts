import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { HmacAuth, WebSocketClientTransport } from '@makaio/bus-transport-websocket';
import {
  createWorkflowFinalizerNamespace,
  createWorkflowDelegateResultFinalizerNamespace,
  FrameworkContractNamespaces,
  FrameworkStorageNamespaces,
  WorkflowSubjects,
  AgentSubjects,
  AdapterSubjects,
  WorkerNodeSubjects,
  SubagentSubjects,
  createClientDefinition,
} from '@makaio/contracts';
import type { WorkflowDelegateAgentNode } from '@makaio/contracts';
import { readOnlyFilesystemToolset } from '@makaio/extension-filesystem';
import { buildDeterministicAdapterId } from '@makaio/services-core/adapter-runtime';
import { AdapterSubsystemSubjects } from '@makaio/services-core/adapter-subsystem';
import { ClientStorageSubjects, ProviderStorageSubjects } from '@makaio/services-core/settings/storage';
import { WorkflowExecutor } from '@makaio/subsystem-workflow-engine';
import { runWorkflowOrchestrator } from '@makaio/subsystem-workflow-engine/workflow-orchestrator';
import { WorkflowStorageSubjects } from '../../../../../subsystems/workflow-engine/src/storage/namespace.js';
import {
  setupWorkflowExecutorWithSubagentServiceTest,
  teardownWorkflowExecutorWithSubagentServiceTest,
} from '../../../../../subsystems/workflow-engine/src/__tests__/workflow-executor.test-setup.js';
import { createWorkflowDefinition } from '../../../../../subsystems/workflow-engine/src/__tests__/shared.js';
import { BusServerTransportProvider } from '../../bus-server-transport.js';
import { closeHttpServer, listenOnLoopback } from '../../__tests__/http-test-helpers.js';
import { createIsolatedWorkflowRuntime } from '../isolated-workflow-runtime.js';
import { WorkerNodeRunner } from '../worker-node-runner.js';
import {
  createDeterministicAdapterContribution,
  type DeterministicAdapterCapture,
} from './deterministic-adapter-fixture.js';

describe('authority WorkerNode finalization integration', () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    await Promise.allSettled(
      cleanups
        .splice(0)
        .reverse()
        .map((cleanup) => cleanup()),
    );
  });

  it('keeps the worker result authority-owned through explicit finalizer acknowledgement', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'makaio-authority-finalization-'));
    cleanups.push(() => rm(cwd, { recursive: true, force: true }));
    await writeFile(join(cwd, 'input.txt'), 'authority governed read');
    const setup = await setupWorkflowExecutorWithSubagentServiceTest({ registerAdapterHandler: false });
    cleanups.push(() => teardownWorkflowExecutorWithSubagentServiceTest(setup));
    await setup.workflowExecutor.destroy();
    MakaioBus.registerNamespaces(FrameworkContractNamespaces);
    MakaioBus.registerNamespaces(FrameworkStorageNamespaces);
    const server = createServer();
    cleanups.push(() => closeHttpServer(server));
    const port = await listenOnLoopback(server);
    const transportSecret = 'authority-finalization-integration-secret';
    const transport = new BusServerTransportProvider({
      httpServer: server,
      auth: new HmacAuth({
        secret: transportSecret,
        resolveSecret: () => transportSecret,
        resolvePeer: (executionId) => ({
          kind: 'workflow-execution',
          id: executionId,
          authenticated: true,
        }),
      }),
    });
    cleanups.push(() => transport.disconnect());
    await transport.connect(MakaioBus, 'authority-finalization');
    const usageEvents: unknown[] = [];
    const readyEvents: unknown[] = [];
    const adapterCapture: DeterministicAdapterCapture = { starts: [], completionTasks: [] };
    let authoritySnapshotClaims = 0;
    let authorityAgentStarts = 0;
    let authorityProviderReads = 0;
    let authorityClientReads = 0;
    let authoritySubagentSpawns = 0;
    cleanups.push(
      MakaioBus.on(
        AdapterSubsystemSubjects.resolveAdapterRuntimeSnapshot,
        (ctx) => {
          authoritySnapshotClaims += 1;
          ctx.setResult({ status: 'error', code: 'adapter-not-loaded' });
        },
        { priority: 1 },
      ),
      MakaioBus.on(
        AdapterSubjects.startAgent,
        () => {
          authorityAgentStarts += 1;
          throw new Error('Authority must not own isolated-runtime adapter execution');
        },
        {
          filter: { adapterId: buildDeterministicAdapterId('authority-worker', 'workflow-test-adapter') },
        },
      ),
      MakaioBus.on(ProviderStorageSubjects.get, (ctx) => {
        authorityProviderReads += 1;
        ctx.setResult({ provider: null });
      }),
      MakaioBus.on(ClientStorageSubjects.get, (ctx) => {
        authorityClientReads += 1;
        ctx.setResult({ client: null });
      }),
      MakaioBus.on(
        SubagentSubjects.spawn,
        () => {
          authoritySubagentSpawns += 1;
          throw new Error('Authority must not own isolated-runtime subagent spawn');
        },
        { priority: 1 },
      ),
    );
    cleanups.push(
      MakaioBus.on(AgentSubjects.usage, (ctx) => {
        usageEvents.push(ctx.payload);
      }),
    );
    cleanups.push(
      MakaioBus.on(WorkerNodeSubjects.control.ready, (ctx) => {
        readyEvents.push(ctx.payload);
      }),
    );
    const runner = new WorkerNodeRunner({
      manifest: { packages: [] },
      dispatch: async (request, signal) => {
        const runtime = await createIsolatedWorkflowRuntime({
          connectAuthority: async (bus) => {
            bus.registerTransport(
              new WebSocketClientTransport({
                url: `ws://127.0.0.1:${port}/bus`,
                autoReconnect: false,
                auth: new HmacAuth({ secret: transportSecret, identityId: request.config.executionId }),
              }),
            );
            await bus.connect();
          },
          contributedPackages: [
            {
              name: 'deterministic-client-contribution',
              displayName: 'Deterministic Client Contribution',
              version: '1.0.0',
              clients: [
                createClientDefinition({
                  id: 'deterministic-client',
                  name: 'Deterministic Client',
                  version: '1.0.0',
                  nativeTools: [],
                  defaultApprovalPolicy: 'always-ask',
                  authMethods: [{ id: 'native', mode: 'inferred', label: 'Native account' }],
                }),
              ],
              create: () => ({}),
            },
            createDeterministicAdapterContribution(adapterCapture),
          ],
          configRepository: {
            loadAdapterConfigs: async () => ({
              configs: new Map([
                [
                  'workflow-test-adapter',
                  {
                    $schema: 'makaio/adapter-config/v1' as const,
                    enabled: true,
                    bindings: [{ providerConfigId: 'deterministic-provider-config', isDefault: true }],
                  },
                ],
              ]),
            }),
            loadProviderConfigs: async () => ({
              configs: new Map([
                [
                  'deterministic-provider-config',
                  {
                    $schema: 'makaio/provider-config/v2' as const,
                    definitionId: 'deterministic-provider',
                    auth: {
                      mode: 'none' as const,
                      method: {
                        owner: 'provider' as const,
                        providerDefinitionId: 'deterministic-provider',
                        methodId: 'none',
                      },
                    },
                    enabled: true,
                    isDefault: true,
                  },
                ],
              ]),
            }),
            writeProviderConfig: async () => {
              throw new Error('read only');
            },
            deleteProviderConfig: async () => false,
            writeAdapterFile: async () => {
              throw new Error('read only');
            },
            deleteAdapterFile: async () => false,
          },
          context: {
            cwd,
            platform: process.platform,
            homedir: tmpdir(),
            makaioHome: cwd,
            username: 'worker',
            machineId: 'authority-worker',
          },
          toolsets: [readOnlyFilesystemToolset],
        });
        try {
          if (adapterCapture.adapterId === undefined) throw new Error('Adapter contribution did not initialize');
          const startsBeforeProbe = adapterCapture.starts.length;
          const authorityStartsBeforeProbe = authorityAgentStarts;
          await runtime.bus.request(AdapterSubjects.startAgent, {
            adapterId: adapterCapture.adapterId,
            initialMessage: 'Verify isolated adapter execution locality',
            role: 'lead',
            ephemeral: true,
            cwd,
            allowedTools: ['read_file'],
            allowedDirectories: [cwd],
          });
          expect(adapterCapture.starts).toHaveLength(startsBeforeProbe + 1);
          expect(authorityAgentStarts).toBe(authorityStartsBeforeProbe);
          await expect(
            runtime.bus.request(ClientStorageSubjects.get, { id: 'deterministic-client' }),
          ).resolves.toMatchObject({
            client: {
              id: 'deterministic-client',
              authMethods: [{ id: 'native', mode: 'inferred' }],
            },
          });
          await runtime.bus.emit(WorkerNodeSubjects.control.ready, {
            nodeId: runtime.machineId,
            executionId: request.config.executionId,
            adapters: [adapterCapture.adapterId],
          });
          const result = await runWorkflowOrchestrator({
            config: request.config,
            loaded: { definition: request.config.definition!, runtimeHandlers: new Map() },
            bus: runtime.bus,
            signal,
          });
          await Promise.all(adapterCapture.completionTasks);
          return result;
        } finally {
          await runtime.shutdown();
        }
      },
    });
    const executor = new WorkflowExecutor(
      MakaioBus,
      {
        stepCooldownMs: 0,
        stepTimeoutMs: 10_000,
        busUrl: `ws://127.0.0.1:${port}/bus`,
        platformDefaults: { cwd },
      },
      runner,
    );
    cleanups.push(() => executor.destroy());
    const finalizerId = 'test.authority-finalizer';
    const { namespace, subjects } = createWorkflowFinalizerNamespace(finalizerId);
    MakaioBus.registerNamespace(namespace);
    cleanups.push(
      MakaioBus.on(subjects.finalize, async (ctx) => {
        const before = await MakaioBus.request(WorkflowStorageSubjects.getExecution, {
          executionId: ctx.payload.executionId,
        });
        expect(before.execution?.status).toBe('finalizing');
        await MakaioBus.request(WorkflowStorageSubjects.acknowledgeFinalization, {
          executionId: ctx.payload.executionId,
          claimToken: ctx.payload.claimToken,
          settledAt: Date.now(),
        });
        ctx.setResult({ accepted: true });
      }),
    );
    await executor.init();
    await executor.registerSuccessFinalizer(finalizerId);
    const delegateFinalizer = createWorkflowDelegateResultFinalizerNamespace('test.artifact-read-wrap');
    MakaioBus.registerNamespace(delegateFinalizer.namespace);
    const finalizedDelegateResults: unknown[] = [];
    cleanups.push(
      MakaioBus.on(delegateFinalizer.subjects.finalize, (ctx) => {
        finalizedDelegateResults.push(ctx.payload);
        ctx.setResult({ output: { rawResult: ctx.payload.rawResult, provenance: 'authority' } });
      }),
    );
    const offAgent = MakaioBus.on(WorkflowSubjects.resolveAgent, (ctx) =>
      ctx.setResult({
        adapterName: 'workflow-test-adapter',
        providerConfigId: 'deterministic-provider-config',
        model: 'deterministic-model',
        providerContext: {
          state: 'resolved',
          providerConfigId: 'deterministic-provider-config',
          definitionId: 'deterministic-provider',
          auth: {
            mode: 'none',
            method: {
              owner: 'provider',
              providerDefinitionId: 'deterministic-provider',
              methodId: 'none',
            },
            definition: { id: 'none', mode: 'none', label: 'No authentication' },
          },
        },
        tools: ['read_file'],
        allowedDirectories: [cwd],
      }),
    );
    cleanups.push(offAgent);
    const agentStation: WorkflowDelegateAgentNode = {
      id: 'read',
      type: 'delegate-agent',
      agentId: 'repository-reader',
      inputExpression: '"Read input.txt"',
      completion: 'turn',
      allowedTools: ['read_file'],
      resultFinalizerId: 'test.artifact-read-wrap',
    };
    const workflow = {
      ...createWorkflowDefinition({
        id: 'authority-role',
        name: 'Authority role',
        root: {
          id: 'root',
          type: 'sequence',
          nodes: [agentStation],
        },
      }),
      successFinalizerId: finalizerId,
    };
    await MakaioBus.request(WorkflowSubjects.setDefinition, { workflow });
    const completed = new Promise<string>((resolve, reject) => {
      cleanups.push(
        MakaioBus.on(WorkflowSubjects.execution.completed, (ctx) => resolve(ctx.payload.executionId)),
        MakaioBus.on(WorkflowSubjects.execution.failed, (ctx) => reject(new Error(ctx.payload.error))),
      );
    });
    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, { workflowId: workflow.id });
    await expect(completed).resolves.toBe(executionId);
    await expect(MakaioBus.request(WorkflowSubjects.getExecution, { executionId })).resolves.toEqual(
      expect.objectContaining({ execution: expect.objectContaining({ status: 'completed' }) }),
    );
    expect(usageEvents).toContainEqual(
      expect.objectContaining({ adapterName: 'workflow-test-adapter', totalTokens: 2, costUnits: 2 }),
    );
    expect(readyEvents).toContainEqual({
      nodeId: 'authority-worker',
      executionId,
      adapters: [adapterCapture.adapterId],
    });
    expect(adapterCapture.starts).toContainEqual({
      cwd,
      allowedTools: ['read_file'],
      allowedDirectories: [cwd],
    });
    expect(finalizedDelegateResults).toContainEqual({
      executionId,
      workflowId: workflow.id,
      frameId: expect.any(String),
      nodeId: 'read',
      nodeType: 'delegate-agent',
      rawResult: expect.any(String),
      toolObservations: [],
      economics: {
        durationMs: expect.any(Number),
        toolCallCount: 0,
        binding: {
          adapterName: 'workflow-test-adapter',
          providerConfigId: 'deterministic-provider-config',
          providerDefinitionId: 'deterministic-provider',
          model: 'deterministic-model',
          auth: { mode: 'none', owner: 'provider', methodId: 'none' },
        },
      },
    });
    expect(finalizedDelegateResults).toHaveLength(1);
    expect(adapterCapture.readResult).toMatchObject({
      success: true,
      data: { content: 'authority governed read' },
    });
    expect(adapterCapture.providerContext).toEqual(
      expect.objectContaining({
        state: 'resolved',
        providerConfigId: 'deterministic-provider-config',
        definitionId: 'deterministic-provider',
        auth: expect.objectContaining({ mode: 'none' }),
      }),
    );
    expect(adapterCapture.adapterInitCount).toBe(1);
    expect(authoritySnapshotClaims).toBe(0);
    expect(authorityAgentStarts).toBe(0);
    expect(authorityProviderReads).toBe(0);
    expect(authorityClientReads).toBe(0);
    expect(authoritySubagentSpawns).toBe(0);
    expect(adapterCapture.extensionDestroyed).toBe(true);
    expect(adapterCapture.connectorClosed).toBe(true);
  }, 20_000);
});
