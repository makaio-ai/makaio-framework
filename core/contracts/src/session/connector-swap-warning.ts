/**
 * Shared connector-swap warning policy values used across orchestration and adapters.
 */
export const UI_WARNINGS_CATEGORY = 'ui-warnings';

/**
 * Preference key for suppressing the connector-swap warning dialog globally.
 */
export const CONNECTOR_SWAP_WARNING_SUPPRESSED_KEY = 'connector-swap-warning-suppressed';

/**
 * Timeout for interactive warning dialogs (24 hours).
 */
export const INTERACTIVE_DIALOG_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/**
 * Canonical option IDs for connector-swap warning dialogs.
 */
export const CONNECTOR_SWAP_WARNING_OPTION_IDS = {
  cancel: 'cancel',
  edit: 'edit',
  continue: 'continue',
} as const;

/**
 * Connector-swap warning option identifier.
 */
export type ConnectorSwapWarningOptionId =
  (typeof CONNECTOR_SWAP_WARNING_OPTION_IDS)[keyof typeof CONNECTOR_SWAP_WARNING_OPTION_IDS];
