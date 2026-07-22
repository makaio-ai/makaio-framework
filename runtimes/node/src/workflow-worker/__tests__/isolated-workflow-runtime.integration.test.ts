import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createBusInstance } from '@makaio/bus-core';
import { WebSocketClientTransport } from '@makaio/bus-transport-websocket';
import {
  AgentSubjects,
  FrameworkContractNamespaces,
  FrameworkStorageNamespaces,
  SessionSubjects,
  ToolSubjects,
  WorkflowSubjects,
  type IMakaioSession,
} from '@makaio/contracts';
import type { KernelMakaioExtension } from '@makaio/kernel';
import { readOnlyFilesystemToolset } from '@makaio/extension-filesystem';
import { defineTool, defineToolset, toolSuccess } from '@makaio/tools-core';
import { SessionStorageSubjects } from '@makaio/services-core/session/storage/namespace';
import { registerMemorySessionStorage } from '../../../../../services/core/src/session/storage/memory-handler.js';
import { closeHttpServer, listenOnLoopback } from '../../__tests__/http-test-helpers.js';
import { BusServerTransportProvider } from '../../bus-server-transport.js';
import { createIsolatedWorkflowRuntime } from '../isolated-workflow-runtime.js';

/** Build the read-only empty adapter repository required by the runtime seam. */
function createEmptyAdapterRepository() {
  return {
    async loadAdapterConfigs() {
      return { configs: new Map() };
    },
    async loadProviderConfigs() {
      return { configs: new Map() };
    },
    async writeProviderConfig(): Promise<void> {
      throw new Error('read only');
    },
    async deleteProviderConfig(): Promise<boolean> {
      throw new Error('read only');
    },
    async writeAdapterFile(): Promise<void> {
      throw new Error('read only');
    },
    async deleteAdapterFile(): Promise<boolean> {
      throw new Error('read only');
    },
  };
}

describe('createIsolatedWorkflowRuntime integration', () => {
  it('preserves the startup failure after cleanup', async () => {
    const startupFailure = new Error('authority connection rejected');

    await expect(
      createIsolatedWorkflowRuntime({
        connectAuthority: async () => {
          throw startupFailure;
        },
        contributedPackages: [],
        configRepository: createEmptyAdapterRepository(),
        context: {
          cwd: tmpdir(),
          platform: process.platform,
          homedir: '/runtime-home',
          makaioHome: '/runtime-makaio-home',
          username: 'workflow-worker',
          machineId: 'isolated-worker-startup-failure',
        },
        toolsets: [],
      }),
    ).rejects.toBe(startupFailure);
  });

  it('runs a subagent read tool against authority-backed session lifecycle and tears down cleanly', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'makaio-isolated-runtime-'));
    const expected = 'authority-backed isolated runtime';
    await writeFile(join(cwd, 'input.txt'), expected);

    const authority = createBusInstance();
    authority.registerNamespaces(FrameworkContractNamespaces);
    authority.registerNamespaces(FrameworkStorageNamespaces);
    const offStorage = registerMemorySessionStorage(authority);
    const server = createServer();
    const port = await listenOnLoopback(server);
    const serverTransport = new BusServerTransportProvider({ httpServer: server });
    await serverTransport.connect(authority, 'isolated-workflow-authority');

    const usageEvents: unknown[] = [];
    const offUsage = authority.on(AgentSubjects.usage, (ctx) => {
      usageEvents.push(ctx.payload);
    });
    const offResolveRole = authority.on(WorkflowSubjects.resolveRole, (ctx) => {
      expect(ctx.payload).toEqual({ roleId: 'repository-reader' });
      ctx.setResult({
        adapterName: 'test-adapter',
        providerConfigId: 'provider-reader',
        tools: ['read_file'],
        disallowedTools: ['write_file', 'edit_file', 'delete_file'],
        allowedDirectories: [cwd],
      });
    });
    let clientTransport: WebSocketClientTransport | undefined;
    const disconnectSpy = vi.fn();
    let authorityConnected = false;
    const observedContext: Array<{
      readonly cwd: string;
      readonly makaioHome: string;
      readonly machineId: string;
    }> = [];
    const runtimeBootConfigured = vi.fn();
    const runtimeBootCleanup = vi.fn();
    const processedExtensions: string[] = [];

    const repositoryEchoTool = defineTool({
      name: 'repository_echo',
      description: 'Echo a repository-owned value.',
      inputSchema: z.object({ value: z.string() }),
      outputSchema: z.object({ value: z.string() }),
      execute: async (input) => toolSuccess({ value: input.value }),
    });
    const contributedClient: KernelMakaioExtension = {
      name: 'test-client-contribution',
      displayName: 'Test client contribution',
      version: '1.0.0',
      clients: [],
      tools: {
        createToolsets: () => [
          defineToolset({
            name: 'repository-tools',
            description: 'Repository-owned tools.',
            version: '1.0.0',
            tools: [repositoryEchoTool],
          }),
        ],
      },
      runtimeBoot: {
        configure: ({ registerContributionProcessor }) => {
          runtimeBootConfigured();
          registerContributionProcessor({
            processActivated: async (name) => {
              processedExtensions.push(name);
            },
          });
          return runtimeBootCleanup;
        },
      },
      create: (context) => {
        if (context.cwd === undefined) throw new Error('Isolated runtime did not provide extension cwd');
        observedContext.push({
          cwd: context.cwd,
          makaioHome: context.makaioHome,
          machineId: context.machineId,
        });
        return {};
      },
    };
    const session: IMakaioSession = {
      sessionId: 'subagent-session-1',
      parentSessionId: 'workflow-coordinator-session',
      branchKind: 'subagent',
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      status: 'active',
      isOrchestrated: true,
      isImported: false,
      agents: [
        {
          agentId: 'subagent-1',
          adapterId: 'adapter-1',
          adapterName: 'test-adapter',
          sessionId: 'subagent-session-1',
          role: 'lead',
          status: 'active',
          createdAt: Date.now(),
          lastActivityAt: Date.now(),
        },
      ],
    };

    let runtime: Awaited<ReturnType<typeof createIsolatedWorkflowRuntime>> | undefined;
    try {
      runtime = await createIsolatedWorkflowRuntime({
        connectAuthority: async (bus) => {
          clientTransport = new WebSocketClientTransport({
            url: `ws://127.0.0.1:${port}/bus`,
            autoReconnect: false,
          });
          vi.spyOn(clientTransport, 'disconnect').mockImplementation(async () => {
            disconnectSpy();
            await WebSocketClientTransport.prototype.disconnect.call(clientTransport);
          });
          bus.registerTransport(clientTransport);
          await bus.connect();
          authorityConnected = true;
        },
        loadContributedPackages: async () => {
          expect(authorityConnected).toBe(true);
          return [contributedClient];
        },
        contributedPackages: [],
        configRepository: createEmptyAdapterRepository(),
        context: {
          cwd,
          platform: process.platform,
          homedir: '/runtime-home',
          makaioHome: '/runtime-makaio-home',
          username: 'workflow-worker',
          machineId: 'isolated-worker-1',
        },
        toolsets: [readOnlyFilesystemToolset],
      });
      expect(observedContext).toEqual([{ cwd, makaioHome: '/runtime-makaio-home', machineId: 'isolated-worker-1' }]);
      expect(runtimeBootConfigured).toHaveBeenCalledOnce();
      expect(processedExtensions).toContain('test-client-contribution');
      await authority.request(SessionStorageSubjects.set, { sessionId: session.sessionId, session });

      const visible = await runtime.bus.request(SessionSubjects.get, { sessionId: session.sessionId });
      expect(visible.session).toMatchObject({ branchKind: 'subagent', status: 'active' });

      await expect(runtime.bus.request(WorkflowSubjects.resolveRole, { roleId: 'repository-reader' })).resolves.toEqual(
        {
          adapterName: 'test-adapter',
          providerConfigId: 'provider-reader',
          tools: ['read_file'],
          disallowedTools: ['write_file', 'edit_file', 'delete_file'],
          allowedDirectories: [cwd],
        },
      );

      const listed = await runtime.bus.request(ToolSubjects.list, {
        adapterId: 'adapter-1',
        adapterName: 'test-adapter',
      });
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
        'glob_files',
        'grep_files',
        'list_directory',
        'read_file',
        'repository_echo',
      ]);

      const readResult = await runtime.bus.request(ToolSubjects.execute, {
        toolName: 'read_file',
        input: { path: 'input.txt' },
        adapterId: 'adapter-1',
        adapterName: 'test-adapter',
        contextOverrides: {
          cwd,
          sessionId: session.sessionId,
          agentId: 'subagent-1',
          adapterId: 'adapter-1',
          adapterName: 'test-adapter',
          constraints: { allowedDirectories: [cwd] },
        },
      });
      expect(readResult).toMatchObject({
        success: true,
        data: { content: expected, path: join(cwd, 'input.txt') },
      });

      await runtime.bus.emit(AgentSubjects.usage, {
        agentId: 'subagent-1',
        adapterId: 'adapter-1',
        adapterName: 'test-adapter',
        sessionId: session.sessionId,
        granularity: 'provider-call',
        provider: 'test',
        model: 'test-model',
        inputTokens: 3,
        inputCachedTokens: 0,
        outputTokens: 2,
        reasoningTokens: 0,
        totalTokens: 5,
        costUnits: 5,
        costUnitType: 'tokens',
      });
      await vi.waitFor(() => expect(usageEvents).toHaveLength(1));
      expect(usageEvents).toEqual([
        {
          agentId: 'subagent-1',
          adapterId: 'adapter-1',
          adapterName: 'test-adapter',
          sessionId: session.sessionId,
          granularity: 'provider-call',
          provider: 'test',
          model: 'test-model',
          inputTokens: 3,
          inputCachedTokens: 0,
          outputTokens: 2,
          reasoningTokens: 0,
          totalTokens: 5,
          costUnits: 5,
          costUnitType: 'tokens',
        },
      ]);

      await runtime.bus.request(SessionSubjects.close, { sessionId: session.sessionId });
      const stored = await authority.request(SessionStorageSubjects.get, { sessionId: session.sessionId });
      expect(stored.session?.status).toBe('closed');
    } finally {
      if (runtime !== undefined) {
        await runtime.shutdown();
        await runtime.shutdown();
        expect(disconnectSpy).toHaveBeenCalledOnce();
        expect(runtimeBootCleanup).toHaveBeenCalledOnce();
        await expect(runtime.bus.request(ToolSubjects.list, {})).rejects.toThrow();
        await expect(runtime.bus.request(SessionSubjects.get, { sessionId: session.sessionId })).rejects.toThrow();
      }

      offUsage();
      offResolveRole();
      offStorage();
      await serverTransport.disconnect();
      await closeHttpServer(server);
      await rm(cwd, { recursive: true, force: true });
    }
  }, 15_000);
});
