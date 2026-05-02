/**
 * Extension health-warning contracts.
 *
 * Defines the serializable {@link ExtensionWarning} shape that extensions return
 * from their {@link ExtensionServiceLifecycle.checkHealth} hook, plus the
 * discriminated-union {@link ExtensionWarningAction} type that lets the UI
 * surface a single call-to-action button per warning.
 *
 * All types are fully serializable — no functions, no class instances.
 */

import { z } from 'zod';

/**
 * Discriminated union of actionable responses to an extension warning.
 *
 * Each variant carries the data the host needs to execute the action without
 * further round-trips to the extension.
 *
 * - `configure-integration` — open the integration settings for a client.
 * - `install-extension`    — prompt the user to install another extension.
 * - `open-url`             — navigate to an external or internal URL.
 * - `run-command`          — invoke a registered bus command by name.
 */
export const ExtensionWarningActionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('configure-integration'),
    /** Client ID of the integration to configure (e.g. `'claude-code'`). */
    clientId: z.string().min(1),
    /** Extension bundle identifier the integration belongs to. */
    bundle: z.string().min(1),
  }),
  z.object({
    kind: z.literal('install-extension'),
    /** Display name of the extension the user should install. */
    extensionName: z.string().min(1),
  }),
  z.object({
    kind: z.literal('open-url'),
    /** Absolute URL to navigate to. */
    url: z.string().url(),
  }),
  z.object({
    kind: z.literal('run-command'),
    /** Fully-qualified bus command name to invoke. */
    command: z.string().min(1),
  }),
]);

/**
 * Severity levels for an {@link ExtensionWarning}.
 *
 * - `'info'`        — informational note; the extension functions normally.
 * - `'recommended'` — a recommended configuration is missing; functionality is reduced.
 * - `'degraded'`    — the extension is operating in a degraded fallback mode.
 */
export const ExtensionWarningSeveritySchema = z.enum(['info', 'recommended', 'degraded']);

/**
 * A single health warning emitted by a package's `checkHealth` hook.
 *
 * The host collects these after startup and may display them in the UI as
 * notification toasts or persistent status indicators.
 */
export const ExtensionWarningSchema = z.object({
  /** Severity level of this warning. */
  severity: ExtensionWarningSeveritySchema,
  /** Short human-readable summary (shown as toast / card title). */
  title: z.string().min(1),
  /** Detailed human-readable description of the issue. */
  message: z.string().min(1),
  /**
   * Optional call-to-action the host can surface as a button.
   *
   * When omitted the warning is informational only — no action button is shown.
   */
  action: ExtensionWarningActionSchema.optional(),
});

/** Inferred TypeScript type for {@link ExtensionWarningSchema}. */
export type ExtensionWarning = z.infer<typeof ExtensionWarningSchema>;

/** Inferred TypeScript type for {@link ExtensionWarningActionSchema}. */
export type ExtensionWarningAction = z.infer<typeof ExtensionWarningActionSchema>;

/** Inferred TypeScript type for {@link ExtensionWarningSeveritySchema}. */
export type ExtensionWarningSeverity = z.infer<typeof ExtensionWarningSeveritySchema>;

/**
 * Return the default user-facing label for an extension warning action.
 *
 * Kept with the action contract so every surface labels the same action kind
 * consistently without duplicating switch statements.
 * @param action - Extension warning action to label.
 * @returns Short button label for the action kind.
 */
export function getExtensionWarningActionLabel(action: ExtensionWarningAction): string {
  switch (action.kind) {
    case 'configure-integration':
      return 'Configure';
    case 'install-extension':
      return 'Install';
    case 'open-url':
      return 'Open';
    case 'run-command':
      return 'Run';
  }
}

/**
 * Aggregated warning entry grouping all health warnings for a single extension.
 *
 * Used as the payload shape for `extension.warnings.list` responses and
 * `extension.warnings.changed` events so consumers receive extension identity
 * alongside the full warning array in one atomic value.
 */
export const ExtensionWarningEntrySchema = z.object({
  /** Unique machine-readable extension identifier. */
  extensionName: z.string().min(1),
  /** All active health warnings reported by this extension. */
  warnings: z.array(ExtensionWarningSchema),
});

/** Inferred TypeScript type for {@link ExtensionWarningEntrySchema}. */
export type ExtensionWarningEntry = z.infer<typeof ExtensionWarningEntrySchema>;
