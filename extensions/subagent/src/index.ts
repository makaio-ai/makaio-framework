import type { MakaioNodeExtension } from '@makaio/contracts/extension';
import { createChildSubagentToolset, createParentSubagentToolset } from './toolset.js';
import type { IMakaioBus } from '@makaio/bus-core';

/**
 * Subagent tool extension.
 *
 * This extension contributes stateless RPC tools. Subagent orchestration
 * remains behind `SubagentSubjects` handlers.
 */
export const subagentPackage: MakaioNodeExtension<IMakaioBus> = {
  name: 'subagent',
  displayName: 'Subagent Tools',
  version: '0.1.0',
  surface: 'headless',
  tools: {
    /**
     * Create parent and child subagent toolsets.
     * @returns Subagent toolsets.
     */
    createToolsets: () => [createParentSubagentToolset(), createChildSubagentToolset()],
  },
};

export default subagentPackage;

export { createParentSubagentToolset, createChildSubagentToolset } from './toolset.js';
export { SubagentManager, type TrackOptions } from './manager/index.js';
export type {
  InputResolver,
  InternalPendingRequest,
  TrackedSubagent,
  InputResponse,
  SpawnOptions,
  AwaitResult,
} from './types.js';
