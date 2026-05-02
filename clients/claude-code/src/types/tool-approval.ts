/**
 * Claude SDK PermissionResult for tool approval.
 *
 * Returned by the `can_use_tool` bus handler and mapped to the SDK's
 * native PermissionResult shape by the connector.
 */
export interface ClaudePermissionResult {
  /** Whether the tool use is allowed or denied. */
  behavior: 'allow' | 'deny';
  /** Updated input to pass to the tool (only when behavior is 'allow'). */
  updatedInput?: unknown;
  /** Updated permissions list (only when behavior is 'allow'). */
  updatedPermissions?: unknown[];
  /** Denial message shown to the model (only when behavior is 'deny'). */
  message?: string;
  /** Whether to interrupt the turn after denial. */
  interrupt?: boolean;
}
