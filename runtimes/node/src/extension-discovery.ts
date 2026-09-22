import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { glob } from 'glob';
import { type ExtensionDescriptor, parseExtensionDescriptor } from '@makaio/contracts';

/** Preloaded server entry module used by bundled hosts. */
export interface ExtensionEntrypointModule {
  /** Server entry default export, validated by the extension loader. */
  readonly default: unknown;
  /** Optional owner-anchored host cron scheduler policy, validated separately from descriptor-owned packages. */
  readonly automationCronSchedulerHostPolicy?: unknown;
}

/**
 * An extension discovered on the filesystem.
 * Carries the validated descriptor and the absolute path to the extension
 * package root (used to resolve {@link ExtensionDescriptor.entrypoints}).
 */
export interface DiscoveredExtension {
  /** Validated descriptor parsed from `descriptor.json`. */
  readonly descriptor: ExtensionDescriptor;
  /** Absolute path to the extension package root directory. */
  readonly extensionPath: string;
  /**
   * Where the extension was found.
   * `'local'` (project node_modules) takes priority over `'installed'` (managed extensions),
   * which takes priority over `'global-npm'` (global npm install).
   */
  readonly source: 'local' | 'installed' | 'global-npm';
  /**
   * Pre-loaded server entry module. When present, the extension loader skips
   * filesystem-based entry resolution and uses this module directly. Enables
   * bundled deployments where extension code is statically imported at build
   * time rather than dynamically discovered on disk.
   */
  readonly preloadedModule?: ExtensionEntrypointModule;
}

/**
 * Options for {@link FilesystemDescriptorDiscovery}.
 */
export interface FilesystemDescriptorDiscoveryOptions {
  /**
   * Override for project-local extension packages, or `false` to skip the
   * local tier. Defaults to `{cwd}/node_modules`.
   */
  readonly localNodeModulesDir?: string | false;
  /**
   * Managed extension install directory (e.g. `{makaioHome}/extensions`).
   */
  readonly extensionsDir: string;
  /**
   * Global npm node_modules directory (e.g. `{makaioHome}/node_modules`).
   */
  readonly nodeModulesDir: string;
}

/**
 * Strategy interface for discovering extensions.
 * Implementations scan different locations (filesystem, explicit list)
 * and return validated descriptors ready for the loading bridge.
 */
export interface ExtensionDiscovery {
  /** Scan for extensions and return validated discoveries. */
  discover(): Promise<DiscoveredExtension[]>;
}

const DESCRIPTOR_FILENAME = 'descriptor.json';
const DESCRIPTOR_GLOB_IGNORES = ['**/node_modules/**', '**/dist/**', '**/.git/**'] as const;

/**
 * Enumerate descriptor files from one configured filesystem path without
 * parsing them. A package-root descriptor wins over nested descriptors, and a
 * node_modules root is limited to direct and scoped packages.
 * @param discoveryPath - Descriptor file, package directory, node_modules root, or recursive search root.
 * @returns Matching descriptor paths using the runtime's filesystem discovery semantics.
 */
export async function enumerateDescriptorPaths(discoveryPath: string): Promise<string[]> {
  const entry = await fs.stat(discoveryPath).catch(() => undefined);
  if (entry === undefined) return [];
  if (entry.isFile()) return path.basename(discoveryPath) === DESCRIPTOR_FILENAME ? [discoveryPath] : [];
  if (!entry.isDirectory()) return [];

  const packageDescriptorPath = path.join(discoveryPath, DESCRIPTOR_FILENAME);
  if (await isFile(packageDescriptorPath)) return [packageDescriptorPath];

  const isNodeModulesRoot = path.basename(discoveryPath) === 'node_modules';
  const patterns = isNodeModulesRoot ? ['*/descriptor.json', '@*/*/descriptor.json'] : [`**/${DESCRIPTOR_FILENAME}`];
  const matches = await Promise.all(
    patterns.map((pattern) =>
      glob(pattern, {
        absolute: true,
        cwd: discoveryPath,
        ...(isNodeModulesRoot ? {} : { ignore: [...DESCRIPTOR_GLOB_IGNORES] }),
        windowsPathsNoEscape: true,
      }),
    ),
  );
  return matches.flat();
}

/**
 * Discovers extensions by scanning up to three locations in priority order:
 *
 * 1. `{cwd}/node_modules/` — project-local installs (`'local'`), unless disabled via options
 * 2. `{makaioHome}/extensions/` — managed extension installs (`'installed'`), requires `options.extensionsDir`
 * 3. `{makaioHome}/node_modules/` — global npm installs (`'global-npm'`), requires `options.nodeModulesDir`
 *
 * When `options` is omitted, only the local tier is scanned (installed/global tiers are skipped).
 * Each location supports both flat (`pkg/`) and scoped (`@scope/pkg/`) packages.
 * Validates each descriptor against {@link ExtensionDescriptorSchema}.
 * Malformed or invalid descriptors are skipped with a console warning.
 * On a cross-tier name collision, earlier tiers win (local \> installed \>
 * global-npm) and the shadowed copy is reported; a collision *within* one tier
 * has no precedence to appeal to and throws — see
 * {@link deduplicateByDescriptorName}.
 */
export class FilesystemDescriptorDiscovery implements ExtensionDiscovery {
  private readonly localNodeModulesDir: string | false;
  private readonly extensionsDir: string | false;
  private readonly nodeModulesDir: string | false;

  /**
   * @param cwd - Working directory for local node_modules scan. Defaults to `process.cwd()`.
   * @param options - Discovery directory configuration. When omitted, only project-local
   *   node_modules are scanned (installed/global tiers are skipped). When provided, both
   *   `extensionsDir` and `nodeModulesDir` are required so callers cannot silently
   *   fall back to a hardcoded default.
   */
  public constructor(cwd?: string, options?: FilesystemDescriptorDiscoveryOptions) {
    this.localNodeModulesDir = options?.localNodeModulesDir ?? path.join(cwd ?? process.cwd(), 'node_modules');
    this.extensionsDir = options?.extensionsDir ?? false;
    this.nodeModulesDir = options?.nodeModulesDir ?? false;
  }

  /**
   * Scan all three extension locations and return a deduplicated list.
   *
   * Priority: local → installed → global-npm. Earlier tiers win a cross-tier
   * name collision; a collision within one tier throws.
   * @returns Deduplicated list of discovered extensions ordered by priority.
   * @throws ExtensionNameCollisionError when one tier declares the same descriptor name twice.
   */
  public async discover(): Promise<DiscoveredExtension[]> {
    const [local, installed, globalNpm] = await Promise.all([
      this.scanLocal(),
      this.scanInstalled(),
      this.scanGlobalNpm(),
    ]);
    return this.deduplicate(local, installed, globalNpm);
  }

  /**
   * Scan project-local node_modules for descriptor.json files.
   * @returns Discovered extensions from node_modules.
   */
  private async scanLocal(): Promise<DiscoveredExtension[]> {
    if (this.localNodeModulesDir === false) {
      return [];
    }
    const patterns = [
      path.join(this.localNodeModulesDir, '*/descriptor.json'),
      path.join(this.localNodeModulesDir, '@*/*/descriptor.json'),
    ];
    return this.scanPatterns(patterns, 'local');
  }

  /**
   * Scan the managed extensions directory for descriptor.json files.
   * @returns Discovered extensions from the managed install directory.
   */
  private async scanInstalled(): Promise<DiscoveredExtension[]> {
    if (this.extensionsDir === false) {
      return [];
    }
    const patterns = [
      path.join(this.extensionsDir, '*/descriptor.json'),
      path.join(this.extensionsDir, '@*/*/descriptor.json'),
    ];
    return this.scanPatterns(patterns, 'installed');
  }

  /**
   * Scan global npm node_modules for descriptor.json files.
   * @returns Discovered extensions from the global npm install directory.
   */
  private async scanGlobalNpm(): Promise<DiscoveredExtension[]> {
    if (this.nodeModulesDir === false) {
      return [];
    }
    const patterns = [
      path.join(this.nodeModulesDir, '*/descriptor.json'),
      path.join(this.nodeModulesDir, '@*/*/descriptor.json'),
    ];
    return this.scanPatterns(patterns, 'global-npm');
  }

  /**
   * Glob for descriptor.json files, parse and validate each.
   * Invalid descriptors are skipped with a warning.
   * @param patterns - Glob patterns to search.
   * @param source - The tier from which the results originate.
   * @returns List of successfully parsed and validated extensions.
   */
  private async scanPatterns(
    patterns: string[],
    source: DiscoveredExtension['source'],
  ): Promise<DiscoveredExtension[]> {
    const results: DiscoveredExtension[] = [];
    for (const pattern of patterns) {
      // Glob requires forward slashes even on Windows
      const normalizedPattern = pattern.split(path.sep).join('/');
      let matches: string[];
      try {
        matches = await glob(normalizedPattern, { nodir: true, windowsPathsNoEscape: true });
      } catch (err) {
        console.warn(
          `[extensions] Skipping scan for pattern ${normalizedPattern}:`,
          err instanceof Error ? err.message : err,
        );
        continue;
      }
      for (const descriptorPath of matches) {
        try {
          const raw = await fs.readFile(descriptorPath, 'utf-8');
          const json: unknown = JSON.parse(raw);
          const descriptor = parseExtensionDescriptor(json);
          const extensionPath = path.dirname(descriptorPath);
          results.push({
            descriptor,
            extensionPath,
            source,
          });
        } catch (err) {
          console.warn(
            `[extensions] Skipping invalid descriptor at ${descriptorPath}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    }
    return results;
  }

  /**
   * Deduplicate by descriptor name across priority tiers.
   *
   * Tiers are processed in priority order — earlier tiers win a cross-tier
   * name collision; a collision within one tier throws.
   * @param tiers - Extension arrays ordered by descending priority.
   * @returns Merged list with no duplicate names.
   * @throws ExtensionNameCollisionError when one tier declares the same descriptor name twice.
   */
  private deduplicate(...tiers: DiscoveredExtension[][]): DiscoveredExtension[] {
    return deduplicateByDescriptorName(tiers);
  }
}

/**
 * Returns a pre-defined list of extensions without filesystem scanning.
 *
 * Used by tests and host-owned discovery flows where filesystem scanning is
 * unavailable or undesirable.
 */
export class ExplicitDescriptorDiscovery implements ExtensionDiscovery {
  /**
   * @param extensions - Fixed list of extensions to return on every `discover()` call.
   */
  public constructor(private readonly extensions: DiscoveredExtension[]) {}

  /**
   * Return the fixed extension list provided at construction time.
   * @returns The extension list passed to the constructor.
   */
  public async discover(): Promise<DiscoveredExtension[]> {
    return this.extensions;
  }
}

/**
 * Two packages inside one discovery tier declare the same descriptor name.
 *
 * A descriptor name is an extension identity, and packages sitting side by side
 * in one tier have no precedence over each other, so there is no deterministic
 * winner to pick. Discovery refuses instead of loading an arbitrary copy, and
 * boot propagates this refusal rather than starting without extensions — see
 * {@link deduplicateByDescriptorName} for the full tier semantics.
 */
export class ExtensionNameCollisionError extends Error {
  /**
   * @param descriptorName - Descriptor name claimed by both packages.
   * @param claimed - Package that already claimed the name in this tier.
   * @param conflicting - Package that re-declared the already claimed name.
   */
  public constructor(
    public readonly descriptorName: string,
    claimed: DiscoveredExtension,
    conflicting: DiscoveredExtension,
  ) {
    super(
      `Extension name collision: "${descriptorName}" is declared by two packages in the same discovery tier ` +
        `(${describeProvenance(claimed)} and ${describeProvenance(conflicting)}). ` +
        'A descriptor name is an extension identity and cannot be shared, and packages within one tier ' +
        'have no precedence over each other. Remove or rename one of them.',
    );
    this.name = 'ExtensionNameCollisionError';
  }
}

/**
 * Merges multiple discovery strategies into one deduplicated result.
 *
 * Discoveries run concurrently via `Promise.all` and their results are
 * merged in constructor order. Each discovery is one precedence layer: earlier
 * discoveries win a name collision against later ones, which lets hosts layer
 * explicit descriptor sets without changing the existing tier semantics. A
 * name declared twice *by the same discovery* has no precedence to appeal to
 * and throws — see {@link deduplicateByDescriptorName}.
 */
export class MergedDescriptorDiscovery implements ExtensionDiscovery {
  /**
   * @param discoveries - Discovery strategies ordered by descending priority.
   */
  public constructor(private readonly discoveries: ReadonlyArray<ExtensionDiscovery>) {}

  /**
   * Run all discoveries and merge their results by descriptor name.
   * @returns Deduplicated list preserving the highest-precedence discovery's
   *   result for each name.
   * @throws ExtensionNameCollisionError when one discovery returns the same descriptor name twice.
   */
  public async discover(): Promise<DiscoveredExtension[]> {
    const discoveredTiers = await Promise.all(this.discoveries.map((discovery) => discovery.discover()));
    return deduplicateByDescriptorName(discoveredTiers);
  }
}

/**
 * Resolve descriptor-name collisions across discovery tiers.
 *
 * A descriptor name is an extension identity, so exactly one discovery may
 * hold it. Which discovery that is depends on where the collision happens:
 *
 * - **Across tiers** the answer is the declared tier precedence (local \>
 *   installed \> global-npm): the higher tier wins. The loser is not dropped
 *   silently — it is reported with both provenances so an operator can see
 *   which copy the runtime is actually going to load.
 * - **Within one tier** there is no precedence to appeal to. Two packages
 *   sitting side by side in the same directory claiming one identity have no
 *   deterministic winner — the order is whatever the filesystem returned — so
 *   this throws instead of picking one. The managed install paths already
 *   prevent this (a symlink install is keyed by descriptor name, and an npm
 *   install is refused when another npm package already claims the name); a
 *   collision here therefore means packages were placed by hand and the
 *   operator has to resolve the ambiguity.
 * @param tiers - Discovery tiers ordered from highest to lowest priority.
 * @returns Merged discoveries with the winning tier's descriptor kept per name.
 * @throws ExtensionNameCollisionError when one tier contains two descriptors declaring the same name.
 */
function deduplicateByDescriptorName(tiers: ReadonlyArray<ReadonlyArray<DiscoveredExtension>>): DiscoveredExtension[] {
  const byName = new Map<string, DiscoveredExtension>();
  for (const tier of tiers) {
    const claimedInTier = new Map<string, DiscoveredExtension>();
    for (const ext of tier) {
      const name = ext.descriptor.name;
      const sameTierClaim = claimedInTier.get(name);
      if (sameTierClaim !== undefined) {
        throw new ExtensionNameCollisionError(name, sameTierClaim, ext);
      }
      claimedInTier.set(name, ext);

      const winner = byName.get(name);
      if (winner !== undefined) {
        console.warn(
          `[extensions] Extension "${name}" is installed more than once: ` +
            `${describeProvenance(winner)} takes precedence over ${describeProvenance(ext)}, ` +
            'which is shadowed and will not be loaded.',
        );
        continue;
      }
      byName.set(name, ext);
    }
  }
  return [...byName.values()];
}

/**
 * Render a discovery's provenance for a collision diagnostic.
 * @param ext - Discovered extension to describe.
 * @returns Tier label and absolute package path.
 */
function describeProvenance(ext: DiscoveredExtension): string {
  return `${ext.source} at ${ext.extensionPath}`;
}

/**
 * Check whether a path exists and is a regular file.
 * @param filePath - Candidate file path.
 * @returns `true` when the path exists and is a regular file.
 */
async function isFile(filePath: string): Promise<boolean> {
  return fs
    .stat(filePath)
    .then((entry) => entry.isFile())
    .catch(() => false);
}
