import { z } from 'zod';

/**
 * Approval policy enum values for Codex app-server.
 * Maps to AskForApproval in app-server protocol.
 * - 'untrusted': Always ask for approval (most restrictive)
 * - 'on-failure': Ask for approval only if command fails
 * - 'on-request': Ask for approval when command requests escalated permissions
 * - 'never': Never ask for approval (least restrictive)
 */
export const ApprovalPolicyValues = ['untrusted', 'on-failure', 'on-request', 'never'] as const;

/**
 * Sandbox mode enum values for Codex app-server.
 * Maps to SandboxMode in app-server protocol.
 * - 'read-only': Commands cannot write to filesystem
 * - 'workspace-write': Commands can write to workspace directories
 * - 'danger-full-access': Commands have full filesystem access
 */
export const SandboxModeValues = ['read-only', 'workspace-write', 'danger-full-access'] as const;

/**
 * Reasoning effort enum values for Codex app-server.
 * Maps to ReasoningEffort in app-server protocol.
 */
export const ReasoningEffortValues = ['low', 'medium', 'high'] as const;

/**
 * Zod schema for Codex app-server provider-specific configuration.
 *
 * Used for:
 * 1. Type-safe config resolution
 * 2. Serialization to JSON Schema for web-ui form generation
 * 3. Runtime validation
 *
 * Note: `cwd` and `model` come from the adapter options (BaseAgentConnectorConfig),
 * not from this provider config. This schema only contains provider-specific settings.
 */
export const CodexAppServerProviderConfigSchema = z.object({
  /**
   * Approval policy for tool execution.
   */
  approvalPolicy: z.enum(ApprovalPolicyValues).default('on-request').meta({
    title: 'Approval Policy',
    description: 'How to handle tool approval requests',
  }),

  /**
   * Sandbox mode for command execution.
   */
  sandboxMode: z.enum(SandboxModeValues).default('read-only').meta({
    title: 'Sandbox Mode',
    description: 'Sandbox execution environment',
  }),

  /**
   * Reasoning effort level.
   */
  reasoningEffort: z.enum(ReasoningEffortValues).optional().meta({
    title: 'Reasoning Effort',
    description: 'Level of reasoning effort for the model',
  }),
});

/**
 * Configuration type for Codex app-server adapter.
 */
export type CodexAppServerProviderConfig = z.infer<typeof CodexAppServerProviderConfigSchema>;
