import { describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import type { NodeExtensionContext } from '@makaio/contracts/extension';
import subagentPackage from '../server.js';

const testContext: NodeExtensionContext = {
  bus: MakaioBus,
  identity: { extensionName: 'subagent' } as NodeExtensionContext['identity'],
  dataDir: '/tmp/makaio-subagent-test',
  machineId: 'test-machine',
  getService: () => undefined,
  tryImport: async () => null,
  signal: new AbortController().signal,
  hasExtension: () => false,
  platform: process.platform,
  homedir: '/tmp',
  makaioHome: '/tmp/.makaio',
  username: 'test',
};

describe('subagent extension package', () => {
  it('contributes parent and child subagent toolsets', () => {
    const toolsets = subagentPackage.tools?.createToolsets(testContext);

    expect(subagentPackage.name).toBe('subagent');
    expect(toolsets?.map((toolset) => toolset.metadata.name)).toEqual(['subagent-parent', 'subagent-child']);
    const toolNames = toolsets?.flatMap((toolset) => Object.keys(toolset.tools)) ?? [];
    expect(toolNames).toHaveLength(8);
    expect(toolNames).toEqual(
      expect.arrayContaining([
        'spawn_subagent',
        'check_subagent',
        'send_to_subagent',
        'await_subagent',
        'kill_subagent',
        'report_progress',
        'request_input',
        'complete_task',
      ]),
    );
  });
});
