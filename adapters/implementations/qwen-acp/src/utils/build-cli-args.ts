import type { QwenAcpProviderConfig } from '../schemas.js';

/**
 * Input configuration for CLI argument construction.
 */
interface BuildCliArgsInput {
  /** Model identifier to pass via `--model` */
  model?: string;
  /** Provider-specific configuration containing optional flags */
  providerConfig?: QwenAcpProviderConfig;
}

/**
 * Builds CLI arguments for the Qwen ACP subprocess.
 *
 * Always prepends `--acp` to activate the Agent Client Protocol mode.
 * Always appends `--include-partial-messages` and `--output-format stream-json`
 * as fixed protocol requirements for streaming JSON output.
 * Optional flags are appended only when present in the configuration.
 * @param config - Connector configuration with model and provider settings
 * @returns Array of CLI arguments suitable for passing to `spawn()`
 */
export function buildCliArgs(config: BuildCliArgsInput): string[] {
  const args: string[] = ['--acp'];
  const p = config.providerConfig;

  if (config.model) {
    args.push('--model', config.model);
  }
  if (p?.approvalMode) {
    args.push('--approval-mode', p.approvalMode);
  }
  if (p?.authType) {
    args.push('--auth-type', p.authType);
  }

  args.push('--include-partial-messages', '--output-format', 'stream-json');

  return args;
}
