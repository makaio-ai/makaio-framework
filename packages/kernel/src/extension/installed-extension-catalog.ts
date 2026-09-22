/**
 * Assembly of the coordinator's installed-extension catalog view.
 *
 * The host supplies the raw installed records (see
 * {@link InstalledExtensionCatalogSource}); everything the coordinator knows
 * about those names — whether a framework package currently holds one, and
 * what the durable store records for it — is layered on here, in one place,
 * so `kernel:extension.catalog` and the validation
 * `kernel:extension.setEnabled` performs cannot answer from different views of
 * the same name.
 * @packageDocumentation
 */
import type {
  InstalledExtensionCatalogEntry,
  InstalledExtensionRecord,
} from '../observability/installed-extension-catalog-schemas.js';
import type { SetEnabledCatalogLookup } from './extension-toggle.js';
import type { ExtensionEntry, InstalledExtensionCatalogSource } from './types.js';

/** Coordinator state the catalog assembly reads. */
export interface CatalogHost {
  /** Loaded runtime entries, keyed by executable package name. */
  readonly entries: ReadonlyMap<string, ExtensionEntry>;
  /** Durable enablement reader, when this coordinator has one. */
  readonly loadEnabled: ((name: string) => boolean | undefined) | undefined;
  /** Host-supplied installed-package reader, when this coordinator has one. */
  readonly installedCatalog: InstalledExtensionCatalogSource | undefined;
}

/**
 * Enrich one installed record with the enablement facts only the coordinator
 * can answer for it.
 *
 * A name no loaded entry claims is operator-managed by definition — it is an
 * installed descriptor package and nothing else holds the name. A name a
 * loaded entry does claim inherits that entry's own answer, which is `false`
 * exactly when a framework package shadows the installed one.
 * @param host - Coordinator state to read.
 * @param record - Installed record reported by the host's catalog source.
 * @returns The record plus its enablement facts.
 */
function toCatalogEntry(host: CatalogHost, record: InstalledExtensionRecord): InstalledExtensionCatalogEntry {
  const entry = host.entries.get(record.name);
  const extensionManaged = entry?.extensionManaged ?? true;
  // A framework package has no operator preference at all, so reporting the
  // store's answer for its name would invent one — `ExtensionInfo` makes the
  // same distinction for the same reason.
  const persistedEnabled = extensionManaged ? host.loadEnabled?.(record.name) : undefined;
  return {
    ...record,
    extensionManaged,
    ...(persistedEnabled !== undefined && { persistedEnabled }),
  };
}

/**
 * Build the full catalog snapshot backing `kernel:extension.catalog`.
 * @param host - Coordinator state to read.
 * @returns Every installed package with its enablement facts, or `null` when
 *   this runtime has no installed-extension catalog to report.
 */
export async function buildInstalledExtensionCatalog(
  host: CatalogHost,
): Promise<InstalledExtensionCatalogEntry[] | null> {
  if (!host.installedCatalog) return null;
  const records = await host.installedCatalog();
  return records.map((record) => toCatalogEntry(host, record));
}

/**
 * Resolve the catalog's answer for a single name, for `setEnabled` validation.
 *
 * Deliberately scans the whole catalog rather than asking the source for one
 * name: the source enumerates install tiers and imports extension code, and
 * narrowing that to a single lookup would either duplicate the tier-merge
 * rules — which decide *which* of two same-named installs the next boot would
 * actually load — or answer from a stale cache. This is an interactive path,
 * not a hot one.
 * @param host - Coordinator state to read.
 * @param name - Executable package name being toggled.
 * @returns Whether a catalog exists at all and, if so, the record for `name`.
 */
export async function lookupInstalledExtension(host: CatalogHost, name: string): Promise<SetEnabledCatalogLookup> {
  if (!host.installedCatalog) return { kind: 'unavailable' };
  const records = await host.installedCatalog();
  return { kind: 'resolved', record: records.find((record) => record.name === name) };
}
