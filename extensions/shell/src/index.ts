import type { IMakaioBus } from '@makaio/bus-core';
import type { MakaioNodeExtension } from '@makaio/contracts/extension';
import { shellToolset } from './toolset.js';
import { ShellService } from './shell-service.js';
import { ShellNamespace } from './bus/namespace.js';

/**
 * Shell tool extension.
 */
export const shellPackage: MakaioNodeExtension<IMakaioBus> = {
  name: 'shell',
  displayName: 'Shell Tools',
  version: '0.1.0',
  surface: 'headless',
  namespaces: [ShellNamespace],
  tools: {
    /**
     * Create shell toolsets.
     * @returns Shell toolset contribution.
     */
    createToolsets: () => [shellToolset],
  },
  /**
   * Create the shell service that owns subprocess lifecycle.
   * @param ctx - Extension context.
   * @returns Shell service.
   */
  create: (ctx) => new ShellService(ctx.bus),
};

export default shellPackage;

export { shellToolset, createShellToolset, type CreateShellToolsetOptions } from './toolset.js';
export { ShellService } from './shell-service.js';
export { ShellNamespace, ShellSubjects } from './bus/namespace.js';
export { ShellServiceSchemas } from './bus/schemas.js';
export { ShellManager } from './manager/index.js';
export type {
  ShellConstraints,
  ShellStatus,
  StreamType,
  OutputChunk,
  OutputLine,
  ShellExecInput,
  ShellExecOutput,
  ShellStatusInput,
  ShellStatusOutput,
  ShellGrepInput,
  ShellGrepOutput,
  GrepMatch,
  ShellOutputInput,
  ShellOutputOutput,
  ShellSendInput,
  ShellSendOutput,
  ShellKillInput,
  ShellKillOutput,
} from './types.js';
export {
  DEFAULT_CONSTRAINTS,
  ShellExecInputSchema,
  ShellExecOutputSchema,
  ShellStatusInputSchema,
  ShellStatusOutputSchema,
  ShellGrepInputSchema,
  ShellGrepOutputSchema,
  ShellOutputInputSchema,
  ShellOutputOutputSchema,
  ShellSendInputSchema,
  ShellSendOutputSchema,
  ShellKillInputSchema,
  ShellKillOutputSchema,
} from './types.js';
