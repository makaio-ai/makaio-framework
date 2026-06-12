/**
 * Verifies that the aggregated framework distribution contains every exported file.
 * @packageDocumentation
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join, relative, resolve, sep } from 'node:path';
import { normalizePackageExports, type PackageExportsField } from '../../build-tooling/package-exports.js';

/** A framework dist verification finding. */
export interface FrameworkDistIssue {
  /**
   * Exports-map key, dist import specifier, forbidden Postgres literal or SQL
   * marker, or migration chain directory the issue is about.
   */
  readonly exportKey: string;
  readonly kind:
    | 'export-target-not-file'
    | 'export-target-outside-root'
    | 'migration-journal-mismatch'
    | 'missing-export-target'
    | 'missing-migration-chain'
    | 'postgres-code-in-dist'
    | 'undeclared-dist-dependency'
    | 'unexported-dist-specifier';
  readonly message: string;
  readonly target: string;
}

/** Result returned by {@link verifyFrameworkDist}. */
export interface FrameworkDistResult {
  readonly checkedTargets: number;
  /** Number of built `.mjs` modules scanned for self-import specifiers. */
  readonly scannedModules: number;
  readonly issues: readonly FrameworkDistIssue[];
  readonly ok: boolean;
}

/**
 * Bundled migration chain directories every framework distribution must ship,
 * relative to the package root. The SQLite chain is the only chain bundled
 * with the framework distribution — engine packages (such as
 * `@makaio/storage-pg`) ship their own chains and resolve them through
 * `StorageEngine.migrations.resolveSourceChainDir`. Consumed at boot by the
 * bundled migrations lookup, so a missing chain only surfaces at a consumer's
 * first boot.
 */
export const BUNDLED_MIGRATION_CHAINS: readonly string[] = ['dist/drizzle'];

/**
 * Import specifiers that must never appear in built framework dist modules.
 *
 * The Postgres driver and engine ship exclusively with `@makaio/storage-pg`:
 * a `pg` or `drizzle-orm/node-postgres` import in the framework distribution
 * means engine code was inlined into the core artifact, and an
 * `@makaio/storage-pg` import means the core artifact hard-depends on the
 * optional engine package (sanctioned engine attachment is the registry plus
 * runtime resolution, never an import). `drizzle-orm/pg-core` is deliberately
 * NOT forbidden — hand-written Postgres twin schemas and the core-owned
 * column bundle (`./storage/drizzle/columns/postgres`) legitimately keep
 * pg-core column builders in the core artifact; they are schema declarations,
 * not driver or engine code. This allowance is safe only because framework
 * sources cannot reach pg-core THROUGH the engine package: a lint ban rejects
 * every `@makaio/storage-pg` import in framework code, and this specifier ban
 * backstops it at the artifact level.
 */
export const FORBIDDEN_DIST_IMPORT_SPECIFIERS: readonly string[] = [
  'pg',
  'drizzle-orm/node-postgres',
  '@makaio/storage-pg',
];

/**
 * Postgres-engine-exclusive SQL fragments that survive minification inside
 * template literals. Their presence in a built module means engine SQL was
 * inlined into the core artifact. Core sources mention these only in doc
 * comments, which minified `.mjs` output drops — if such a mention ever
 * survives into dist, reword the comment instead of weakening this check.
 */
export const FORBIDDEN_DIST_CONTENT_MARKERS: readonly string[] = ['pg_advisory_xact_lock', 'websearch_to_tsquery'];

/**
 * Matches forbidden specifiers appearing as quoted string literals anywhere
 * in built module content. This catches runtime-resolved driver loading
 * (e.g. `importRuntimeModule('pg')`) that defeats import-specifier scans,
 * even after a minifier renames the loading helper.
 *
 * `@makaio/storage-pg` is banned in import position but deliberately absent
 * here: the quoted literal is the sanctioned attachment mechanism — the
 * engine auto-resolve hint table and `importRuntimeModule`-based registration
 * carry it by design, and neither pulls engine code into the artifact.
 */
const POSTGRES_DIST_LITERAL_PATTERN = /['"`](pg|drizzle-orm\/node-postgres)['"`]/g;

/** An evidence-verified false positive of the quoted-literal scan. */
export interface PostgresLiteralAllowlistEntry {
  /** Built module path relative to the package root (e.g. `dist/core/index.mjs`). */
  readonly module: string;
  /** The exact literal text the entry allows (`pg` or `drizzle-orm/node-postgres`). */
  readonly literal: string;
}

/**
 * Allowlist for evidence-verified false positives of the quoted-literal scan.
 * Every entry MUST carry a justification comment proving the literal is not
 * runtime Postgres driver or engine code. Never widen this list to silence a
 * finding without that evidence — weaken nothing, reword the offending source
 * instead.
 */
export const POSTGRES_DIST_LITERAL_ALLOWLIST: readonly PostgresLiteralAllowlistEntry[] = [];

/** Options for {@link verifyFrameworkDist}. */
export interface VerifyFrameworkDistOptions {
  /**
   * Bundled migration chain directories (relative to the package root) that
   * must contain a `meta/_journal.json` whose entries each resolve to an
   * existing `<tag>.sql` file in the chain. Defaults to
   * {@link BUNDLED_MIGRATION_CHAINS}.
   */
  readonly migrationChains?: readonly string[];
}

type ExportValue = string | Readonly<Record<string, unknown>>;

interface FrameworkPackageManifest {
  dependencies?: Readonly<Record<string, string>>;
  exports?: PackageExportsField;
  optionalDependencies?: Readonly<Record<string, string>>;
  peerDependencies?: Readonly<Record<string, string>>;
}

/**
 * Reads and parses a JSON file.
 * @param filePath - Absolute path to the JSON file.
 * @returns Parsed content.
 */
function readJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

/**
 * Returns whether a value is a conditional export object.
 * @param value - Candidate export value.
 * @returns Whether the value can be recursively inspected for string targets.
 */
function isExportObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Collects all string file targets from a package export value.
 * @param value - Package export value or conditional export object.
 * @returns Local or external target strings referenced by the export value.
 */
function collectExportTargets(value: ExportValue): string[] {
  if (typeof value === 'string') return [value];

  const targets: string[] = [];
  for (const nestedValue of Object.values(value)) {
    if (typeof nestedValue === 'string') {
      targets.push(nestedValue);
    } else if (isExportObject(nestedValue)) {
      targets.push(...collectExportTargets(nestedValue));
    }
  }
  return targets;
}

/**
 * Returns whether the target is a local package file path.
 * @param target - Package export target.
 * @returns Whether the target should exist inside the framework package root.
 */
function isLocalFileTarget(target: string): boolean {
  return target.startsWith('.') && !target.includes('*');
}

/**
 * Verifies the integrity of the `@makaio/framework` distribution:
 *
 * 1. Every local exports-map target exists on disk inside the package root.
 * 2. Every `@makaio/framework/*` self-import specifier in built `dist/` modules
 *    resolves through the exports map (built entries resolve self-imports via
 *    the consumer's installed copy, so an unexported specifier crashes the
 *    importing entry at load time for every consumer).
 * 3. Every bare external package imported by built `dist/` modules is declared
 *    in the manifest's dependencies, peer dependencies, or optional
 *    dependencies. Node resolves bare externals from the consumer's install,
 *    so an undeclared one crashes the importing entry at load time.
 * 4. No built `dist/` module contains Postgres driver or engine code: `pg` /
 *    `drizzle-orm/node-postgres` / `@makaio/storage-pg` imports, quoted
 *    driver-loading literals that defeat import-specifier scans, or
 *    engine-exclusive SQL markers. The Postgres engine ships exclusively
 *    with `@makaio/storage-pg`.
 * 5. Every bundled migration chain ships with a journal that matches its
 *    `.sql` migration files.
 * @param frameworkRoot - Absolute path to the `@makaio/framework` package root.
 * @param options - Optional overrides for the verified migration chains.
 * @returns Verification result with all missing or unsafe targets.
 */
export function verifyFrameworkDist(
  frameworkRoot: string,
  options: VerifyFrameworkDistOptions = {},
): FrameworkDistResult {
  const root = resolve(frameworkRoot);
  const rootPrefix = `${root}${sep}`;
  const manifest = readJson(resolve(root, 'package.json')) as FrameworkPackageManifest;
  const exportsMap = normalizePackageExports(manifest.exports);
  const issues: FrameworkDistIssue[] = [];
  let checkedTargets = 0;

  for (const [exportKey, exportValue] of Object.entries(exportsMap)) {
    for (const target of collectExportTargets(exportValue)) {
      if (!isLocalFileTarget(target)) continue;

      checkedTargets += 1;
      const resolvedTarget = resolve(root, target);

      if (resolvedTarget !== root && !resolvedTarget.startsWith(rootPrefix)) {
        issues.push({
          exportKey,
          kind: 'export-target-outside-root',
          message: `Framework export "${exportKey}" targets a path outside the framework root: "${target}"`,
          target,
        });
        continue;
      }

      let stat: ReturnType<typeof statSync> | undefined;
      try {
        stat = statSync(resolvedTarget);
      } catch (error) {
        if (!isMissingPathError(error)) {
          throw error;
        }
        issues.push({
          exportKey,
          kind: 'missing-export-target',
          message: `Framework export "${exportKey}" points at missing built file "${target}"`,
          target,
        });
        continue;
      }

      if (!stat.isFile()) {
        issues.push({
          exportKey,
          kind: 'export-target-not-file',
          message: `Framework export "${exportKey}" points at a non-file target "${target}"`,
          target,
        });
      }
    }
  }

  const declaredDependencies = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ]);
  const scannedModules = checkDistImports(root, new Set(Object.keys(exportsMap)), declaredDependencies, issues);
  checkMigrationChains(root, options.migrationChains ?? BUNDLED_MIGRATION_CHAINS, issues);

  return { checkedTargets, scannedModules, issues, ok: issues.length === 0 };
}

/**
 * Matches static and dynamic import specifiers in built ESM output, including
 * the minified forms `from"…"`, `import"…"`, and `` import(`…`) ``. The
 * negative lookbehind skips method calls such as `Buffer.from("…")` in
 * inlined library code.
 */
const IMPORT_SPECIFIER_PATTERN = /(?<!\.)\b(?:from|import|require)\s*\(?\s*["'`]([^"'`\n]+)["'`]/g;

/** Node builtin module names importable without the `node:` prefix. */
const NODE_BUILTIN_MODULES: ReadonlySet<string> = new Set(builtinModules);

/**
 * Validates the package-name part of a bare specifier. Anything minification
 * noise produces (template fragments, code excerpts) fails this shape check.
 */
const BARE_PACKAGE_NAME_PATTERN = /^(@[a-z0-9~][\w.~-]*\/)?[a-z0-9~][\w.~-]*$/;

/**
 * Extracts the package name from a bare external import specifier.
 * @param specifier - Import specifier found in a built module.
 * @returns The package name, or `undefined` when the specifier is relative,
 * absolute, a runtime builtin, or not a valid package specifier.
 */
function toBarePackageName(specifier: string): string | undefined {
  if (specifier.startsWith('.') || specifier.startsWith('/')) return undefined;
  if (specifier.startsWith('node:') || specifier.startsWith('bun:')) return undefined;

  const segments = specifier.split('/');
  const packageName = specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0];
  if (!BARE_PACKAGE_NAME_PATTERN.test(packageName)) return undefined;
  if (NODE_BUILTIN_MODULES.has(packageName)) return undefined;
  return packageName;
}

/**
 * Scans built `dist/` modules for `@makaio/framework/*` self-import specifiers
 * that the exports map does not expose, for bare external imports that the
 * manifest does not declare, and for Postgres driver or engine code that must
 * ship exclusively with `@makaio/storage-pg`.
 * @param root - Absolute framework package root.
 * @param exportKeys - Normalized exports-map keys (e.g. `./storage/drizzle`).
 * @param declaredDependencies - Manifest-declared package names.
 * @param issues - Issue sink to append findings to.
 * @returns Number of `.mjs` modules scanned.
 */
function checkDistImports(
  root: string,
  exportKeys: ReadonlySet<string>,
  declaredDependencies: ReadonlySet<string>,
  issues: FrameworkDistIssue[],
): number {
  const distDir = resolve(root, 'dist');
  if (!existsSync(distDir)) return 0;

  let scannedModules = 0;
  const reported = new Set<string>();

  for (const modulePath of collectModuleFiles(distDir)) {
    scannedModules += 1;
    const content = readFileSync(modulePath, 'utf8');
    const moduleRelativePath = relative(root, modulePath);
    const reportedPostgresLiterals = new Set<string>();

    for (const match of content.matchAll(IMPORT_SPECIFIER_PATTERN)) {
      const specifier = match[1];
      if (specifier === '@makaio/framework' || specifier.startsWith('@makaio/framework/')) {
        checkSelfImport(specifier, exportKeys, reported, moduleRelativePath, issues);
        continue;
      }

      const forbidden = FORBIDDEN_DIST_IMPORT_SPECIFIERS.find(
        (name) => specifier === name || specifier.startsWith(`${name}/`),
      );
      if (forbidden !== undefined) {
        if (!reportedPostgresLiterals.has(forbidden)) {
          reportedPostgresLiterals.add(forbidden);
          issues.push({
            exportKey: forbidden,
            kind: 'postgres-code-in-dist',
            message:
              `Built module "${moduleRelativePath}" imports "${specifier}" — the Postgres driver and engine ` +
              'ship exclusively with @makaio/storage-pg, never inside the framework distribution',
            target: moduleRelativePath,
          });
        }
        continue;
      }

      const packageName = toBarePackageName(specifier);
      if (packageName === undefined || declaredDependencies.has(packageName) || reported.has(packageName)) continue;

      reported.add(packageName);
      issues.push({
        exportKey: packageName,
        kind: 'undeclared-dist-dependency',
        message:
          `Built module "${moduleRelativePath}" imports "${specifier}" but "${packageName}" is not ` +
          'declared in the framework manifest',
        target: moduleRelativePath,
      });
    }

    checkPostgresContent(content, moduleRelativePath, reportedPostgresLiterals, issues);
  }

  return scannedModules;
}

/**
 * Scans a built module's raw content for quoted Postgres driver literals and
 * engine-exclusive SQL markers.
 *
 * The quoted-literal scan defeats `importRuntimeModule('pg')`-style
 * indirection: the specifier never appears in import position, but the quoted
 * literal survives bundling and minification. The marker scan catches engine
 * SQL embedded in template literals the same way.
 * @param content - Raw `.mjs` module content.
 * @param moduleRelativePath - Module path relative to the package root.
 * @param reportedLiterals - Literals already reported for this module by the
 * import-specifier ban; shared so one offending specifier yields one issue.
 * @param issues - Issue sink to append findings to.
 */
function checkPostgresContent(
  content: string,
  moduleRelativePath: string,
  reportedLiterals: Set<string>,
  issues: FrameworkDistIssue[],
): void {
  for (const match of content.matchAll(POSTGRES_DIST_LITERAL_PATTERN)) {
    const literal = match[1];
    if (reportedLiterals.has(literal)) continue;
    if (
      POSTGRES_DIST_LITERAL_ALLOWLIST.some((entry) => entry.module === moduleRelativePath && entry.literal === literal)
    ) {
      continue;
    }

    reportedLiterals.add(literal);
    issues.push({
      exportKey: literal,
      kind: 'postgres-code-in-dist',
      message:
        `Built module "${moduleRelativePath}" contains the quoted literal "${literal}" — runtime-resolved ` +
        'Postgres driver loading must ship with @makaio/storage-pg, never inside the framework distribution',
      target: moduleRelativePath,
    });
  }

  for (const marker of FORBIDDEN_DIST_CONTENT_MARKERS) {
    if (!content.includes(marker)) continue;

    issues.push({
      exportKey: marker,
      kind: 'postgres-code-in-dist',
      message:
        `Built module "${moduleRelativePath}" contains the Postgres-only SQL marker "${marker}" — engine SQL ` +
        'ships exclusively with @makaio/storage-pg, never inside the framework distribution',
      target: moduleRelativePath,
    });
  }
}

/**
 * Reports a `@makaio/framework/*` self-import the exports map does not expose.
 * @param specifier - Self-import specifier found in a built module.
 * @param exportKeys - Normalized exports-map keys (e.g. `./storage/drizzle`).
 * @param reported - Deduplication sink shared across all scanned modules.
 * @param modulePath - Importing module path relative to the package root.
 * @param issues - Issue sink to append findings to.
 */
function checkSelfImport(
  specifier: string,
  exportKeys: ReadonlySet<string>,
  reported: Set<string>,
  modulePath: string,
  issues: FrameworkDistIssue[],
): void {
  const exportKey = specifier === '@makaio/framework' ? '.' : `./${specifier.slice('@makaio/framework/'.length)}`;
  if (exportKeys.has(exportKey) || reported.has(specifier)) return;

  reported.add(specifier);
  issues.push({
    exportKey,
    kind: 'unexported-dist-specifier',
    message: `Built module "${modulePath}" imports "${specifier}" but the exports map has no "${exportKey}" entry`,
    target: modulePath,
  });
}

/**
 * Recursively collects all built `.mjs` module files under a directory.
 * @param dir - Absolute directory to walk.
 * @returns Absolute paths of all `.mjs` files found.
 */
function collectModuleFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectModuleFiles(fullPath));
    } else if (entry.name.endsWith('.mjs')) {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * Verifies that each bundled migration chain ships a `meta/_journal.json`
 * whose entries resolve to the chain's `.sql` migration files.
 *
 * The runtime migration reader loads each journal entry from `<tag>.sql`, so
 * count parity alone can hide a renamed file: every entry must carry a `tag`
 * naming an existing `.sql` file, and the file count must still match the
 * entry count so stray migration files are reported as well.
 * @param root - Absolute framework package root.
 * @param migrationChains - Chain directories relative to the package root.
 * @param issues - Issue sink to append findings to.
 */
function checkMigrationChains(root: string, migrationChains: readonly string[], issues: FrameworkDistIssue[]): void {
  for (const chain of migrationChains) {
    const journalPath = resolve(root, chain, 'meta', '_journal.json');
    if (!existsSync(journalPath)) {
      issues.push({
        exportKey: chain,
        kind: 'missing-migration-chain',
        message: `Bundled migration chain "${chain}" is missing its journal "${chain}/meta/_journal.json"`,
        target: `${chain}/meta/_journal.json`,
      });
      continue;
    }

    const journal = readJson(journalPath) as { entries?: ReadonlyArray<{ readonly tag?: unknown }> };
    const entries = journal.entries ?? [];
    const sqlFiles = new Set(readdirSync(resolve(root, chain)).filter((name) => name.endsWith('.sql')));
    if (entries.length === 0 || entries.length !== sqlFiles.size) {
      issues.push({
        exportKey: chain,
        kind: 'migration-journal-mismatch',
        message: `Bundled migration chain "${chain}" has ${entries.length} journal entries but ${sqlFiles.size} .sql migration files`,
        target: `${chain}/meta/_journal.json`,
      });
    }

    entries.forEach((entry, index) => {
      if (typeof entry.tag !== 'string' || entry.tag === '') {
        issues.push({
          exportKey: chain,
          kind: 'migration-journal-mismatch',
          message: `Bundled migration chain "${chain}" journal entry #${index} has no "tag" naming its .sql file`,
          target: `${chain}/meta/_journal.json`,
        });
      } else if (!sqlFiles.has(`${entry.tag}.sql`)) {
        issues.push({
          exportKey: chain,
          kind: 'migration-journal-mismatch',
          message: `Bundled migration chain "${chain}" journal references "${entry.tag}" but "${chain}/${entry.tag}.sql" is missing`,
          target: `${chain}/${entry.tag}.sql`,
        });
      }
    });
  }
}

/**
 * Returns whether a filesystem error indicates a missing export target.
 * @param error - Error thrown while checking an export target.
 * @returns Whether the error should be reported as a missing built file.
 */
function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
