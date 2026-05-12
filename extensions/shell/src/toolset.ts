import { MakaioBus, type IMakaioBus } from '@makaio/bus-core';
import { defineToolset, widenTool } from '@makaio/tools-core';
import { ShellManager } from './manager/shell-manager.js';
import { ShellConstraintsSchema } from './schemas.js';
import { ShellService } from './shell-service.js';
import {
  shellExecTool,
  shellStatusTool,
  shellOutputTool,
  shellGrepTool,
  shellSendTool,
  shellKillTool,
} from './tools/index.js';

export const shellToolset = defineToolset({
  name: 'shell',
  description: 'Cross-platform shell execution tools for AI agents',
  version: '0.1.0',
  tools: [
    widenTool(shellExecTool),
    widenTool(shellStatusTool),
    widenTool(shellOutputTool),
    widenTool(shellGrepTool),
    widenTool(shellSendTool),
    widenTool(shellKillTool),
  ],
  configSchema: ShellConstraintsSchema,
});

export interface CreateShellToolsetOptions {
  /** Existing ShellManager instance, used by direct tests. */
  manager?: ShellManager;
  /** Bus used by the shell service test harness. */
  bus?: IMakaioBus;
}

/**
 * Create a shell toolset harness for direct test registration.
 *
 * Extension activation owns lifecycle in production. Direct tests that bypass
 * activation can initialize the returned service to register shell bus handlers.
 * @param options - Optional shell manager and bus for test isolation.
 * @returns Shell toolset, manager, and service.
 */
export function createShellToolset(options: CreateShellToolsetOptions = {}) {
  const manager = options.manager ?? new ShellManager();
  const service = new ShellService(options.bus ?? MakaioBus, manager);
  return { toolset: shellToolset, manager, service };
}
