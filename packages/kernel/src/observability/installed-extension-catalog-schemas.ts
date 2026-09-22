/**
 * Schemas for the server-owned installed-extension catalog
 * (`kernel:extension.catalog`).
 *
 * The catalog answers "what is installed on the host running this
 * coordinator", which is a strictly larger question than "what did this
 * coordinator load": an extension can be installed and never loaded
 * (interactive-only on a headless runtime, unmet requirements, suppressed at
 * boot), and its enablement preference is still addressable. Callers that can
 * only see their own machine — a CLI configured against a remote bus, or one
 * invoked from a different working directory than the server — have no other
 * way to enumerate or validate those names.
 *
 * Pure Zod schemas — no bus registration, no side effects.
 * @packageDocumentation
 */
import { z } from 'zod';

/**
 * Discovery tier an installed extension package was found in.
 *
 * - `'project-local'` — the highest-priority tier: the `node_modules` of the
 *   project directory the runtime was started from, or the descriptor roots a
 *   host declared for itself in runtime config, which rank the same.
 * - `'local'` — a symlinked install under the data home's `extensions/`.
 * - `'npm'` — a registry install under the data home's `node_modules/`.
 *
 * Reported verbatim so a caller can tell an extension shared through the data
 * home apart from one that only exists in the host's own project tree.
 */
export const InstalledExtensionOriginSchema = z.enum(['local', 'npm', 'project-local']);

/** Inferred union of installed-extension discovery tiers. */
export type InstalledExtensionOrigin = z.infer<typeof InstalledExtensionOriginSchema>;

/**
 * One installed executable extension package, as seen without starting any
 * extension service.
 *
 * Keyed by executable package identity — the descriptor name, or one of its
 * dot-prefixed children — because that is what the enablement store, the
 * runtime loader, and every enablement RPC address. A single descriptor whose
 * server entrypoint exports several packages produces one record per package.
 */
export const InstalledExtensionRecordSchema = z.object({
  /**
   * Executable package identity: the descriptor name, or one of its
   * dot-prefixed child packages. Never the npm dependency identifier.
   */
  name: z.string().min(1),
  /** Installed version. */
  version: z.string(),
  /** Discovery tier this package was found in. */
  origin: InstalledExtensionOriginSchema,
  /**
   * Whether the executable package under this name declares itself critical.
   *
   * `undefined` is ambiguous on its own — either nothing declares the flag (a
   * descriptor with no server entrypoint, legitimately non-critical) or the
   * declaration could not be read. {@link InstalledExtensionRecordSchema}'s
   * `criticalityUnknown` disambiguates the two; a caller gating a disable on
   * criticality must check it first and refuse rather than read an absent flag
   * as `false`.
   */
  critical: z.boolean().optional(),
  /**
   * `true` when `critical` could not be resolved because this package's
   * descriptor declares a server entrypoint that could not be read — the file
   * was missing or unreadable, the import failed, or the export violated the
   * runtime's identity contract or declared a non-boolean `critical`.
   *
   * Never `true` for a descriptor with no server entrypoint at all, whose
   * absent `critical` is a legitimate "not critical". Omitted (not `false`)
   * when criticality is resolved or legitimately absent.
   */
  criticalityUnknown: z.boolean().optional(),
  /**
   * Whether the descriptor declares a server entrypoint at all, independent of
   * whether it could be read. Distinguishes "no executable package to inspect"
   * from "an executable package this host failed to inspect".
   */
  declaresServerEntrypoint: z.boolean().optional(),
  /**
   * npm dependency identifier this package was installed under, when it
   * differs from `name` (an npm package whose descriptor declares a different
   * name than the package shipping it). Display-only — every enablement lookup
   * uses `name`.
   */
  npmName: z.string().min(1).optional(),
  /**
   * Runtime surface this package is restricted to, when it declares exactly
   * one (`MakaioExtension.surface`).
   *
   * Absent means "loads on every surface": the package declared `'any'`,
   * declared nothing, or its declaration could not be read. Two copies
   * claiming one name only contest it where both can be loaded at once, which
   * is what this field decides — see `collidesWith`.
   */
  surface: z.enum(['interactive', 'headless']).optional(),
  /**
   * Set when a higher-priority discovery tier already claimed this `name`,
   * naming that winner's `origin`.
   *
   * The runtime loads exactly one extension per name and resolves a
   * cross-tier descriptor-name collision by tier precedence. The losing copy
   * is still installed, so it is reported here rather than dropped — an
   * operator who just installed it would otherwise see it vanish from the
   * catalog with no explanation.
   *
   * Never set on a package the runtime would load. A shadowed record always
   * follows its winner, so every lookup by name keeps resolving to the winner.
   *
   * Only a *descriptor* name is resolvable this way, because the descriptor is
   * what discovery sees. A name claimed by an executable child package is not —
   * see `collidesWith`.
   */
  shadowedBy: InstalledExtensionOriginSchema.optional(),
  /**
   * Set when this `name` is claimed by two installed copies the runtime
   * refuses to choose between, naming the other claimant's `origin`.
   *
   * Unlike `shadowedBy` this is not a resolved contest — it is a boot failure.
   * Both claimants carry it, because neither loads: the next start aborts
   * instead of picking one. Two cases produce it:
   *
   * - Two packages in *one* discovery tier claiming one descriptor name. There
   *   is no precedence within a tier, so the boot-time discovery refuses.
   * - A name claimed across tiers by at least one executable *child* package
   *   (`foo.bar` exported by descriptor `foo`) rather than by two descriptors.
   *   Discovery resolves tiers by descriptor name only, so both descriptors
   *   are admitted, both then register the contested package name, and the
   *   coordinator's own name resolution aborts the load.
   *
   * The second case is judged per `surface`: the coordinator filters by
   * surface *before* it resolves names, so two copies restricted to different
   * surfaces are never offered to that resolution together and neither blocks
   * the other. The first case does not depend on it at all — discovery refuses
   * a same-tier duplicate before any package is loaded, so no surface
   * declaration exists yet to exempt it.
   */
  collidesWith: InstalledExtensionOriginSchema.optional(),
  /**
   * Set when the contest `collidesWith` reports is one no runtime surface can
   * exempt: two packages inside a single discovery tier claiming one
   * descriptor name. Discovery refuses that before any package is loaded, so
   * no `surface` declaration exists yet to judge it by and every start aborts,
   * whichever surface it runs.
   *
   * Absent for the other contest — a name claimed across tiers by an
   * executable child package — which only exists on a surface that loads both
   * claimants at once. A consumer deciding for one concrete surface re-judges
   * that one against the copies that surface actually loads, and must keep
   * refusing this one regardless. Omitted (not `false`) whenever
   * `collidesWith` itself is absent.
   */
  collisionIgnoresSurface: z.boolean().optional(),
});

/** Inferred type for one installed executable extension package. */
export type InstalledExtensionRecord = z.infer<typeof InstalledExtensionRecordSchema>;

/**
 * One installed package as reported over the bus, enriched with the enablement
 * facts only the coordinator holding the durable store can answer.
 */
export const InstalledExtensionCatalogEntrySchema = InstalledExtensionRecordSchema.extend({
  /**
   * Whether this name's enablement is operator-managed.
   *
   * `false` when a framework package currently holds the name: the coordinator
   * loads it unconditionally, so the installed package under the same name is
   * shadowed until the framework package no longer claims it. A preference can
   * still be persisted for it — it simply does not take effect while the
   * collision lasts.
   */
  extensionManaged: z.boolean(),
  /**
   * The durable enablement preference currently recorded for this name, read
   * live from the coordinator's enablement store.
   *
   * `undefined` when nothing is recorded for it, or when the coordinator was
   * built without a durable store — neither is the same answer as `true` or
   * `false`.
   */
  persistedEnabled: z.boolean().optional(),
});

/** Inferred type for one catalog entry reported by `kernel:extension.catalog`. */
export type InstalledExtensionCatalogEntry = z.infer<typeof InstalledExtensionCatalogEntrySchema>;
