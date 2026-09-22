/**
 * Scan of every extension package this host's configured discovery can see,
 * expanded to the executable package names the runtime actually addresses.
 *
 * This is the one place that answers "what is installed here", for both the
 * command surface that reads it without a running runtime and the runtime that
 * exposes its own view over the bus (`kernel:extension.catalog`). Keeping it
 * single-sourced is what makes those two answers comparable — but the stronger
 * property is that it asks the *same* {@link ExtensionDiscovery} the boot
 * sequence asks. A host that configures its own roots, or filters descriptors
 * with `include`/`exclude`, gets a catalog describing exactly the descriptors
 * its next boot would consider: nothing it would load is reported
 * not-installed, and nothing it filtered out is reported as toggleable.
 *
 * Discovery answers with descriptors, not with loaded packages, so this stays
 * strictly larger than what a boot actually loads — surface affinity, unmet
 * requirements and boot-time suppression all leave a discovered descriptor
 * unloaded, and its enablement preference is still addressable.
 *
 * Where the boot path refuses an unresolvable name, this one describes it. It
 * therefore reads the discovery's raw precedence layers
 * ({@link discoverExtensionTiers}) rather than its resolved result: a contest
 * the boot sequence aborts on is a row an operator has to be able to see and
 * act on, not an error that swallows the rest of the answer.
 * @packageDocumentation
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { InstalledExtensionRecord } from '@makaio/kernel';

export type { InstalledExtensionRecord };
import {
  describeSameTierNameCollision,
  discoverExtensionTiers,
  type DiscoveredExtension,
  type ExtensionDiscovery,
  type ExtensionEntrypointModule,
} from './extension-discovery.js';
import { resolveConventionEntrypoint } from './load-extensions.js';
import type { FrameworkModuleResolver } from './framework-module-resolver.js';
import {
  readExportedPackagesFromModule,
  readExportedPackagesInProcess,
  toRestrictedSurface,
  type ExportedPackageListing,
  type ExportedPackagesReader,
} from './installed-extension-readers.js';

/**
 * Catalog origin reported for each discovery tier.
 *
 * Discovery and the catalog name the same three tiers differently — discovery
 * from the loader's perspective (`'local'` is the project's own tree), the
 * catalog from an operator's (`'local'` is a data-home symlink) — so the
 * mapping is spelled out once here rather than inferred at each call site.
 */
const ORIGIN_BY_DISCOVERY_SOURCE: Readonly<Record<DiscoveredExtension['source'], InstalledExtensionRecord['origin']>> =
  {
    local: 'project-local',
    installed: 'local',
    'global-npm': 'npm',
  };

/**
 * One discovered descriptor reduced to what the expansion below needs, with
 * its server entrypoint already resolved.
 */
interface DiscoveredExtensionListing {
  /** Extension identity declared in `descriptor.json`. */
  readonly name: string;
  /** Installed version, as declared by the descriptor. */
  readonly version: string;
  /** Catalog tier this descriptor was discovered in. */
  readonly origin: InstalledExtensionRecord['origin'];
  /**
   * `critical` as declared in the package's `descriptor.json`.
   *
   * Authoritative only for a descriptor with no server entrypoint, whose
   * package the runtime synthesizes from this metadata; the schema forbids the
   * field on any descriptor that does declare one.
   */
  readonly critical?: boolean;
  /**
   * `surface` as declared in the package's `descriptor.json`.
   *
   * Authoritative only for a descriptor with no server entrypoint, whose
   * package the runtime synthesizes from this metadata; a server-backed
   * descriptor's exported package carries its own declaration, which wins. An
   * absent declaration is read as "loads on every surface" — the conservative
   * answer, since assuming a restriction that was never declared would hide a
   * real contest.
   */
  readonly surface?: 'interactive' | 'headless' | 'any';
  /** Absolute import path for the resolved server entrypoint, when present. */
  readonly serverImportPath?: string;
  /**
   * Whether the descriptor declares `entrypoints.server` at all, independent
   * of whether `serverImportPath` could be resolved.
   *
   * `serverImportPath` alone cannot distinguish "no server entrypoint
   * declared" (legitimately no exported package, so an absent `critical` is a
   * known "not critical") from "a server entrypoint is declared but its
   * convention-resolved candidate file is missing or unreadable" (criticality
   * is genuinely unknown) — both leave `serverImportPath` undefined.
   */
  readonly declaresServerEntrypoint: boolean;
  /**
   * Server entry module the host preloaded for this descriptor, when it
   * supplied one.
   *
   * A bundled host statically imports its extensions at build time and hands
   * the loader the module itself; its `extensionPath` need not contain a
   * convention-resolvable entry file at all. The loader uses this module
   * directly, so the scan must expand it directly too — resolving a path that
   * host never relies on would report an installed package as
   * criticality-unknown, drop every child package it exports, and refuse
   * toggles for names the runtime loads happily.
   */
  readonly preloadedModule?: ExtensionEntrypointModule;
  /** npm dependency identifier shipping this descriptor, when it differs from {@link name}. */
  readonly npmName?: string;
}

/** Inputs for one installed-extension scan. */
export interface InstalledExtensionScanOptions {
  /**
   * The discovery strategy whose view this scan describes — the same instance
   * the host boots with.
   *
   * Required rather than defaulted: the answer is only meaningful relative to
   * one concrete set of roots and filters, and a scan that silently assembled
   * its own would report packages the host's runtime never sees, and omit
   * packages it does.
   */
  readonly discovery: ExtensionDiscovery;
  /**
   * Reader used to enumerate each descriptor's exported packages. Defaults to
   * the in-process import, which is correct for a short-lived process; a
   * long-lived runtime must supply the worker-backed reader instead (see
   * {@link ExportedPackagesReader}).
   */
  readonly exportedPackages?: ExportedPackagesReader;
  /**
   * Module resolver for `@makaio/framework/*` subpath imports, as selected by
   * the host owning this scan.
   *
   * Only meaningful with the default in-process reader, which imports each
   * server entrypoint on this process's own module registry: an extension
   * installed from a local path lives outside that module tree, so its
   * `@makaio/framework/*` imports only resolve while the host's resolver hook
   * is installed. Without it, such an extension's export is unreadable and its
   * criticality is reported unknown — which fails closed, refusing a disable
   * the runtime itself would have allowed.
   *
   * Installed for the duration of one scan and uninstalled afterwards: the
   * hook is process-wide loader state, so the scan owns it only while it is
   * importing extension code. Omitted by hosts that resolve
   * `@makaio/framework/*` natively, and by the worker-backed reader, which
   * mirrors the hook inside its own loader context instead.
   */
  readonly frameworkModuleResolver?: FrameworkModuleResolver;
}

/**
 * List every discoverable installed extension, expanded with the executable
 * child packages each descriptor's server entrypoint exports.
 *
 * Tier precedence is the supplied discovery's own, which is the point:
 * whichever of two same-named installs the next boot would load is the one
 * reported as loadable here. What the discovery *refuses* to resolve — and the
 * one contest it cannot even express, because it works on descriptors and not
 * on executable packages — is reported rather than thrown; see
 * {@link mergeDiscoveredTiers}.
 * @param options - Scan inputs; see {@link InstalledExtensionScanOptions}.
 * @returns Records in discovery-tier order; each descriptor's own record is
 *   immediately followed by the records for the child packages it exports, and
 *   a shadowed record follows the winner that shadows it.
 */
export async function scanInstalledExtensions(
  options: InstalledExtensionScanOptions,
): Promise<readonly InstalledExtensionRecord[]> {
  const resolver = options.frameworkModuleResolver;
  try {
    await resolver?.install();
    return await scanDiscoveredExtensions(options);
  } finally {
    // Also runs when `install()` itself threw part-way — the same cleanup the
    // runtime performs for a failed install at boot, so a partially installed
    // hook never outlives this scan.
    await resolver?.uninstall();
  }
}

/**
 * Run the configured discovery and expand every descriptor it reports.
 *
 * Split from {@link scanInstalledExtensions} so the module resolver's
 * install/uninstall window wraps every server-entry import this performs, with
 * no early return escaping it.
 * @param options - Scan inputs.
 * @returns Merged records in discovery order.
 */
async function scanDiscoveredExtensions(
  options: InstalledExtensionScanOptions,
): Promise<readonly InstalledExtensionRecord[]> {
  const read = options.exportedPackages ?? readExportedPackagesInProcess;
  // The discovery's raw layers, not its resolved result: `discover()` answers
  // what boot loads and refuses a same-tier duplicate outright, while this has
  // to keep describing every installed package — including the ones that
  // contest — so an operator can see and fix the contest.
  const tiers = await discoverExtensionTiers(options.discovery);
  reportSameTierDescriptorCollisions(tiers);
  const tierGroups = await Promise.all(
    tiers.map(async (tier) => {
      const listings = await Promise.all(tier.map(toListing));
      return Promise.all(listings.map((listing) => expandListing(listing, read)));
    }),
  );
  return mergeDiscoveredTiers(tierGroups);
}

/**
 * Warn about every descriptor name a single discovery tier declares twice,
 * naming both packages' filesystem provenance.
 *
 * The records this scan returns carry the contest as `collidesWith`, but they
 * are keyed by package name and origin — which is all a client without access
 * to this filesystem can act on, and not enough for the operator on this host
 * to find the two directories involved. Discovery's own refusal carries that
 * provenance in its error; this path does not refuse, so it logs the same
 * diagnostic rather than dropping it.
 * @param tiers - Discovery tiers, ordered highest to lowest priority.
 */
function reportSameTierDescriptorCollisions(tiers: ReadonlyArray<readonly DiscoveredExtension[]>): void {
  for (const tier of tiers) {
    const claimed = new Map<string, DiscoveredExtension>();
    for (const ext of tier) {
      const name = ext.descriptor.name;
      const existing = claimed.get(name);
      if (existing === undefined) {
        claimed.set(name, ext);
        continue;
      }
      console.warn(`[extension catalog] ${describeSameTierNameCollision(name, existing, ext)}`);
    }
  }
}

/**
 * Reduce one discovered extension to the listing the expansion consumes,
 * resolving its server entrypoint the way the runtime itself does.
 * @param ext - Extension reported by the configured discovery.
 * @returns The equivalent listing entry.
 */
async function toListing(ext: DiscoveredExtension): Promise<DiscoveredExtensionListing> {
  const { descriptor, extensionPath } = ext;
  const serverEntrypoint = descriptor.entrypoints?.server;
  const declaresServerEntrypoint = serverEntrypoint !== undefined;
  const serverImportPath = declaresServerEntrypoint
    ? resolveConventionEntrypoint('server', serverEntrypoint, extensionPath)
    : undefined;
  const npmName = await readNpmPackageName(extensionPath);
  return {
    name: descriptor.name,
    version: descriptor.version,
    origin: ORIGIN_BY_DISCOVERY_SOURCE[ext.source],
    declaresServerEntrypoint,
    ...(descriptor.critical !== undefined && { critical: descriptor.critical }),
    ...(descriptor.surface !== undefined && { surface: descriptor.surface }),
    // Gated on the declaration for the same reason the loader is: it skips a
    // descriptor without `entrypoints.server` before it ever looks at a
    // preloaded module, so a module handed in without one exports nothing the
    // runtime would load.
    ...(declaresServerEntrypoint && ext.preloadedModule !== undefined && { preloadedModule: ext.preloadedModule }),
    ...(serverImportPath !== undefined && { serverImportPath }),
    ...(npmName !== undefined && npmName !== descriptor.name && { npmName }),
  };
}

/**
 * Read the npm identifier of the package shipping a descriptor.
 *
 * Reported for display only, so a missing or malformed `package.json` — an
 * extension directory that is not an npm package at all — is an absent
 * identifier, never a scan failure.
 * @param extensionPath - Absolute extension package root.
 * @returns The `name` from the package's manifest, when it declares one.
 */
async function readNpmPackageName(extensionPath: string): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(path.join(extensionPath, 'package.json'), 'utf-8');
    const manifest: unknown = JSON.parse(raw);
    const name = (manifest as { readonly name?: unknown }).name;
    return typeof name === 'string' && name.length > 0 ? name : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Expand one listing into its descriptor record followed by the records for
 * its executable child packages.
 *
 * The descriptor's own row takes its `critical` flag from the exported package
 * carrying the descriptor name — the same object the coordinator loads — and
 * falls back to descriptor metadata only when there is no export to read. When
 * the entry declares a server entrypoint that could not be read, the
 * descriptor's own row is marked `criticalityUnknown` rather than silently
 * reported as non-critical: the schema forbids the descriptor from declaring
 * `critical` itself in that case, so there is no metadata to fall back to
 * either. The descriptor's own record always leads the group, which
 * {@link mergeDiscoveredTiers} relies on to identify it.
 *
 * Exactly one exported-packages read per descriptor: the `critical` flag of
 * the descriptor's own package is a projection of that single listing, never a
 * second import of the same entrypoint.
 * @param listing - Listing to expand.
 * @param read - Reader for the listing's exported packages.
 * @returns The descriptor's own record followed by its child package records.
 */
async function expandListing(
  listing: DiscoveredExtensionListing,
  read: ExportedPackagesReader,
): Promise<InstalledExtensionRecord[]> {
  const resolution = await readExportedPackages(listing, read);
  if (resolution === undefined) {
    // A declared server entrypoint that could not be read — whether because
    // its candidate path never resolved or the import itself failed — leaves
    // criticality genuinely unresolved. Checking `declaresServerEntrypoint`
    // rather than `serverImportPath` is what makes that distinction: an
    // unresolvable path also leaves `serverImportPath` undefined, which would
    // otherwise be indistinguishable from "no entrypoint declared" (a
    // legitimate, known "not critical").
    return [
      toRecord(listing, {
        version: listing.version,
        ...(listing.critical !== undefined && { critical: listing.critical }),
        surface: toRestrictedSurface(listing.surface),
        criticalityUnknown: listing.declaresServerEntrypoint,
      }),
    ];
  }

  const { packages, invalidCriticalNames } = resolution;
  const ownPackage = packages.find((pkg) => pkg.name === listing.name);
  return [
    toRecord(listing, {
      // The exported package's own version, not the descriptor's: the loader
      // registers the object the server entry exports, and the two are allowed
      // to diverge. Reporting the descriptor's version would describe a
      // package under a version the runtime never runs it at.
      version: ownPackage?.version ?? listing.version,
      ...(ownPackage?.critical !== undefined && { critical: ownPackage.critical }),
      // The exported package's own `surface` wins over the descriptor's too:
      // the coordinator gates on the object it loads, and the descriptor's
      // metadata only reaches a package the runtime synthesizes from it.
      surface: ownPackage ? ownPackage.surface : toRestrictedSurface(listing.surface),
      // A package present in the export but whose raw `critical` value failed
      // validation is not "legitimately non-critical" — it is unresolved for
      // the same reason an unreadable entrypoint is, so it carries the same
      // marker.
      criticalityUnknown: invalidCriticalNames.has(listing.name),
    }),
    ...packages
      .filter((pkg) => pkg.name !== listing.name)
      .map((pkg) => ({
        name: pkg.name,
        version: pkg.version,
        origin: listing.origin,
        ...(pkg.critical !== undefined && { critical: pkg.critical }),
        ...(pkg.surface !== undefined && { surface: pkg.surface }),
        ...(invalidCriticalNames.has(pkg.name) && { criticalityUnknown: true }),
        // A child package only exists because the descriptor's server entry
        // exported it, so the entrypoint is declared by construction.
        declaresServerEntrypoint: true,
      })),
  ];
}

/**
 * Read one listing's exported packages, when it has an export to read at all.
 *
 * A preloaded module short-circuits the reader entirely: the host already
 * loaded it, so there is no path to resolve, no import to perform, and — for
 * the worker-backed reader — no thread to spawn.
 * @param listing - Listing to inspect.
 * @param read - Reader for the listing's exported packages.
 * @returns The exported packages, or `undefined` when there is no readable export.
 */
async function readExportedPackages(
  listing: DiscoveredExtensionListing,
  read: ExportedPackagesReader,
): Promise<ExportedPackageListing | undefined> {
  const label = `[extension catalog] ${listing.name}`;
  if (listing.preloadedModule !== undefined) {
    return readExportedPackagesFromModule(listing.preloadedModule.default, listing.name, label);
  }
  if (listing.serverImportPath === undefined) return undefined;
  return read({
    serverImportPath: listing.serverImportPath,
    descriptorName: listing.name,
    label,
  });
}

/**
 * What the caller resolved for the descriptor's own executable package, from
 * the export when there is one and from descriptor metadata when there is not.
 */
interface OwnPackageResolution {
  /** Version to report for the descriptor's own package name. */
  readonly version: string;
  /**
   * Criticality resolved from the authoritative declaration; `undefined` when
   * nothing declares it.
   */
  readonly critical?: boolean;
  /**
   * Single runtime surface this descriptor's package is restricted to,
   * resolved from the authoritative declaration; `undefined` when it loads on
   * every surface.
   */
  readonly surface: InstalledExtensionRecord['surface'];
  /**
   * `true` when {@link critical} is `undefined` because the declaration could
   * not be read, not because nothing declares it.
   */
  readonly criticalityUnknown: boolean;
}

/**
 * Normalize a listing into the {@link InstalledExtensionRecord} for the
 * descriptor's own package name.
 * @param listing - Listing to normalize.
 * @param own - What the caller resolved for the descriptor's own package.
 * @returns Normalized record for the descriptor's own package name.
 */
function toRecord(listing: DiscoveredExtensionListing, own: OwnPackageResolution): InstalledExtensionRecord {
  return {
    name: listing.name,
    version: own.version,
    origin: listing.origin,
    ...(own.critical !== undefined && { critical: own.critical }),
    ...(own.surface !== undefined && { surface: own.surface }),
    ...(own.criticalityUnknown && { criticalityUnknown: true }),
    ...(listing.declaresServerEntrypoint && { declaresServerEntrypoint: true }),
    ...(listing.npmName !== undefined && { npmName: listing.npmName }),
  };
}

/** One live claim on a package name, recorded while merging tiers. */
interface NameClaim {
  /** Position of the claiming record in the merged output. */
  readonly mergedIndex: number;
  /** Origin of the claiming record, reported to the records it collides with. */
  readonly origin: InstalledExtensionRecord['origin'];
  /**
   * Single runtime surface the claiming package is restricted to, or
   * `undefined` when it loads on every surface.
   */
  readonly surface: InstalledExtensionRecord['surface'];
  /**
   * Whether this claim originates from a descriptor name repeated inside one
   * tier, which contests the name regardless of any surface declaration — see
   * {@link claimsContest}.
   */
  readonly sameTierDescriptorContest: boolean;
}

/**
 * Merge the per-descriptor groups of every discovery tier, reproducing what
 * the runtime does with each claimed package name: resolve it, or refuse to
 * boot.
 *
 * Two different contests exist, and conflating them makes this scan disagree
 * with the runtime:
 *
 * - **A descriptor name claimed by a higher-priority tier.** This is the one
 *   contest the discovery itself resolves, by tier precedence. The losing
 *   descriptor is dropped whole from the boot — its child packages cannot load
 *   without it — and is marked `shadowedBy` here rather than omitted: it is
 *   installed, an operator can act on it, and silently dropping it makes a
 *   just-installed extension look like it had never been installed. Keeping it
 *   is safe for every lookup because it is always emitted *after* the winner,
 *   so scanning for the first row matching a name still finds the loaded copy.
 * - **Any other repeated claim on one name.** Two packages inside a single
 *   tier, or a cross-tier claim in which at least one side is an executable
 *   child package, have no resolution. Discovery deduplicates by descriptor
 *   name: a same-tier duplicate has no precedence to appeal to and it refuses
 *   outright, while two distinct descriptor names (`foo` exporting `foo.bar`,
 *   and a descriptor literally named `foo.bar`) both survive it and the
 *   coordinator's own package coalescing then aborts the load. Every claimant
 *   is marked `collidesWith` — none of them loads. A cross-tier claim is
 *   judged per surface, because the coordinator's name check only ever sees
 *   the packages one surface loaded — see {@link claimsContest}. The same-tier
 *   case additionally carries `collisionIgnoresSurface`, since discovery
 *   refuses it before any surface exists: a consumer resolving the name for one
 *   concrete surface re-judges every other contest against the copies that
 *   surface loads, and has to keep this one whatever it finds.
 *
 * This is deliberately *not* what the boot path does with the same input: boot
 * refuses, this describes. The catalog is an observation over every tier,
 * including packages no boot would load, so it reports the contest instead of
 * throwing on it — and a caller that must not act on an unresolvable name
 * reads `collidesWith` rather than relying on a thrown error.
 * @param tiers - Per-descriptor groups per discovery tier, ordered highest to
 *   lowest priority. Each group is one descriptor record followed by its child
 *   package records.
 * @returns Flattened record list: unshadowed records followed by the records
 *   they shadow, with every unresolvable claim marked as a collision.
 */
function mergeDiscoveredTiers(
  tiers: ReadonlyArray<ReadonlyArray<readonly InstalledExtensionRecord[]>>,
): InstalledExtensionRecord[] {
  const descriptorClaims = new Map<string, { tierIndex: number; origin: InstalledExtensionRecord['origin'] }>();
  const claimsByName = new Map<string, NameClaim[]>();
  const merged: InstalledExtensionRecord[] = [];

  tiers.forEach((tier, tierIndex) => {
    for (const group of tier) {
      const descriptorRecord = group[0];
      if (descriptorRecord === undefined) continue;
      // Only a *higher* tier shadows a whole group. A descriptor name repeated
      // inside one tier has no precedence to appeal to, so both copies stay
      // live here and are surfaced as a collision below.
      const descriptorClaim = descriptorClaims.get(descriptorRecord.name);
      const groupShadowOrigin =
        descriptorClaim !== undefined && descriptorClaim.tierIndex < tierIndex ? descriptorClaim.origin : undefined;
      if (descriptorClaim === undefined) {
        descriptorClaims.set(descriptorRecord.name, { tierIndex, origin: descriptorRecord.origin });
      }

      // A descriptor name repeated inside one tier is refused by the discovery
      // itself, before any package exists to carry a surface declaration — so
      // that contest is recorded as surface-independent.
      const sameTierDescriptorContest = descriptorClaim?.tierIndex === tierIndex;

      for (const record of group) {
        // A shadowed group's records claim nothing: its descriptor never
        // loads, so the names its children would have registered stay free for
        // a lower tier to take without that being a collision.
        if (groupShadowOrigin !== undefined) {
          merged.push({ ...record, shadowedBy: groupShadowOrigin });
          continue;
        }
        const claims = claimsByName.get(record.name) ?? [];
        claims.push({
          mergedIndex: merged.length,
          origin: record.origin,
          surface: record.surface,
          sameTierDescriptorContest: sameTierDescriptorContest && record.name === descriptorRecord.name,
        });
        claimsByName.set(record.name, claims);
        merged.push(record);
      }
    }
  });

  return markNameCollisions(merged, claimsByName);
}

/**
 * Decide whether two claims on one name actually contest it.
 *
 * The coordinator resolves names *after* it filters packages by surface, so
 * two packages restricted to different surfaces are never handed to that
 * resolution together: each boots on its own surface and neither displaces the
 * other. Reporting them as a collision would refuse a toggle for a name that
 * resolves fine on every surface a host can actually be.
 *
 * A same-tier descriptor-name contest ignores this: discovery refuses before
 * any package is loaded, so no surface declaration exists yet to exempt it.
 *
 * `requires` (host and capability gates) is deliberately *not* evaluated the
 * same way. It is answered by the host environment of the process that boots,
 * which this scan cannot know — two packages with disjoint `requires` may
 * still both be eligible on some host, and treating them as safe here would
 * reinstate exactly the silent override this reporting exists to end. They
 * stay reported as a collision.
 * @param claim - One claim on the name.
 * @param other - Another claim on the same name.
 * @returns Whether both claims can be loaded at once, making the name contested.
 */
function claimsContest(claim: NameClaim, other: NameClaim): boolean {
  if (claim.sameTierDescriptorContest || other.sameTierDescriptorContest) return true;
  return claim.surface === undefined || other.surface === undefined || claim.surface === other.surface;
}

/**
 * Mark every record whose name survived tier resolution with a claimant it
 * actually contests the name with.
 *
 * Both sides are marked, not just the later one: the runtime loads neither, so
 * presenting either as the winner would be the same misreport `collidesWith`
 * exists to end.
 * @param merged - Records in scan order, as produced by {@link mergeExtensionTiers}.
 * @param claimsByName - Live claims per package name, keyed by name.
 * @returns The record list with each colliding record marked.
 */
function markNameCollisions(
  merged: readonly InstalledExtensionRecord[],
  claimsByName: ReadonlyMap<string, readonly NameClaim[]>,
): InstalledExtensionRecord[] {
  const result = [...merged];
  for (const claims of claimsByName.values()) {
    if (claims.length < 2) continue;
    for (const claim of claims) {
      const record = result[claim.mergedIndex];
      const contesting = claims.filter((candidate) => candidate !== claim && claimsContest(claim, candidate));
      const other = contesting[0];
      if (record === undefined || other === undefined) continue;
      // A same-tier descriptor duplicate is refused by discovery itself, so no
      // surface can exempt it. Reported separately because a consumer deciding
      // for one concrete surface re-judges every *other* contest against the
      // copies that surface loads, and would otherwise drop this one with them.
      const ignoresSurface = contesting.some(
        (candidate) => claim.sameTierDescriptorContest || candidate.sameTierDescriptorContest,
      );
      result[claim.mergedIndex] = {
        ...record,
        collidesWith: other.origin,
        ...(ignoresSurface && { collisionIgnoresSurface: true }),
      };
    }
  }
  return result;
}
