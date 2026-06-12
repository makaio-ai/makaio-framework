/**
 * Generated-DDL parity validator (net 5).
 *
 * This is the fifth and last net guarding dialect parity of the central
 * storage schema, and the only one that reads the *generated SQL text* rather
 * than the TypeScript schema image:
 *
 * - net 2 (`schema-parity.test.ts`) compares the dual-table type images
 *   (column presence + type-image classes) via `getTableConfig`. It cannot see
 *   a divergence that survives the type image but emits different DDL — for
 *   example a partial-index twin that exists on one dialect only, or a
 *   hand-written SQL migration with no counterpart.
 * - net 4 (`discover-schemas.ts` strictness) guarantees every central package
 *   declares both dialect schema entries at *generation time*, so the barrels
 *   stay symmetric. It does not inspect the committed migration chains.
 *
 * Net 5 closes that gap: it compares the committed SQLite chain
 * (`framework/storage/migrations/drizzle`) against the committed Postgres chain
 * (`framework/storage/pg/drizzle-postgres`) at table, column, and index
 * granularity. Every (table, column) and every named index-like object
 * appearing in one chain must appear in the other, with identifiers normalized
 * to Postgres's 63-byte limit so a truncated Postgres identifier never
 * false-positives against its full-length SQLite sibling (the README documents
 * 63-byte truncation as an accepted invariant).
 *
 * Index parity treats the two dialects' equivalent emissions as the same
 * object: drizzle-kit emits a SQLite unique index as a standalone
 * `CREATE UNIQUE INDEX`, but folds the Postgres equivalent into a table-level
 * `CONSTRAINT <name> UNIQUE(...)` inside the `CREATE TABLE` body. The census
 * therefore harvests names from both `CREATE [UNIQUE] INDEX` statements and
 * table-level `CONSTRAINT ... UNIQUE` declarations, so a unique index named the
 * same way on both sides is matched regardless of which emission shape carries
 * it. A `CREATE INDEX` (or unique constraint) present in one chain only yields
 * a `missing-index` finding.
 *
 * Hand-written SQL — a migration whose contents are authored by hand rather
 * than emitted by drizzle-kit — is classified by an explicit curated set
 * ({@link HAND_WRITTEN_TAGS}), never by a heuristic on the SQL body. The single
 * known case is the Postgres-only `content_tsv` full-text column. Its columns
 * are exempt from the missing-column check when the other chain carries either a
 * same-stem `.sql` counterpart or a committed n/a marker
 * ({@link DDL_PARITY_NA_MARKER_SUFFIX}) documenting why no counterpart exists;
 * otherwise an `unpaired-handwritten-sql` finding is emitted.
 *
 * The validator reads only filesystem text (no database), so it is cheap
 * (sub-100ms) and runs in the `validate` chain right after the raw-SQL lint.
 * @packageDocumentation
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Which committed chain a finding belongs to. */
export type DdlParityChain = 'sqlite' | 'postgres';

/** A single generated-DDL parity discrepancy between the two chains. */
export interface DdlParityFinding {
  /** What kind of discrepancy was found. */
  readonly kind: 'missing-table' | 'missing-column' | 'missing-index' | 'unpaired-handwritten-sql';
  /** The chain that is missing the artifact, or that owns the unpaired SQL. */
  readonly chain: DdlParityChain;
  /** Human-readable detail naming the offending table/column/index or tag. */
  readonly detail: string;
}

/** Suffix marking a committed n/a marker that pairs with a hand-written tag stem. */
export const DDL_PARITY_NA_MARKER_SUFFIX = '.na.md';

/**
 * Curated set of hand-authored migration tags per chain.
 *
 * Hand-written migrations are classified by this explicit set, not by parsing
 * the SQL body: a body-level heuristic (e.g. "contains a generated column")
 * would silently reclassify a future drizzle-kit emission and let a real
 * divergence slip through. Seeded with the one known case: the Postgres-only
 * `content_tsv` tsvector column + GIN index, hand-authored because SQLite
 * full-text search is provisioned at runtime rather than through the chain.
 */
export const HAND_WRITTEN_TAGS: Readonly<Record<DdlParityChain, readonly string[]>> = {
  sqlite: [],
  postgres: ['0001_messages_content_tsv'],
};

/** Postgres truncates identifiers at 63 bytes; the comparison normalizes to that. */
const MAX_IDENTIFIER_BYTES = 63;

/**
 * Table-level entries inside a `CREATE TABLE (...)` body that are not columns.
 * Matched case-insensitively against the start of each top-level body segment.
 */
const TABLE_LEVEL_CONSTRAINT_KEYWORDS: readonly string[] = [
  'foreign key',
  'primary key',
  'constraint',
  'unique',
  'check',
];

/**
 * Truncate a SQL identifier to Postgres's 63-byte limit on a UTF-8 byte
 * boundary, so a multi-byte character is never cut mid-sequence.
 *
 * Identifiers within the limit are returned unchanged. Longer identifiers are
 * truncated to the most bytes that fit without splitting a UTF-8 code point —
 * the same rule Postgres applies — so a truncated Postgres identifier compares
 * equal to the prefix of its full-length SQLite sibling.
 * @param name - Raw identifier (already unquoted).
 * @returns The identifier truncated to at most 63 UTF-8 bytes.
 */
export function normalizeSqlIdentifier(name: string): string {
  const bytes = Buffer.from(name, 'utf8');
  if (bytes.length <= MAX_IDENTIFIER_BYTES) {
    return name;
  }
  // Truncate, then walk back off any UTF-8 continuation bytes (0b10xxxxxx) so
  // the cut never lands inside a multi-byte code point.
  let end = MAX_IDENTIFIER_BYTES;
  while (end > 0 && (bytes[end] & 0b1100_0000) === 0b1000_0000) {
    end -= 1;
  }
  return bytes.subarray(0, end).toString('utf8');
}

/**
 * A parsed migration chain: tag list plus the table/column and index censuses
 * the chain's DDL produces (after `__new_` recreate normalization and
 * identifier normalization).
 */
interface ParsedChain {
  /** Migration tags from the journal, in journal order. */
  readonly tags: readonly string[];
  /** Normalized table name -> set of normalized column names. */
  readonly tables: ReadonlyMap<string, ReadonlySet<string>>;
  /**
   * Set of normalized index-like object names: `CREATE [UNIQUE] INDEX` names
   * plus table-level `CONSTRAINT ... UNIQUE` names. Index names are globally
   * unique within a dialect, so the census is a flat name set rather than a
   * per-table map.
   */
  readonly indexes: ReadonlySet<string>;
  /** Normalized table name -> set of normalized columns introduced per hand-written tag. */
  readonly handWrittenColumns: ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<string>>>;
  /** Set of normalized index names introduced per hand-written tag. */
  readonly handWrittenIndexes: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * Strip a single layer of `` ` `` or `"` quoting from an identifier token.
 * @param token - Quoted identifier token (SQLite backticks or Postgres quotes).
 * @returns The identifier with its surrounding quote characters removed.
 */
const stripQuotes = (token: string): string => token.replace(/^["`]|["`]$/g, '');

/**
 * Get the column set stored under `key`, creating an empty one when absent.
 * @param map - Table-name -> column-set map to read or extend.
 * @param key - Table name whose column set is needed.
 * @returns The existing or newly-inserted column set for `key`.
 */
function getOrCreateColumnSet<K>(map: Map<K, Set<string>>, key: K): Set<string> {
  let columns = map.get(key);
  if (columns === undefined) {
    columns = new Set();
    map.set(key, columns);
  }
  return columns;
}

/** Match an identifier in either backtick (SQLite) or double-quote (Postgres) quoting. */
const QUOTED_IDENTIFIER = '(?:`[^`]+`|"[^"]+")';

/** `CREATE TABLE <id> (` capturing the (possibly `__new_`-prefixed) table name. */
const CREATE_TABLE = new RegExp(`CREATE\\s+TABLE\\s+(${QUOTED_IDENTIFIER})\\s*\\(`, 'gi');

/**
 * `ALTER TABLE <id> ADD [COLUMN] <col>` capturing table and column. The
 * negative lookahead for `CONSTRAINT` keeps FK/constraint additions (which add
 * no column) out of the column census.
 */
const ALTER_ADD_COLUMN = new RegExp(
  `ALTER\\s+TABLE\\s+(${QUOTED_IDENTIFIER})\\s+ADD\\s+(?!CONSTRAINT\\b)(?:COLUMN\\s+)?(${QUOTED_IDENTIFIER})`,
  'gi',
);

/** `CREATE [UNIQUE] INDEX <id>` capturing the index name (both dialects). */
const CREATE_INDEX = new RegExp(`CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(${QUOTED_IDENTIFIER})`, 'gi');

/**
 * `CONSTRAINT <id> UNIQUE` capturing a table-level unique-constraint name.
 * drizzle-kit folds a Postgres unique index into this form inside the
 * `CREATE TABLE` body, where SQLite emits a standalone `CREATE UNIQUE INDEX`;
 * harvesting both shapes lets the same-named object match across dialects.
 */
const UNIQUE_CONSTRAINT = new RegExp(`CONSTRAINT\\s+(${QUOTED_IDENTIFIER})\\s+UNIQUE\\b`, 'gi');

/**
 * Normalize a quoted, possibly `__new_`-prefixed table token to its canonical
 * comparison key. SQLite table-recreate migrations build a `__new_<table>`
 * shadow then `RENAME TO <table>`; the shadow carries the post-migration column
 * set, so collapsing the prefix attributes those columns to the real table.
 * @param token - Quoted table identifier as it appears in the DDL.
 * @returns Canonical normalized table name.
 */
function canonicalTableName(token: string): string {
  return normalizeSqlIdentifier(stripQuotes(token).replace(/^__new_/, ''));
}

/**
 * Extract column names from a `CREATE TABLE (...)` body, skipping table-level
 * constraint entries (FOREIGN KEY, PRIMARY KEY, CONSTRAINT, UNIQUE, CHECK).
 * @param body - Text between the table's outermost parentheses.
 * @returns Normalized column names declared in the body.
 */
function extractColumnsFromBody(body: string): string[] {
  const columns: string[] = [];
  let depth = 0;
  let segmentStart = 0;
  // Split on top-level commas only: nested parentheses (e.g. CHECK(...) or
  // numeric type widths) must not break a column definition into pieces.
  for (let i = 0; i <= body.length; i += 1) {
    const ch = body[i];
    if (ch === '(') {
      depth += 1;
    } else if (ch === ')') {
      depth -= 1;
    }
    const atBoundary = i === body.length || (ch === ',' && depth === 0);
    if (!atBoundary) {
      continue;
    }
    const segment = body.slice(segmentStart, i).trim();
    segmentStart = i + 1;
    if (segment.length === 0) {
      continue;
    }
    const lowered = segment.toLowerCase();
    if (TABLE_LEVEL_CONSTRAINT_KEYWORDS.some((keyword) => lowered.startsWith(keyword))) {
      continue;
    }
    const match = segment.match(new RegExp(`^(${QUOTED_IDENTIFIER})`));
    if (match) {
      columns.push(normalizeSqlIdentifier(stripQuotes(match[1])));
    }
  }
  return columns;
}

/**
 * Find the body of the `CREATE TABLE` whose opening parenthesis sits at
 * `openParenIndex`, by balancing parentheses.
 * @param sql - Full migration SQL text.
 * @param openParenIndex - Index of the opening `(` after the table name.
 * @returns The text between the matching parentheses, or `undefined` if unbalanced.
 */
function readBalancedBody(sql: string, openParenIndex: number): string | undefined {
  let depth = 0;
  for (let i = openParenIndex; i < sql.length; i += 1) {
    const ch = sql[i];
    if (ch === '(') {
      depth += 1;
    } else if (ch === ')') {
      depth -= 1;
      if (depth === 0) {
        return sql.slice(openParenIndex + 1, i);
      }
    }
  }
  return undefined;
}

/**
 * Accumulate every (table, column) a single migration's SQL produces into the
 * chain-wide maps.
 * @param sql - The migration's SQL text.
 * @param tables - Mutable canonical-table -> column-set accumulator.
 * @returns The table -> column-set map of *only this migration's* additions.
 */
function collectTablesAndColumns(sql: string, tables: Map<string, Set<string>>): Map<string, Set<string>> {
  const local = new Map<string, Set<string>>();
  /**
   * Record a column under both the chain-wide and migration-local maps.
   * @param table - Canonical table name.
   * @param column - Normalized column name.
   */
  const record = (table: string, column: string): void => {
    getOrCreateColumnSet(tables, table).add(column);
    getOrCreateColumnSet(local, table).add(column);
  };

  CREATE_TABLE.lastIndex = 0;
  for (let match = CREATE_TABLE.exec(sql); match !== null; match = CREATE_TABLE.exec(sql)) {
    const table = canonicalTableName(match[1]);
    const openParen = match.index + match[0].length - 1;
    const body = readBalancedBody(sql, openParen);
    if (body === undefined) {
      continue;
    }
    // Ensure the table is registered even if it has zero plain columns.
    getOrCreateColumnSet(tables, table);
    getOrCreateColumnSet(local, table);
    for (const column of extractColumnsFromBody(body)) {
      record(table, column);
    }
  }

  ALTER_ADD_COLUMN.lastIndex = 0;
  for (let match = ALTER_ADD_COLUMN.exec(sql); match !== null; match = ALTER_ADD_COLUMN.exec(sql)) {
    record(canonicalTableName(match[1]), normalizeSqlIdentifier(stripQuotes(match[2])));
  }

  return local;
}

/**
 * Accumulate every named index-like object a single migration's SQL produces
 * into the chain-wide index set.
 *
 * Harvests both standalone `CREATE [UNIQUE] INDEX <name>` statements and
 * table-level `CONSTRAINT <name> UNIQUE(...)` declarations so that a unique
 * index emitted as a constraint on one dialect matches the same-named standalone
 * index on the other.
 * @param sql - The migration's SQL text.
 * @param indexes - Mutable chain-wide normalized-index-name accumulator.
 * @returns The set of normalized index names *this migration* introduced.
 */
function collectIndexNames(sql: string, indexes: Set<string>): Set<string> {
  const local = new Set<string>();
  /**
   * Record an index name under both the chain-wide and migration-local sets.
   * @param name - Normalized index-like object name.
   */
  const record = (name: string): void => {
    indexes.add(name);
    local.add(name);
  };

  for (const pattern of [CREATE_INDEX, UNIQUE_CONSTRAINT]) {
    pattern.lastIndex = 0;
    for (let match = pattern.exec(sql); match !== null; match = pattern.exec(sql)) {
      record(normalizeSqlIdentifier(stripQuotes(match[1])));
    }
  }

  return local;
}

/**
 * Read a chain's journal tags, in journal order.
 * @param chainDir - Absolute path to the chain directory.
 * @returns The journal tags in order, or an empty array when the journal has no entries.
 */
const readJournalTags = (chainDir: string): string[] => {
  const journalPath = join(chainDir, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries?: { tag: string }[] };
  return (journal.entries ?? []).map((entry) => entry.tag);
};

/**
 * Parse one committed chain into its tag list, full table/column and index
 * censuses, and the per-hand-written-tag column/index additions.
 * @param chainDir - Absolute path to the chain directory.
 * @param chain - Which dialect chain this directory is.
 * @returns The parsed chain.
 */
function parseChain(chainDir: string, chain: DdlParityChain): ParsedChain {
  const tags = readJournalTags(chainDir);
  const tables = new Map<string, Set<string>>();
  const indexes = new Set<string>();
  const handWrittenTags = new Set(HAND_WRITTEN_TAGS[chain]);
  const handWrittenColumns = new Map<string, Map<string, Set<string>>>();
  const handWrittenIndexes = new Map<string, Set<string>>();

  for (const tag of tags) {
    const sqlPath = join(chainDir, `${tag}.sql`);
    if (!existsSync(sqlPath)) {
      continue;
    }
    const sql = readFileSync(sqlPath, 'utf8');
    const localColumns = collectTablesAndColumns(sql, tables);
    const localIndexes = collectIndexNames(sql, indexes);
    if (handWrittenTags.has(tag)) {
      const perTable = new Map<string, Set<string>>();
      for (const [table, columns] of localColumns) {
        perTable.set(table, new Set(columns));
      }
      handWrittenColumns.set(tag, perTable);
      handWrittenIndexes.set(tag, new Set(localIndexes));
    }
  }

  return { tags, tables, indexes, handWrittenColumns, handWrittenIndexes };
}

/**
 * Returns the stems (`<tag>` without extension) present in a chain dir as
 * either a `.sql` migration or a committed n/a marker. Used to decide whether a
 * hand-written tag in one chain has an accepted counterpart in the other.
 * @param chainDir - Absolute path to the chain directory.
 * @returns Set of stems carried by the chain dir's `.sql` and n/a-marker files.
 */
function readPairableStems(chainDir: string): Set<string> {
  const stems = new Set<string>();
  for (const entry of readdirSync(chainDir, { withFileTypes: true })) {
    if (!entry.isFile()) {
      continue;
    }
    if (entry.name.endsWith('.sql')) {
      stems.add(entry.name.slice(0, -'.sql'.length));
    } else if (entry.name.endsWith(DDL_PARITY_NA_MARKER_SUFFIX)) {
      stems.add(entry.name.slice(0, -DDL_PARITY_NA_MARKER_SUFFIX.length));
    }
  }
  return stems;
}

/**
 * Compute the set of (table, column) pairs introduced exclusively by a chain's
 * hand-written tags whose divergence is *accepted* — i.e. the other chain
 * carries a same-stem `.sql` or n/a marker. These pairs are excluded from the
 * missing-column comparison.
 * @param chain - Parsed chain that owns the hand-written tags.
 * @param otherStems - Pairable stems present in the other chain's dir.
 * @returns Map of canonical table -> accepted-exempt column set.
 */
function acceptedHandWrittenColumns(chain: ParsedChain, otherStems: ReadonlySet<string>): Map<string, Set<string>> {
  const exempt = new Map<string, Set<string>>();
  for (const [tag, perTable] of chain.handWrittenColumns) {
    if (!otherStems.has(tag)) {
      continue;
    }
    for (const [table, columns] of perTable) {
      const bucket = getOrCreateColumnSet(exempt, table);
      for (const column of columns) {
        bucket.add(column);
      }
    }
  }
  return exempt;
}

/**
 * Compute the set of index names introduced exclusively by a chain's
 * hand-written tags whose divergence is *accepted* — i.e. the other chain
 * carries a same-stem `.sql` or n/a marker. These names are excluded from the
 * missing-index comparison (e.g. the Postgres-only `idx_messages_content_tsv`
 * GIN index, paired with the SQLite n/a marker).
 * @param chain - Parsed chain that owns the hand-written tags.
 * @param otherStems - Pairable stems present in the other chain's dir.
 * @returns Set of accepted-exempt index names.
 */
function acceptedHandWrittenIndexes(chain: ParsedChain, otherStems: ReadonlySet<string>): Set<string> {
  const exempt = new Set<string>();
  for (const [tag, names] of chain.handWrittenIndexes) {
    if (!otherStems.has(tag)) {
      continue;
    }
    for (const name of names) {
      exempt.add(name);
    }
  }
  return exempt;
}

/**
 * Compare one chain against the other and collect findings for tables/columns
 * present in `source` but absent from `target`, skipping accepted hand-written
 * divergences.
 * @param source - Chain whose artifacts must appear in the target.
 * @param target - Chain that must contain the source's artifacts.
 * @param targetChain - Dialect of the target chain (the chain reported as missing).
 * @param exempt - Accepted hand-written (table -> columns) to skip.
 * @returns Findings naming each missing table/column on the target chain.
 */
function compareChain(
  source: ParsedChain,
  target: ParsedChain,
  targetChain: DdlParityChain,
  exempt: ReadonlyMap<string, ReadonlySet<string>>,
): DdlParityFinding[] {
  const findings: DdlParityFinding[] = [];
  for (const [table, columns] of source.tables) {
    const targetColumns = target.tables.get(table);
    if (targetColumns === undefined) {
      findings.push({ kind: 'missing-table', chain: targetChain, detail: table });
      continue;
    }
    const exemptColumns = exempt.get(table);
    for (const column of columns) {
      if (targetColumns.has(column) || exemptColumns?.has(column)) {
        continue;
      }
      findings.push({ kind: 'missing-column', chain: targetChain, detail: `${table}.${column}` });
    }
  }
  return findings;
}

/**
 * Compare the index census of `source` against `target` and collect findings
 * for index names present in `source` but absent from `target`, skipping
 * accepted hand-written divergences.
 * @param source - Chain whose index names must appear in the target.
 * @param target - Chain that must contain the source's index names.
 * @param targetChain - Dialect of the target chain (the chain reported as missing).
 * @param exempt - Accepted hand-written index names to skip.
 * @returns Findings naming each index missing on the target chain.
 */
function compareIndexes(
  source: ParsedChain,
  target: ParsedChain,
  targetChain: DdlParityChain,
  exempt: ReadonlySet<string>,
): DdlParityFinding[] {
  const findings: DdlParityFinding[] = [];
  for (const name of source.indexes) {
    if (target.indexes.has(name) || exempt.has(name)) {
      continue;
    }
    findings.push({ kind: 'missing-index', chain: targetChain, detail: name });
  }
  return findings;
}

/**
 * Emit `unpaired-handwritten-sql` findings for hand-written tags that have
 * neither a same-stem `.sql` counterpart nor an n/a marker in the other chain.
 * @param chain - Parsed chain that owns the hand-written tags.
 * @param ownChain - Dialect of the chain that owns the tags.
 * @param otherStems - Pairable stems present in the other chain's dir.
 * @returns Findings for each unpaired hand-written tag.
 */
function findUnpairedHandWritten(
  chain: ParsedChain,
  ownChain: DdlParityChain,
  otherStems: ReadonlySet<string>,
): DdlParityFinding[] {
  const findings: DdlParityFinding[] = [];
  for (const tag of HAND_WRITTEN_TAGS[ownChain]) {
    if (!chain.tags.includes(tag)) {
      continue;
    }
    if (!otherStems.has(tag)) {
      findings.push({
        kind: 'unpaired-handwritten-sql',
        chain: ownChain,
        detail: `${tag} has no same-stem counterpart or '${DDL_PARITY_NA_MARKER_SUFFIX}' marker in the other chain`,
      });
    }
  }
  return findings;
}

/**
 * Compare the committed SQLite and Postgres migration chains at table, column,
 * and index granularity and return every parity discrepancy.
 *
 * Identifiers are normalized to 63 UTF-8 bytes before comparison; SQLite
 * `__new_<table>` recreate shadows are folded onto their canonical table;
 * unique indexes are matched whether emitted as a standalone
 * `CREATE UNIQUE INDEX` (SQLite) or a table-level `CONSTRAINT ... UNIQUE`
 * (Postgres); accepted hand-written divergences (same-stem `.sql` or n/a marker
 * in the sibling chain) are excluded from the missing-column and missing-index
 * comparisons.
 * @param input - The two chain directories to compare.
 * @param input.sqliteChainDir - Absolute path to the SQLite chain dir.
 * @param input.postgresChainDir - Absolute path to the Postgres chain dir.
 * @returns All findings; an empty array means the chains are in parity.
 */
export function findDdlParityFindings(input: { sqliteChainDir: string; postgresChainDir: string }): DdlParityFinding[] {
  const sqlite = parseChain(input.sqliteChainDir, 'sqlite');
  const postgres = parseChain(input.postgresChainDir, 'postgres');
  const sqliteStems = readPairableStems(input.sqliteChainDir);
  const postgresStems = readPairableStems(input.postgresChainDir);

  const findings: DdlParityFinding[] = [];
  // Postgres artifacts must exist on the SQLite side, exempting Postgres
  // hand-written tags accepted by a SQLite-side counterpart/marker.
  findings.push(...compareChain(postgres, sqlite, 'sqlite', acceptedHandWrittenColumns(postgres, sqliteStems)));
  // SQLite artifacts must exist on the Postgres side, exempting SQLite
  // hand-written tags accepted by a Postgres-side counterpart/marker.
  findings.push(...compareChain(sqlite, postgres, 'postgres', acceptedHandWrittenColumns(sqlite, postgresStems)));
  // Index census parity, both directions, exempting accepted hand-written indexes.
  findings.push(...compareIndexes(postgres, sqlite, 'sqlite', acceptedHandWrittenIndexes(postgres, sqliteStems)));
  findings.push(...compareIndexes(sqlite, postgres, 'postgres', acceptedHandWrittenIndexes(sqlite, postgresStems)));
  // Hand-written tags with no accepted pairing in the sibling chain.
  findings.push(...findUnpairedHandWritten(postgres, 'postgres', sqliteStems));
  findings.push(...findUnpairedHandWritten(sqlite, 'sqlite', postgresStems));

  return findings;
}
