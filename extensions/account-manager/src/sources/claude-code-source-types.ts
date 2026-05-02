/** Options for ClaudeCodeSource installation probing. */
export interface ClaudeCodeSourceOptions {
  /** Directory whose presence indicates Claude Code is installed. */
  installDir?: string;
}

/**
 * Profile data returned by the Anthropic OAuth profile endpoint.
 *
 * Contains stable identifiers for account and organization that survive
 * token rotation, plus display-relevant fields for label resolution.
 */
export interface OAuthProfile {
  /** Stable account UUID. */
  accountUuid: string;
  /** Stable organization UUID. */
  orgUuid: string;
  /** Organization display name, if present. */
  orgName: string | null;
  /** Account email address, if present. */
  email: string | null;
}
