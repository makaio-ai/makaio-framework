/**
 * Schema discovery for Drizzle migrations.
 *
 * Scans workspace packages for makaio.drizzleSchema declarations and resolves
 * them to absolute paths for aggregated schema generation.
 */
import fs from 'node:fs';
import path from 'node:path';
import { discoverWorkspacePackageJsonPaths, parseWorkspaceGlobs } from '@makaio/utils/workspace-packages';
import type { StorageDialect } from '@makaio/storage-drizzle';

/**
 * A discovered schema file from a workspace package.
 */
export interface DiscoveredSchema {
  /** Package name (e.g., "\@makaio/services/session") */
  packageName: string;
  /** Absolute path to the schema file */
  schemaPath: string;
}

/**
 * Shape of the `makaio.drizzleSchema` package.json field.
 *
 * - Legacy forms (bare string or string array) mean sqlite-only and remain
 *   supported for backward compatibility.
 * - Object form declares both dialect lists explicitly and is required for
 *   central-tier packages that participate in the Postgres chain.
 */
export type DrizzleSchemaDeclaration =
  | string
  | string[]
  | { readonly sqlite?: string | string[]; readonly postgres?: string | string[] };

/**
 * Resolve workspace package globs from the root package.json.
 * @param workspaceRoot - Absolute path to the workspace root directory
 * @returns Array of workspace glob patterns
 * @throws Error if no workspaces are defined
 */
function resolveWorkspacePatterns(workspaceRoot: string): string[] {
  const rootPackagePath = path.resolve(workspaceRoot, 'package.json');
  const rootPackageRaw = fs.readFileSync(rootPackagePath, 'utf-8');
  const rootPackage = JSON.parse(rootPackageRaw) as unknown;
  const workspaces = parseWorkspaceGlobs(rootPackage);

  if (workspaces.length > 0) {
    return [...workspaces];
  }

  throw new Error(`No workspaces defined in ${rootPackagePath}`);
}

/**
 * Normalise a declaration field value to a string array.
 * `undefined` yields an empty array.
 * @param value - Raw field value from package.json.
 * @returns Normalised array of paths.
 */
function toStringArray(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Discover all Drizzle schema files declared in workspace packages.
 *
 * Scans package.json files in the workspace for `makaio.drizzleSchema` fields,
 * resolves relative paths to absolute paths, and validates that files exist.
 *
 * Legacy forms (bare string or string array) are treated as sqlite-only
 * declarations and remain fully supported.
 *
 * Object form `{ sqlite, postgres }` allows a package to declare both dialect
 * chains at once. The following invariants are enforced on every run:
 *
 * - A package declaring only `postgres` entries (and zero `sqlite` entries) is
 *   a declaration error because SQLite is the baseline dialect.
 * - Every declared path in **both** dialect lists is existence-checked
 *   regardless of the requested dialect.
 *
 * When `dialect` is `'postgres'`, any package that has SQLite entries but zero
 *   Postgres entries triggers a generation-time strictness error — all
 *   central-tier packages must declare Postgres twins before the Postgres chain
 *   can be generated.
 * @param workspaceRoot - Absolute path to the workspace root directory.
 * @param patterns - Optional workspace glob patterns override. When provided,
 *   these patterns are used instead of the patterns from the root package.json
 *   workspaces field.
 * @param dialect - Storage dialect to discover entries for. Defaults to
 *   `'sqlite'`. Legacy forms are always interpreted as sqlite-only.
 * @returns Sorted array of discovered schemas (sorted by package name then path
 *   for deterministic output).
 * @throws Error if a declared schema file does not exist.
 * @throws Error if `patterns` is provided as an empty array.
 * @throws Error if a package declares `postgres` entries but no `sqlite`
 *   entries (declaration error, every dialect run).
 * @throws Error if `dialect` is `'postgres'` and any package has `sqlite`
 *   entries but zero `postgres` entries (generation-time strictness).
 */
export async function discoverSchemas(
  workspaceRoot: string,
  patterns?: string[],
  dialect: StorageDialect = 'sqlite',
): Promise<DiscoveredSchema[]> {
  if (patterns && patterns.length === 0) {
    throw new Error('discoverSchemas: patterns override must contain at least one glob');
  }
  const workspacePatterns = patterns ?? resolveWorkspacePatterns(workspaceRoot);

  const packageJsonPaths = await discoverWorkspacePackageJsonPaths(workspaceRoot, {
    patterns: workspacePatterns,
  });

  const discovered: DiscoveredSchema[] = [];

  for (const pkgPath of packageJsonPaths) {
    const pkgContent = fs.readFileSync(pkgPath, 'utf-8');
    const pkg = JSON.parse(pkgContent) as {
      name?: string;
      makaio?: {
        drizzleSchema?: DrizzleSchemaDeclaration;
      };
    };

    if (!pkg.name || !pkg.makaio?.drizzleSchema) {
      continue;
    }

    const packageName = pkg.name;
    const packageDir = path.dirname(pkgPath);
    const declaration = pkg.makaio.drizzleSchema;

    // Normalise to { sqlite, postgres } for uniform handling.
    // Legacy forms (string | string[]) map to sqlite-only.
    let sqlitePaths: string[];
    let postgresPaths: string[];

    if (typeof declaration === 'string' || Array.isArray(declaration)) {
      // Legacy form — sqlite-only, no postgres entries.
      sqlitePaths = toStringArray(declaration);
      postgresPaths = [];
    } else {
      // Object form.
      sqlitePaths = toStringArray(declaration.sqlite);
      postgresPaths = toStringArray(declaration.postgres);
    }

    // Declaration error (every dialect run): postgres entries without sqlite entries.
    if (postgresPaths.length > 0 && sqlitePaths.length === 0) {
      throw new Error(
        `Package "${packageName}" declares makaio.drizzleSchema with 'postgres' entries but no 'sqlite' entries. ` +
          `SQLite is the baseline dialect; declare the sqlite schema files as well.`,
      );
    }

    // Generation-time strictness (postgres run only): sqlite entries with no postgres entries.
    if (dialect === 'postgres' && sqlitePaths.length > 0 && postgresPaths.length === 0) {
      throw new Error(
        `Package "${packageName}" declares makaio.drizzleSchema without a 'postgres' entry. ` +
          `Central-tier schema packages must declare Postgres twins ({ "sqlite": [...], "postgres": [...] }) ` +
          `before the postgres chain can be generated.`,
      );
    }

    // Existence-check EVERY declared path in BOTH dialect lists, regardless of
    // the requested dialect. A missing postgres twin file fails even the sqlite run.
    const allDeclaredPaths = [...sqlitePaths, ...postgresPaths];
    for (const schemaPath of allDeclaredPaths) {
      const absolutePath = path.resolve(packageDir, schemaPath);

      if (!fs.existsSync(absolutePath)) {
        throw new Error(
          `Schema file not found: ${absolutePath}\n` +
            `Declared in ${packageName} (${pkgPath})\n` +
            `Relative path: ${schemaPath}`,
        );
      }
    }

    // Return only the requested dialect's entries.
    const dialectPaths = dialect === 'postgres' ? postgresPaths : sqlitePaths;
    for (const schemaPath of dialectPaths) {
      const absolutePath = path.resolve(packageDir, schemaPath);
      discovered.push({ packageName, schemaPath: absolutePath });
    }
  }

  // Sort by package name + schema path for deterministic output
  return discovered.sort((a, b) => {
    const byPackage = a.packageName.localeCompare(b.packageName);
    return byPackage !== 0 ? byPackage : a.schemaPath.localeCompare(b.schemaPath);
  });
}
