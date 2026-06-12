/**
 * Environment variable resolution for the conformance harness.
 *
 * Selects the active dialect from `MAKAIO_STORAGE_TEST_DIALECT` and resolves
 * the corresponding {@link StorageConformanceConfig}. Suite files use
 * {@link describeStorageConformance} as their single entry point so dialect
 * selection and config resolution happen exactly once per process.
 * @packageDocumentation
 */
import { describe } from 'vitest';
import type { StorageConformanceConfig } from './config.js';
import { createSqliteConfig } from './sqlite-config.js';
import { createPostgresConfig } from './postgres-config.js';

/** Selects the active dialect. Valid values: 'sqlite' (default) | 'postgres'. */
export const STORAGE_TEST_DIALECT_ENV = 'MAKAIO_STORAGE_TEST_DIALECT';

/** Postgres connection URL consumed when the postgres dialect is selected. */
export const STORAGE_TEST_URL_ENV = 'MAKAIO_STORAGE_TEST_URL';

/**
 * Resolve the active conformance config from the environment.
 * - unset/'sqlite' → sqlite config (temp-file database, no external service).
 * - 'postgres' + MAKAIO_STORAGE_TEST_URL set → postgres config.
 * - 'postgres' + URL missing + process.env.CI set → THROWS (misconfigured CI must never go green).
 * - 'postgres' + URL missing locally → writes one clearly visible notice to stderr
 *   (mentions the env var name and the README docker one-liner) and returns null.
 * - any other dialect value → throws.
 * @returns Active config, or null when postgres was selected but no URL is available locally.
 */
export function resolveStorageConformanceConfig(): StorageConformanceConfig | null {
  const dialect = process.env[STORAGE_TEST_DIALECT_ENV] ?? 'sqlite';

  if (dialect === 'sqlite') {
    const config = createSqliteConfig();
    console.info(`[storage-conformance] dialect=${config.name}`);
    return config;
  }

  if (dialect === 'postgres') {
    const url = process.env[STORAGE_TEST_URL_ENV];

    if (!url) {
      // Deliberate: CI here also covers the repository test wrapper, which
      // forces CI=true for non-interactive reporting. When a developer
      // explicitly selects the postgres dialect under `yarn test`, failing
      // fast with instructions beats silently skipping every suite. The skip
      // path below serves bare vitest invocations (IDE runners, `yarn vitest`)
      // that leave CI unset.
      if (process.env.CI) {
        throw new Error(
          `[storage-conformance] ${STORAGE_TEST_DIALECT_ENV}=postgres but ${STORAGE_TEST_URL_ENV} is not set ` +
            `while CI is set in the environment — refusing to skip the Postgres suites silently. ` +
            `(Note: \`yarn test\` runs with CI semantics; the repository test wrapper sets CI for non-interactive output.) ` +
            `Set ${STORAGE_TEST_URL_ENV}=<connection-url> or unset ${STORAGE_TEST_DIALECT_ENV} to run the SQLite default.`,
        );
      }

      // Write directly to stderr: the test reporter suppresses console output
      // by default, and this notice must never be silent — it is the only
      // explanation for an otherwise empty (all-skipped) run.
      process.stderr.write(
        `[storage-conformance] ${STORAGE_TEST_DIALECT_ENV}=postgres but ${STORAGE_TEST_URL_ENV} is not set — ` +
          `skipping Postgres conformance suites. ` +
          `To run against a local Postgres server, set ${STORAGE_TEST_URL_ENV} and re-run the tests. ` +
          `Quick start: docker run --rm -d --name makaio-storage-pg ` +
          `-e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=makaio_storage_conformance ` +
          `-p 5432:5432 postgres:18-alpine ` +
          `(see storage/conformance/README.md for details)\n`,
      );
      return null;
    }

    const config = createPostgresConfig(url);
    console.info(`[storage-conformance] dialect=${config.name}`);
    return config;
  }

  throw new Error(
    `[storage-conformance] Unknown ${STORAGE_TEST_DIALECT_ENV} value '${dialect}'. ` +
      `Valid values are: 'sqlite', 'postgres'.`,
  );
}

/** Cached config resolved once per process. */
let cachedConfig: StorageConformanceConfig | null | undefined;

/**
 * Return the active conformance config, resolving from the environment on first call.
 *
 * Result is cached so that the warn / info lines appear exactly once even when
 * many suite files are collected in the same process.
 * @returns Active config, or null when postgres was requested but no URL is available locally.
 */
function getConfig(): StorageConformanceConfig | null {
  if (cachedConfig === undefined) {
    cachedConfig = resolveStorageConformanceConfig();
  }
  return cachedConfig;
}

/**
 * Suite entry point used by EVERY conformance suite file.
 * Resolves the config once; when null, registers `describe.skip` with the skip
 * reason appended to the title; otherwise registers a describe block titled
 * "title [config.name]" and invokes `suite(config)`.
 * @param title - Human-readable suite title.
 * @param suite - Suite body receiving the resolved config.
 */
export function describeStorageConformance(title: string, suite: (config: StorageConformanceConfig) => void): void {
  const config = getConfig();

  if (config === null) {
    describe.skip(`${title} [postgres — skipped: ${STORAGE_TEST_URL_ENV} not set]`, () => {
      // No cases registered; describe.skip marks the entire suite.
    });
    return;
  }

  describe(`${title} [${config.name}]`, () => {
    suite(config);
  });
}
