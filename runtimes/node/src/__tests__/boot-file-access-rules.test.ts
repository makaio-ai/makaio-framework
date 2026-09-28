/**
 * Boot wiring of a host-provided file-access rule provider.
 *
 * `bootMakaioRuntimeCore` composes the framework core set through
 * `selectFrameworkCorePackages(..., { fileAccessRuleProvider })`. These tests
 * load exactly that selection's tool registry and tool approval packages into a
 * coordinator together with the real filesystem extension, and drive them over
 * the bus: with a provider, a `.makaioignore`-denied path is rejected by the
 * file tool and denied by the approval service; without one, behaviour is
 * unchanged.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { AgentSubjects, HarnessSubjects, ToolSubjects } from '@makaio/contracts';
import { createMakaioIgnoreProvider, filesystemPackage } from '@makaio/extension-filesystem';
import { ExtensionCoordinator, type KernelMakaioExtension } from '@makaio/kernel';
import {
  AgentStorageSubjects,
  createToolContributionProcessor,
  frameworkCorePackages,
  ToolApprovalToken,
  ToolRegistryToken,
} from '@makaio/services-core';
import type { FileAccessRuleProvider } from '@makaio/tools-core';
import { selectFrameworkCorePackages } from '../boot.js';

const AGENT_ID = 'agent-1';
const SESSION_ID = 'session-1';
const ADAPTER_NAME = 'test-adapter';

let workspace: string;
let coordinator: ExtensionCoordinator | undefined;

/**
 * Pick the tool registry and tool approval packages from the boot core selection.
 * @param fileAccessRuleProvider - Provider handed to the boot selection, if any.
 * @returns The two tool packages in load order.
 */
function selectToolPackages(fileAccessRuleProvider?: FileAccessRuleProvider): KernelMakaioExtension[] {
  const selected = selectFrameworkCorePackages([], { fileAccessRuleProvider });
  const byName = new Map(selected.map((pkg) => [pkg.name, pkg]));
  return [ToolRegistryToken.name, ToolApprovalToken.name].map((name) => {
    const pkg = byName.get(name);
    if (!pkg) throw new Error(`boot selection is missing ${name}`);
    return pkg;
  });
}

/**
 * Start the tool packages plus the real filesystem extension on a fresh bus.
 * @param fileAccessRuleProvider - Provider handed to the boot selection, if any.
 * @returns The bus the packages run on.
 */
async function startToolRuntime(fileAccessRuleProvider?: FileAccessRuleProvider): Promise<IMakaioBus> {
  const bus = createBusInstance();
  coordinator = new ExtensionCoordinator(bus, {
    extensionContextBase: {
      platform: process.platform,
      homedir: workspace,
      makaioHome: path.join(workspace, '.makaio'),
      username: 'test',
      machineId: 'machine-1',
      busUrl: 'ws://127.0.0.1:0/bus',
      tryImport: async () => null,
    },
  });
  coordinator.load([...selectToolPackages(fileAccessRuleProvider), filesystemPackage]);
  coordinator.registerContributionProcessor(createToolContributionProcessor());
  await coordinator.startAll();

  // Approval inputs the service reads from storage and harness resolution.
  bus.on(AgentStorageSubjects.listBySession, (ctx) => {
    ctx.setResult({
      agents: [
        {
          agentId: AGENT_ID,
          adapterId: 'adapter-1',
          adapterName: ADAPTER_NAME,
          sessionId: SESSION_ID,
          adapterSessionId: 'adapter-session-1',
          role: 'lead',
          status: 'active',
          cwd: workspace,
          createdAt: Date.now(),
          lastActivityAt: Date.now(),
        },
      ],
    });
  });
  bus.on(HarnessSubjects.resolve, (ctx) => {
    ctx.setResult({
      id: 'default-harness',
      name: 'default',
      description: 'Default test harness',
      adapterName: ADAPTER_NAME,
      approvalPolicy: 'always-ask',
      nativeTools: { enabled: [], disabled: [] },
      registryTools: { enabled: [], disabled: [] },
      isDefault: true,
      enabled: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
  return bus;
}

/**
 * Execute `read_file` over the bus inside the test workspace.
 * @param bus - Bus the tool registry runs on.
 * @param fileName - File name relative to the workspace.
 * @returns The tool execution result.
 */
async function readFile(bus: IMakaioBus, fileName: string) {
  return await bus.request(ToolSubjects.execute, {
    toolName: 'read_file',
    input: { path: path.join(workspace, fileName) },
    contextOverrides: { cwd: workspace },
  });
}

/**
 * Ask the approval service about a `read_file` call on a workspace file.
 * @param bus - Bus the approval service runs on.
 * @param fileName - File name relative to the workspace.
 * @returns The approval decision.
 */
async function approveRead(bus: IMakaioBus, fileName: string) {
  return await bus.request(AgentSubjects.toolApprove, {
    agentId: AGENT_ID,
    adapterId: 'adapter-1',
    adapterName: ADAPTER_NAME,
    sessionId: SESSION_ID,
    adapterSessionId: 'adapter-session-1',
    toolCallId: 'tool-call-1',
    toolName: 'read_file',
    args: { path: path.join(workspace, fileName) },
  });
}

beforeEach(() => {
  workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'boot-file-access-')));
  fs.writeFileSync(path.join(workspace, '.makaioignore'), 'secret.txt\n');
  fs.writeFileSync(path.join(workspace, 'secret.txt'), 'top secret');
});

afterEach(async () => {
  await coordinator?.shutdown();
  coordinator = undefined;
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('boot fileAccessRuleProvider wiring', () => {
  it('keeps the static core set when no provider is supplied', () => {
    expect(selectFrameworkCorePackages([], {})).toBe(frameworkCorePackages);
  });

  it('rejects file tool calls and approvals on a path the provider denies', async () => {
    const provider = createMakaioIgnoreProvider({ globalIgnorePath: path.join(workspace, 'no-global-ignore') });
    const bus = await startToolRuntime(provider);

    const result = await readFile(bus, 'secret.txt');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('PERMISSION_DENIED');
    }

    const approval = await approveRead(bus, 'secret.txt');
    expect(approval.action).toBe('deny');
    if (approval.action === 'deny') {
      expect(approval.message).toContain('.makaioignore');
    }
  });

  it('leaves file tool calls and approvals unrestricted without a provider', async () => {
    const bus = await startToolRuntime();

    const result = await readFile(bus, 'secret.txt');
    expect(result.success).toBe(true);

    // No approval handler is registered, so the cascade may still deny — but
    // never through the file-access pre-check.
    const approval = await approveRead(bus, 'secret.txt');
    if (approval.action === 'deny') {
      expect(approval.message).not.toContain('.makaioignore');
    }
  });
});
