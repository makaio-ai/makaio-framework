/**
 * CLI handler for `makaio git-hooks received`.
 *
 * Manually ingests a raw Git hook event for testing purposes. Reads from
 * stdin and emits on the bus exactly as the real receiver binary would.
 * @packageDocumentation
 */

import type { CommandContext } from '@makaio/kernel/cli';
import { emitInboundHookReceivedFast, safeReadStdinText } from '@makaio/inbound-hooks';
import { receiveGitHook } from '../receiver/receive.js';

/**
 * Parsed CLI argument shape for the `git-hooks received` subcommand.
 */
export interface GitHooksReceivedArgs {
  /** Native Git hook event name to simulate (e.g. `'post-commit'`). */
  readonly eventName: string;
  /** Repository root path. Defaults to the current working directory. */
  readonly repo?: string;
}

/**
 * CLI handler for `makaio git-hooks received <event-name>`.
 *
 * Delegates to {@link receiveGitHook} with the process working directory and
 * bus connection defaults. Intended for manual smoke-testing of the hook
 * ingestion pipeline without triggering a real git operation.
 * @param ctx - CLI command context.
 */
export async function handleGitHooksReceived(ctx: CommandContext<GitHooksReceivedArgs>): Promise<void> {
  await receiveGitHook(
    {
      eventName: ctx.args.eventName,
      stateFile: 'manual-ingestion',
      argv: [],
    },
    {
      cwd: ctx.args.repo ?? process.cwd(),
      readStdinText: safeReadStdinText,
      emit: emitInboundHookReceivedFast,
      now: Date.now,
    },
  );
  ctx.output.write('Hook event emitted.\n');
}
