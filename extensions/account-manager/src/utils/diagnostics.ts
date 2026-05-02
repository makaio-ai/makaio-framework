/**
 * Default runtime should stay quiet during steady-state account-manager
 * polling. Set `MAKAIO_ACCOUNT_MANAGER_DIAGNOSTICS=true` to enable traces.
 */
const ACCOUNT_MANAGER_DIAGNOSTICS_ENABLED = process.env.MAKAIO_ACCOUNT_MANAGER_DIAGNOSTICS === 'true';

/**
 * Emits an account-manager diagnostic line when verbose polling traces are enabled.
 * @param scope - Component prefix for the log line.
 * @param message - Diagnostic message.
 */
export function logAccountManagerDiagnostic(scope: string, message: string): void {
  if (!ACCOUNT_MANAGER_DIAGNOSTICS_ENABLED) return;
  console.debug(`[${scope}] ${new Date().toISOString()} ${message}`);
}

/**
 * Emits an account-manager error while preserving the original error object.
 * @param message - Fully formatted error prefix with local context.
 * @param error - The caught failure to report.
 */
export function logAccountManagerError(message: string, error: unknown): void {
  console.error(message, error);
}
