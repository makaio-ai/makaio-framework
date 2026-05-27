/**
 * CLI contribution entry point for the `workflow` extension.
 *
 * Declares the `makaio workflow` top-level command with its `run` subcommand.
 * The CLI framework lazy-loads this module only when a `workflow` subcommand
 * action fires, so importing heavy adapters or bus initialization here is safe.
 *
 * Usage:
 * ```
 * makaio workflow run ./my-workflow.ts
 * makaio workflow run ./my-workflow.ts --payload '{"branch":"main"}'
 * echo '{"branch":"main"}' | makaio workflow run ./my-workflow.ts
 * makaio workflow run ./my-workflow.ts --dry-run
 * makaio workflow run ./my-workflow.ts --verbose
 * ```
 */
import type { CliContribution } from '@makaio/kernel/cli';
import { ALWAYS_PROCEED } from '@makaio/kernel/cli';
import { workflowRunCommand } from './run-command.js';
import { bootEmbeddedWorkflowRuntime } from './embedded-workflow-runtime.js';

/**
 * Workflow extension CLI contribution.
 *
 * Registered as `makaio workflow` in the Makaio CLI. The `run` subcommand
 * accepts a workflow file path, an optional trigger payload (from flag, stdin,
 * or await-trigger mode), and lifecycle options.
 *
 * This contribution declares `canProvideBus: true` so the CLI router can skip
 * desktop auto-launch after probing for an already-running daemon. When no
 * external bus connects, `provideBus` boots an embedded headless runtime.
 * `beforeRun` returns {@link ALWAYS_PROCEED} so the default "bus must be
 * connected" gate is bypassed for the embedded path.
 */
const workflowCli: CliContribution = {
  name: 'workflow',
  description: 'Run Makaio workflows',
  canProvideBus: true,
  subcommands: [workflowRunCommand],
  provideBus: bootEmbeddedWorkflowRuntime,
  beforeRun: () => ALWAYS_PROCEED,
};

export default workflowCli;
