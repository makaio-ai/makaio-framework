/**
 * CLI contribution entry point for the `prompt` extension.
 *
 * Declares the `makaio prompt` top-level command with its `send` subcommand.
 * The CLI framework lazy-loads this module only when a `prompt` subcommand
 * action fires, so importing React, Ink, or heavy adapters here is safe.
 *
 * Usage:
 * ```
 * makaio prompt send "hello" --model sonnet
 * makaio prompt send --model sonnet < input.txt
 * ```
 */
import type { CliContribution } from '@makaio/kernel/cli';
import { promptCommand } from './prompt-command.js';

/**
 * Prompt extension CLI contribution.
 *
 * Registered as `makaio prompt` in the Makaio CLI. The single `send`
 * subcommand accepts a prompt argument (or reads from stdin) and writes the
 * AI response to stdout, making it composable with shell pipelines.
 */
const promptCli: CliContribution = {
  name: 'prompt',
  description: 'Send a prompt to any AI provider via the Makaio bus',
  subcommands: [promptCommand],
};

export default promptCli;
