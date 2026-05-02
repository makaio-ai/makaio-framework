/**
 * Onboarding Adapters
 *
 * Pure async functions for adapter/client discovery during onboarding.
 * Scan state is owned by the flow orchestrator via {@link OnboardingFlowState}.
 * @packageDocumentation
 */
import { MakaioBus } from '@makaio/bus-core';
import { ClientSubjects } from '@makaio/contracts/client';
import { ClientStorageSubjects } from '@makaio/services-core/settings/storage';
import { SettingsSubjects } from '@makaio/services-core/settings/namespace';

/**
 * Client-grouped scan result for onboarding.
 *
 * One record is emitted per client. The `adapterNames` array lists all adapter
 * driver names belonging to that client so callers can enable them in bulk or
 * individually via {@link SettingsSubjects.adapter.setEnabled}.
 */
export interface OnboardingClient {
  /** Stable client identifier (e.g., 'claude-code'). */
  clientId: string;
  /** Human-readable display name (e.g., 'Claude Code'). */
  name: string;
  /** CLI binary name used for detection. */
  binary: string;
  /** Whether the CLI binary was detected on the system. */
  found: boolean;
  /** Detected CLI version, if found. */
  version?: string;
  /**
   * Warning message returned by the canonical client scan service.
   */
  warningMessage?: string;
  /**
   * Adapter driver names belonging to this client
   * (e.g., `['claude-agent-sdk', 'claude-code-cli']`).
   */
  adapterNames: string[];
}

/**
 * Enriched adapter metadata with canonical client scan results.
 *
 * One record is emitted per adapter (not per client). A single client binary
 * may map to multiple adapters (e.g., `claude` → `claude-agent-sdk` and
 * `claude-code-cli`), so the caller receives one row per adapter with the real
 * `adapterName` that the settings API understands.
 */
export interface OnboardingAdapter {
  /**
   * Real adapter driver name as registered with the settings API.
   * Used by AdaptersStep to call {@link SettingsSubjects.adapter.setEnabled}.
   */
  adapterName: string;
  /** Display name for UI */
  displayName: string;
  /** CLI binary name */
  binary: string;
  /** Whether CLI binary was detected */
  found: boolean;
  /** Detected version (if found) */
  version?: string;
  /**
   * Warning message returned by the canonical client scan service.
   */
  warningMessage?: string;
}

/**
 * Shared scan context built from bus data.
 *
 * Captures the resolved clients, adapter index, and canonical scan results so both
 * {@link scanOnboardingAdapters} and {@link scanOnboardingClients} can build
 * their respective output shapes from the same underlying data.
 */
export interface ScanContext {
  /** Enabled clients enriched with canonical scan results. */
  scannedClients: Array<{
    id: string;
    name: string;
    binaryName: string;
    found: boolean;
    version?: string;
    warningMessage?: string;
  }>;
  /** Adapter names indexed by clientId. */
  adaptersByClientId: Map<string, string[]>;
}

/**
 * Fetches clients and adapters from the bus, reuses `client.scan` for the
 * canonical scan result, and returns the shared context used by both public
 * scan functions.
 *
 * Returns `null` when there are no scannable clients (callers should return `[]`).
 * @returns Populated scan context, or null when no scannable clients exist
 */
export async function buildScanContext(): Promise<ScanContext | null> {
  const [{ clients }, { adapters }] = await Promise.all([
    MakaioBus.request(ClientStorageSubjects.list, {}),
    MakaioBus.request(SettingsSubjects.adapter.list, {}),
  ]);

  const scannableClients = clients
    .filter((c): c is typeof c & { binaryName: string } => c.enabled && c.binaryName !== undefined)
    .map((c) => ({
      id: c.id,
      name: c.name,
      binaryName: c.binaryName,
      minimumVersion: c.minimumVersion,
    }));

  if (scannableClients.length === 0) {
    return null;
  }

  const { results } = await MakaioBus.request(ClientSubjects.scan, {
    targets: scannableClients.map((client) => ({
      clientId: client.id,
      binaryName: client.binaryName,
      minimumVersion: client.minimumVersion,
    })),
  });
  const scanResultsByClientId = new Map(results.map((result) => [result.clientId, result]));
  const scannedClients = scannableClients.map((client) => {
    const scanResult = scanResultsByClientId.get(client.id);
    return {
      id: client.id,
      name: client.name,
      binaryName: client.binaryName,
      found: scanResult?.found ?? false,
      version: scanResult?.version,
      warningMessage: scanResult?.warningMessage,
    };
  });

  // Index adapter names by clientId for O(1) lookup.
  // A single client may have multiple adapters (e.g. claude-code has both
  // claude-agent-sdk and claude-code-cli).
  // Ordering is not significant here — adapterNames are sorted in
  // buildClientResults() before exposure to consumers.
  const adaptersByClientId = new Map<string, string[]>();
  for (const adapter of adapters) {
    if (!adapter.clientId) continue;
    const existing = adaptersByClientId.get(adapter.clientId);
    if (existing) {
      existing.push(adapter.adapterName);
    } else {
      adaptersByClientId.set(adapter.clientId, [adapter.adapterName]);
    }
  }

  return { scannedClients, adaptersByClientId };
}

/**
 * Transforms a {@link ScanContext} into enriched adapter records — one per adapter.
 *
 * Extracted so the result-building step can be shared between
 * {@link scanOnboardingAdapters} and {@link scanOnboarding} without
 * duplicating bus requests.
 * @param ctx - Populated scan context returned by {@link buildScanContext}
 * @returns Enriched adapter list with canonical client scan results
 */
function buildAdapterResults(ctx: ScanContext): OnboardingAdapter[] {
  const { scannedClients, adaptersByClientId } = ctx;

  // For each scannable client, emit one OnboardingAdapter per matching adapter.
  // This ensures adapterName is always the real adapter driver name that the
  // settings API understands, even when client IDs differ from adapter names
  // (e.g. client 'codex' → adapter 'codex-app-server').
  const results: OnboardingAdapter[] = [];

  for (const client of scannedClients) {
    const clientAdapterNames = adaptersByClientId.get(client.id);

    if (!clientAdapterNames?.length) {
      // No adapter registered for this client — skip. The client is installed
      // but has no adapter to enable in the onboarding UI.
      continue;
    }

    // Emit one row per adapter so the onboarding UI can enable each one
    // independently with the correct driver name.
    // When a single client maps to multiple adapters (e.g. Claude Code →
    // claude-agent-sdk + claude-code-cli), each row inherits the client's
    // display name. The UI should show adapterName alongside displayName
    // to distinguish rows for the same client.
    for (const adapterName of clientAdapterNames) {
      results.push({
        adapterName,
        displayName: client.name,
        binary: client.binaryName,
        found: client.found,
        version: client.version,
        warningMessage: client.warningMessage,
      });
    }
  }

  return results;
}

/**
 * Sort priority for adapter names. CLI adapters come first (safest default
 * for auto-enable), then SDK adapters, then everything else.
 * @param name - Adapter name to classify
 * @returns Numeric priority (lower = higher priority)
 */
function adapterSortPriority(name: string): number {
  const lower = name.toLowerCase();
  if (lower.includes('cli')) return 0;
  if (lower.includes('sdk')) return 1;
  return 2;
}

/**
 * Transforms a {@link ScanContext} into client-grouped scan records — one per client.
 *
 * Extracted so the result-building step can be shared between
 * {@link scanOnboardingClients} and {@link scanOnboarding} without
 * duplicating bus requests.
 * @param ctx - Populated scan context returned by {@link buildScanContext}
 * @returns Client-grouped scan results
 */
function buildClientResults(ctx: ScanContext): OnboardingClient[] {
  const { scannedClients, adaptersByClientId } = ctx;

  const results: OnboardingClient[] = [];

  for (const client of scannedClients) {
    // Sort adapter names so the first entry is deterministic regardless of bus
    // return order. CLI adapters sort before SDK adapters so the auto-enable
    // in AdaptersStep picks the safest default.
    // Include clients even when no adapters are registered — ClientsStep and
    // ClientToolCard already handle adapterNames.length === 0 gracefully.
    const adapterNames = (adaptersByClientId.get(client.id) ?? []).sort((a, b) => {
      const pa = adapterSortPriority(a);
      const pb = adapterSortPriority(b);
      return pa !== pb ? pa - pb : a.localeCompare(b);
    });

    results.push({
      clientId: client.id,
      name: client.name,
      binary: client.binaryName,
      found: client.found,
      version: client.version,
      warningMessage: client.warningMessage,
      adapterNames,
    });
  }

  return results;
}

/**
 * Fetches all CLI-backed clients from the client storage bus, reuses the
 * canonical `client.scan` results, and returns enriched adapter records
 * including found/version/warningMessage data.
 *
 * This is a pure async function — it carries no React state. Scan results are
 * owned by the flow orchestrator ({@link OnboardingFlowState.scanAdapters}).
 *
 * Prefer {@link scanOnboarding} when both adapter and client results are needed
 * to avoid issuing duplicate bus requests.
 * @returns Enriched adapter list with canonical client scan results
 * @example
 * ```typescript
 * const adapters = await scanOnboardingAdapters();
 * ```
 */
export async function scanOnboardingAdapters(): Promise<OnboardingAdapter[]> {
  const ctx = await buildScanContext();
  if (!ctx) return [];
  return buildAdapterResults(ctx);
}

/**
 * Scans for installed CLI-backed clients and returns client-grouped results.
 *
 * Unlike {@link scanOnboardingAdapters} which emits one row per adapter,
 * this function emits one row per client with an `adapterNames` array
 * listing all adapter driver names belonging to that client.
 *
 * Prefer {@link scanOnboarding} when both adapter and client results are needed
 * to avoid issuing duplicate bus requests.
 * @returns Client-grouped scan results
 */
export async function scanOnboardingClients(): Promise<OnboardingClient[]> {
  const ctx = await buildScanContext();
  if (!ctx) return [];
  return buildClientResults(ctx);
}

/**
 * Run both adapter and client scans using a single shared scan context.
 *
 * Avoids duplicate bus requests that would occur when calling
 * {@link scanOnboardingAdapters} and {@link scanOnboardingClients} independently.
 * @returns Combined scan results for adapters and clients
 */
export async function scanOnboarding(): Promise<{
  adapters: OnboardingAdapter[];
  clients: OnboardingClient[];
}> {
  const ctx = await buildScanContext();
  if (!ctx) return { adapters: [], clients: [] };
  return {
    adapters: buildAdapterResults(ctx),
    clients: buildClientResults(ctx),
  };
}
