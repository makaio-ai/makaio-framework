import { ClientSubjects } from '@makaio/contracts/client';
import type { ExtensionWarning } from '@makaio/contracts';
import type { IMakaioBus } from '@makaio/bus-core';
import type { CredentialSourceWithOptionalLabel } from './handlers/index.js';

/**
 * Host-owned inputs for account-manager health checks.
 */
export interface AccountManagerHealthWarningOptions {
  /**
   * CLI command that installed wiring entries should invoke for this host.
   *
   * Rebranded hosts can supply their launcher path/name here instead of having
   * account-manager assume the framework development binary name.
   */
  readonly makaioCommand: string;
}

/**
 * Collect account-manager integration health warnings after startup.
 *
 * Inspects each credential source and returns an {@link ExtensionWarning} for
 * sources that are not installed, have a source-owned configuration issue, or
 * have incomplete integration wiring. An unavailable source (tool not installed)
 * produces an `'info'` warning; an installed but misconfigured or unwired
 * source produces a `'recommended'` warning with a `configure-integration`
 * action so the UI can route the user directly to integration settings.
 * @param bus - Bus used to request clients-core wiring status
 * @param sources - Credential sources registered with account-manager
 * @param options - Host-owned health-check inputs
 * @returns Active health warnings, one per affected source/integration issue
 */
export async function collectAccountManagerHealthWarnings(
  bus: IMakaioBus,
  sources: ReadonlyArray<CredentialSourceWithOptionalLabel>,
  options: AccountManagerHealthWarningOptions,
): Promise<ExtensionWarning[]> {
  const warnings: ExtensionWarning[] = [];
  for (const source of sources) {
    let available: boolean | undefined;
    let probeError: unknown;
    try {
      available = await source.isAvailable();
    } catch (error) {
      probeError = error;
    }
    if (probeError !== undefined) {
      warnings.push({
        severity: 'degraded',
        title: `${source.displayName} health check unavailable`,
        message: `Could not inspect whether ${source.displayName} is installed: ${formatErrorMessage(probeError)}`,
      });
      continue;
    }
    if (available === false) {
      warnings.push({
        severity: 'info',
        title: `${source.displayName} not detected`,
        message: `No ${source.displayName} installation was found. Install the tool and restart to enable account management for it.`,
      });
      continue;
    }

    const configWarning = await checkSourceConfigHealth(source);
    if (configWarning) {
      warnings.push(configWarning);
    }

    const wiringWarning = await checkIntegrationWiringHealth(bus, source, options);
    if (wiringWarning) {
      warnings.push(wiringWarning);
    }
  }
  return warnings;
}

/**
 * Inspect a source-owned configuration probe.
 * @param source - Source whose native configuration should be inspected
 * @returns A configuration warning, or null when healthy/unimplemented
 */
async function checkSourceConfigHealth(source: CredentialSourceWithOptionalLabel): Promise<ExtensionWarning | null> {
  if (!source.getConfigIssue) {
    return null;
  }
  try {
    const issue = await source.getConfigIssue();
    if (!issue) {
      return null;
    }
    return {
      severity: 'recommended',
      title: `${source.displayName} configuration issue`,
      message: issue.reason,
      action: { kind: 'configure-integration', clientId: source.clientId, bundle: 'account-manager' },
    };
  } catch {
    // One source failing must not suppress warnings from the remaining sources.
    return {
      severity: 'info',
      title: `${source.displayName} health check unavailable`,
      message: `Could not inspect ${source.displayName} configuration.`,
    };
  }
}

/**
 * Inspect client-owned wiring status for a credential source.
 *
 * Availability/config probes only prove the native client exists. The
 * integration health invariant also requires host hook wiring to be
 * installed, so this uses the global clients-core aggregator instead of
 * duplicating per-client config parsing inside account-manager.
 * @param bus - Bus used to request clients-core wiring status
 * @param source - Credential source whose client wiring should be inspected
 * @param options - Host-owned wiring command used to inspect expected entries
 * @returns A health warning when wiring is incomplete or unavailable
 */
export async function checkIntegrationWiringHealth(
  bus: IMakaioBus,
  source: CredentialSourceWithOptionalLabel,
  options: AccountManagerHealthWarningOptions,
): Promise<ExtensionWarning | null> {
  try {
    // The global wiring contract compares concrete command strings. Hosts own
    // this value via AccountManagerHealthWarningOptions so rebranded launchers
    // do not leak host-specific defaults into the health-check logic.
    const result = await bus.requestOptional(ClientSubjects.wiring.list, {
      clientId: source.clientId,
      makaioCommand: options.makaioCommand,
    });
    if (!result.handled) {
      return integrationStatusUnavailable(source);
    }

    const clientResult = result.data.results.find((candidate) => candidate.clientId === source.clientId);
    if (!clientResult) {
      return {
        severity: 'recommended',
        title: `${source.displayName} integration not configured`,
        message: `${source.displayName} did not report integration wiring status.`,
        action: { kind: 'configure-integration', clientId: source.clientId, bundle: 'account-manager' },
      };
    }

    const missing = clientResult.entries.filter((entry) => !entry.installed);
    if (missing.length === 0) {
      return null;
    }

    return {
      severity: 'recommended',
      title: `${source.displayName} integration wiring incomplete`,
      message:
        `${source.displayName} has ${formatEntryCount(missing.length)} ` +
        `that ${missing.length === 1 ? 'is' : 'are'} not installed.`,
      action: { kind: 'configure-integration', clientId: source.clientId, bundle: 'account-manager' },
    };
  } catch {
    return integrationStatusUnavailable(source);
  }
}

/**
 * Build a warning for an unavailable wiring-status probe.
 * @param source - Source whose status could not be inspected
 * @returns Informational health warning
 */
function integrationStatusUnavailable(source: CredentialSourceWithOptionalLabel): ExtensionWarning {
  return {
    severity: 'info',
    title: `${source.displayName} integration status unavailable`,
    message: `Could not inspect ${source.displayName} integration wiring.`,
  };
}

/**
 * Format a count of missing wiring entries for user-facing health warnings.
 * @param count - Number of missing wiring entries
 * @returns Human-readable count phrase
 */
function formatEntryCount(count: number): string {
  return `${count} integration ${count === 1 ? 'entry' : 'entries'}`;
}

/**
 * Format an unknown thrown value for user-facing health warnings.
 * @param error - Thrown probe error value
 * @returns Error message string
 */
function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
