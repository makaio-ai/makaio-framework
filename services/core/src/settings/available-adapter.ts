import type { ProtocolId } from '@makaio/contracts/provider';

/**
 * Help link for adapter documentation.
 */
export interface HelpLink {
  /** Display label for the link. */
  label: string;
  /** URL to the resource. */
  url: string;
}

/**
 * Adapter metadata discovered at boot and consumed by settings/UI layers.
 *
 * This contract is shared across framework runtime code and host/application
 * consumers, so it lives in the framework-owned `@makaio/services-core`
 * package rather than a host-owned service package.
 */
export interface AvailableAdapter {
  /** Adapter driver name (e.g., `'claude-code'`, `'openai-node'`). */
  name: string;
  /** Human-readable display name for UI. */
  displayName: string;
  /** Short description for tooltips/selection UI. */
  description?: string;
  /** Help links for documentation. */
  helpLinks?: readonly HelpLink[];
  /** Setup instructions in Markdown format. */
  instructions?: string;
  /** Stable client identifier that this adapter belongs to (e.g. `'claude-code'`). */
  clientId?: string;
  /** Wire protocol this adapter speaks (e.g., `'anthropic'`, `'openai'`). */
  protocol?: ProtocolId;
  /**
   * Provider definition IDs this adapter can run against.
   *
   * This is the stable compatibility seam for onboarding and binding
   * suggestions. It avoids guessing from wire protocol alone.
   */
  providerDefinitionIds?: readonly string[];
}
