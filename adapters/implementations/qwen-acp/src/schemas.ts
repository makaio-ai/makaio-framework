import { z } from 'zod';

/**
 * Approval mode values for Qwen Code CLI.
 *
 * Maps to the `--approval-mode` flag accepted by `qwen` CLI:
 * - `'plan'`: Show a plan before executing any tool calls
 * - `'default'`: Ask for approval on writes and commands
 * - `'auto-edit'`: Automatically approve file edits, ask for commands
 * - `'yolo'`: Never ask for approval (fully autonomous)
 */
export const ApprovalModeValues = ['plan', 'default', 'auto-edit', 'yolo'] as const;

/**
 * Authentication type values for the underlying model provider.
 *
 * Determines which credential set and endpoint the Qwen CLI uses.
 */
export const AuthTypeValues = ['openai', 'anthropic', 'qwen-oauth', 'gemini', 'vertex-ai'] as const;

/**
 * Zod schema for Qwen ACP provider-specific configuration.
 *
 * Used for:
 * 1. Type-safe config resolution
 * 2. Serialization to JSON Schema for web-ui form generation
 * 3. Runtime validation
 *
 * Note: `cwd` and `model` come from the adapter options (BaseAgentConnectorConfig),
 * not from this provider config. This schema only contains provider-specific settings.
 */
export const QwenAcpProviderConfigSchema = z.object({
  /**
   * Path to the `qwen` CLI binary.
   * Defaults to `"qwen"` (resolved via PATH) when omitted.
   */
  binaryPath: z
    .preprocess(
      (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
      z.string().trim().min(1).optional(),
    )
    .meta({
      title: 'Binary Path',
      description: 'Path to qwen CLI binary (default: "qwen")',
    }),

  /**
   * How tool execution approval is handled.
   */
  approvalMode: z.enum(ApprovalModeValues).optional().meta({
    title: 'Approval Mode',
    description: 'How tool execution approval is handled',
  }),

  /**
   * Authentication method for the underlying model provider.
   */
  authType: z.enum(AuthTypeValues).optional().meta({
    title: 'Authentication Type',
    description: 'Authentication method for the model provider',
  }),
});

/**
 * Configuration type for the Qwen ACP adapter.
 */
export type QwenAcpProviderConfig = z.infer<typeof QwenAcpProviderConfigSchema>;
