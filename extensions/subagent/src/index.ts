import type { MakaioExtension } from '@makaio/contracts/extension';
import { createChildSubagentToolset, createParentSubagentToolset } from './toolset.js';

/**
 * Subagent tool extension.
 *
 * This extension contributes stateless RPC tools. Subagent orchestration
 * remains behind `SubagentSubjects` handlers.
 */
export const subagentPackage: MakaioExtension = {
  name: 'subagent',
  displayName: 'Subagent Tools',
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
