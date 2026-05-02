/**
 * \@makaio/tools-shell
 *
 * Cross-platform shell execution tools for AI agents.
 */

export { createShellToolset, type CreateShellToolsetOptions } from './toolset.js';

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
