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
import type { ExtensionEntry, ExtensionRuntimeSurface, InstalledExtensionCatalogSource } from './types.js';

/** Coordinator state the catalog assembly reads. */
export interface CatalogHost {
  /** Loaded runtime entries, keyed by executable package name. */
  readonly entries: ReadonlyMap<string, ExtensionEntry>;
  /** Durable enablement reader, when this coordinator has one. */
  readonly loadEnabled: ((name: string) => boolean | undefined) | undefined;
  /** Host-supplied installed-package reader, when this coordinator has one. */
  readonly installedCatalog: InstalledExtensionCatalogSource | undefined;
  /**
   * Runtime surface this coordinator is, used to resolve a name claimed by
   * more than one installed copy — see
   * {@link resolveInstalledExtensionRecord}.
   */
  readonly surface: ExtensionRuntimeSurface;
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
 * @returns Whether a catalog exists at all and, if so, the record this
 *   coordinator's surface resolves `name` to.
 */
export async function lookupInstalledExtension(host: CatalogHost, name: string): Promise<SetEnabledCatalogLookup> {
  if (!host.installedCatalog) return { kind: 'unavailable' };
  const records = await host.installedCatalog();
  return { kind: 'resolved', record: resolveInstalledExtensionRecord(records, name, host.surface) };
}

/**
 * Resolve the one installed record a name's enablement decision must answer
 * against on a given runtime surface.
 *
 * A name can appear on more than one row, and picking the first match is only
 * correct by accident. The catalog describes the *host* — every installed copy,
 * on every surface — while an enablement decision is made for one concrete
 * runtime. Three rules bridge that gap:
 *
 * 1. **A shadowed row is never the answer while a live one exists.** Discovery
 *    drops a shadowed descriptor whole, so its row describes an install no
 *    boot loads. When *every* row for the name is shadowed the name is still
 *    installed and still addressable, so the shadowed rows are what is left to
 *    answer from.
 * 2. **Surface decides between the rest.** The coordinator filters packages by
 *    surface *before* it resolves names, which is exactly why two copies
 *    restricted to different surfaces are not reported as a collision (see
 *    {@link InstalledExtensionRecord.collidesWith}). The same asymmetry has to
 *    hold here: on a headless runtime the headless copy is the one whose
 *    `critical` flag the next boot honours, and answering from the interactive
 *    copy would accept or refuse a disable on the strength of a package this
 *    surface never loads. A row restricted to *another* surface is kept only
 *    when nothing else claims the name — installed-but-not-loadable-here is
 *    still a real install with a real preference.
 * 3. **The contest is re-judged for this surface whenever it can be.** The
 *    catalog's own `collidesWith` answers "is this name contested
 *    *somewhere*", which is a different question — see
 *    {@link resolveContestOnThisSurface}. Carrying it through unchanged would
 *    refuse a name this runtime resolves cleanly; trusting its absence would
 *    accept one it cannot resolve at all; and discarding it where no second
 *    claimant is visible would drop the only evidence there is.
 * @param records - Installed records as reported by the catalog source.
 * @param name - Executable package name being resolved.
 * @param surface - Runtime surface the decision is being made for.
 * @returns The record to validate against, with its enablement facts stated
 *   for `surface`, or `undefined` when nothing installed claims the name.
 */
export function resolveInstalledExtensionRecord(
  records: readonly InstalledExtensionRecord[],
  name: string,
  surface: ExtensionRuntimeSurface,
): InstalledExtensionRecord | undefined {
  const claimed = records.filter((record) => record.name === name);
  const live = claimed.filter((record) => record.shadowedBy === undefined);
  const candidates = live.length > 0 ? live : claimed;
  const loadableHere = candidates.filter((record) => record.surface === undefined || record.surface === surface);
  const loadsHere = live.length > 0 && loadableHere.length > 0;
  const resolved = loadableHere.length > 0 ? loadableHere : candidates;

  const [first, ...rest] = resolved;
  if (first === undefined) return undefined;
  return withContest(rest.reduce(combineCriticality, first), resolveContestOnThisSurface(claimed, resolved, loadsHere));
}

/**
 * Decide whether the next boot on this surface can resolve the name at all.
 *
 * Three independent reasons say it cannot, and only one of them is a
 * `collidesWith` marker taken at face value:
 *
 * - **Nothing else claims the name here.** With a single row there is no
 *   second claimant to re-judge anything against — the source's marker
 *   describes a copy this view does not contain, and discarding it would turn
 *   a reported contest into silence.
 * - **More than one copy loads here.** Whatever the host-wide catalog says,
 *   every row that survived the surface filter is offered to the coordinator's
 *   name resolution together, and it aborts on the second one. A host-supplied
 *   catalog source that reports claimants without marking them is therefore
 *   still caught, and two copies on *different* surfaces — which this runtime
 *   never loads together — no longer refuse a name it resolves fine.
 * - **Discovery refuses the name before any surface exists.** A same-tier
 *   descriptor duplicate aborts the start whichever surface it runs on, so
 *   that marker survives the filter that drops every other one; see
 *   {@link InstalledExtensionRecord.collisionIgnoresSurface}.
 * @param claimed - Every row claiming the name, before any filtering.
 * @param resolved - Rows this surface resolves the name against.
 * @param loadsHere - Whether those rows are ones this runtime would load at
 *   all, as opposed to shadowed rows or rows restricted to another surface.
 * @returns The origin of a claimant the name is contested with, or `undefined`
 *   when this surface resolves it to a single package.
 */
function resolveContestOnThisSurface(
  claimed: readonly InstalledExtensionRecord[],
  resolved: readonly InstalledExtensionRecord[],
  loadsHere: boolean,
): InstalledExtensionRecord['origin'] | undefined {
  const [first, ...rest] = resolved;
  if (first === undefined) return undefined;
  if (claimed.length === 1) return first.collidesWith;
  if (loadsHere && rest.length > 0) return first.collidesWith ?? rest[0]?.origin;
  return resolved.find((record) => record.collisionIgnoresSurface === true)?.collidesWith;
}

/**
 * Restate one record's contest for the surface it was resolved on.
 *
 * The host-wide markers are dropped rather than merged: they answer a question
 * this record no longer represents, and leaving either of them on an answer
 * that resolves cleanly here is what would make the refusal wrong again.
 * @param record - Record resolved for this surface.
 * @param collidesWith - Contest {@link resolveContestOnThisSurface} derived, if any.
 * @returns The record carrying exactly this surface's contest.
 */
function withContest(
  record: InstalledExtensionRecord,
  collidesWith: InstalledExtensionRecord['origin'] | undefined,
): InstalledExtensionRecord {
  const { collidesWith: _hostWide, collisionIgnoresSurface: _scope, ...resolved } = record;
  return { ...resolved, ...(collidesWith !== undefined && { collidesWith }) };
}

/**
 * Combine two records that both still claim one name into the conservative
 * answer for it.
 *
 * Identity fields come from the first record — it is the one the merge order
 * already ranks highest — while criticality is widened to the more restrictive
 * of the two: a disable must be refused when *either* claimant is critical,
 * and when either one's criticality is unresolved. The contest itself is not
 * combined here; it is derived from the whole resolved set by
 * {@link resolveContestOnThisSurface}.
 * @param record - Answer accumulated so far.
 * @param other - Further record claiming the same name.
 * @returns The combined record.
 */
function combineCriticality(
  record: InstalledExtensionRecord,
  other: InstalledExtensionRecord,
): InstalledExtensionRecord {
  const critical = record.critical === true || other.critical === true ? true : (record.critical ?? other.critical);
  const criticalityUnknown =
    record.criticalityUnknown === true || other.criticalityUnknown === true
      ? true
      : (record.criticalityUnknown ?? other.criticalityUnknown);
  return {
    ...record,
    ...(critical !== undefined && { critical }),
    ...(criticalityUnknown !== undefined && { criticalityUnknown }),
  };
}
