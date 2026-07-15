import type {
  ArtifactKindRegistration,
  ArtifactRelation,
  ArtifactRevision,
  ArtifactViewEvidenceSection,
  ArtifactViewLevel,
  ArtifactViewModel,
  ArtifactViewPropertiesSection,
  ArtifactViewRawSection,
  ArtifactViewRelationsSection,
  ArtifactViewSection,
  ArtifactViewTableSection,
  ProjectedField,
} from '@makaio/contracts';
import { isRecord } from '@makaio/utils';

/**
 * Monotonic version stamp for the generic artifact view builder.
 *
 * Consumers may assert this value to detect structural changes in the
 * generic projection algorithm across framework versions.
 */
export const GENERIC_ARTIFACT_VIEW_BUILDER_VERSION = 1;

/* -------------------------------------------------------------------------- */
/*  Level ranking                                                             */
/* -------------------------------------------------------------------------- */

const LEVEL_RANK: Readonly<Record<ArtifactViewLevel, number>> = {
  link: 0,
  summary: 1,
  full: 2,
};

/**
 * Determine whether a projected field is visible at a given request level.
 *
 * Levels order monotonically: `link < summary < full`. A field declared at
 * `link` is visible at every level; a field declared at `full` appears only
 * when the full view is requested. Omitted `fromLevel` defaults to `full`.
 * @param field - The projected field declaration.
 * @param requestLevel - The requested view detail level.
 * @returns `true` if the field is visible at the requested level.
 */
function isFieldVisibleAtLevel(field: ProjectedField, requestLevel: ArtifactViewLevel): boolean {
  const fieldLevel = field.fromLevel ?? 'full';
  return LEVEL_RANK[requestLevel] >= LEVEL_RANK[fieldLevel];
}

/* -------------------------------------------------------------------------- */
/*  Dot-path access                                                           */
/* -------------------------------------------------------------------------- */

/** Sentinel indicating a path segment could not be resolved. */
const MISSING = Symbol('MISSING');

/**
 * Resolve a dot-separated path against a data record.
 *
 * Returns the value at the path, or the {@link MISSING} sentinel when any
 * segment along the path cannot be traversed.
 * @param data - The root data object.
 * @param path - Dot-separated path string (e.g. `'metadata.priority'`).
 * @returns The resolved value, or `MISSING` if the path does not exist.
 */
function resolveDotPath(data: Record<string, unknown>, path: string): unknown | typeof MISSING {
  // This intentionally does not use bus-core's getPath: projection distinguishes
  // missing segments from present `undefined` and allows only own object/array
  // properties, preventing inherited data from becoming view content.
  const segments = path.split('.');
  let current: unknown = data;

  for (const segment of segments) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return MISSING;
    }
    if (!Object.prototype.hasOwnProperty.call(current, segment)) {
      return MISSING;
    }
    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

/* -------------------------------------------------------------------------- */
/*  Scalar classification                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Determine whether a value is a JSON scalar (string, number, boolean, null).
 * @param value - The value to classify.
 * @returns `true` if the value is a scalar JSON value.
 */
function isScalar(value: unknown): boolean {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/**
 * Determine whether every value of a record is a scalar JSON value.
 *
 * Missing keys and `undefined` are not checked — only present values must be
 * scalar. `null` counts as scalar.
 * @param record - The record to check.
 * @returns `true` if every value in the record is a scalar.
 */
function hasOnlyScalarValues(record: Record<string, unknown>): boolean {
  for (const value of Object.values(record)) {
    if (value !== undefined && !isScalar(value)) {
      return false;
    }
  }
  return true;
}

/**
 * Classify an array for section mapping.
 *
 * - An empty array is classified as `'scalar-array'`.
 * - An array where every element is a scalar is `'scalar-array'`.
 * - An array where every element is a non-null record **and** every value of
 *   every record is a scalar JSON value is `'record-array'`. Records with
 *   nested objects or arrays are not table candidates.
 * - Anything else (mixed records/scalars, records with non-scalar values) is
 *   `'heterogeneous'`.
 * @param arr - The array to classify.
 * @returns The classification string.
 */
function classifyArray(arr: unknown[]): 'scalar-array' | 'record-array' | 'heterogeneous' {
  if (arr.length === 0) {
    return 'scalar-array';
  }

  let allScalars = true;
  let allRecords = true;

  for (const item of arr) {
    if (!isScalar(item)) {
      allScalars = false;
    }
    if (!isRecord(item) || !hasOnlyScalarValues(item)) {
      allRecords = false;
    }
  }

  if (allScalars) return 'scalar-array';
  if (allRecords) return 'record-array';
  return 'heterogeneous';
}

/* -------------------------------------------------------------------------- */
/*  Label humanization                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Extract the last segment of a dot-separated path and humanize it.
 *
 * Splits on `.`, takes the last segment, then applies the following
 * transformations:
 * 1. Split on camelCase boundaries (`createdBy` -\> `created By`)
 * 2. Split on `-` and `_` separators
 * 3. Title-case each word
 * @param path - A dot-separated path string.
 * @returns A human-readable label.
 */
function humanizeLabel(path: string): string {
  const segments = path.split('.');
  const lastSegment = segments[segments.length - 1]!;

  // Split camelCase, then kebab/snake separators
  const words = lastSegment
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());

  return words.join(' ');
}

/* -------------------------------------------------------------------------- */
/*  Scalar stringification                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Convert a scalar value to its string representation for display.
 * @param value - A scalar value (string, number, boolean, or null).
 * @returns The string representation.
 */
function scalarToString(value: unknown): string {
  if (value === null) return 'null';
  return String(value);
}

/* -------------------------------------------------------------------------- */
/*  Table column collection (first-seen order)                                */
/* -------------------------------------------------------------------------- */

/**
 * Collect the union of all record keys across an array of records,
 * preserving first-seen insertion order.
 * @param records - Array of record objects.
 * @returns Ordered array of unique column keys in first-seen order.
 */
function collectFirstSeenColumns(records: Record<string, unknown>[]): string[] {
  const seen = new Set<string>();
  const columns: string[] = [];

  for (const record of records) {
    for (const key of Object.keys(record)) {
      if (!seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
    }
  }

  return columns;
}

/* -------------------------------------------------------------------------- */
/*  Semantic role resolution                                                  */
/* -------------------------------------------------------------------------- */

/** First projected field declared for each semantic role. */
interface SemanticRoleFields {
  readonly titleField: ProjectedField | undefined;
  readonly summaryField: ProjectedField | undefined;
}

/**
 * Locate the projected fields that declare semantic view roles.
 * @param fields - Array of projected fields to search.
 * @returns The first field for each role, or `undefined` when no field declares it.
 */
function findRoleFields(fields: readonly ProjectedField[]): SemanticRoleFields {
  let titleField: ProjectedField | undefined;
  let summaryField: ProjectedField | undefined;

  for (const field of fields) {
    if (field.viewRole === 'title' && titleField === undefined) {
      titleField = field;
    } else if (field.viewRole === 'summary' && summaryField === undefined) {
      summaryField = field;
    }

    if (titleField !== undefined && summaryField !== undefined) {
      break;
    }
  }

  return { titleField, summaryField };
}

/**
 * Determine whether a value is a usable scalar for semantic title or summary.
 *
 * A usable scalar is a non-null, non-empty string, a number, or a boolean.
 * @param value - The value to test.
 * @returns `true` if the value can be used as display text.
 */
function isUsableScalar(value: unknown): boolean {
  if (typeof value === 'string') return value.length > 0;
  if (typeof value === 'number' || typeof value === 'boolean') return true;
  return false;
}

/**
 * Resolve the semantic title for the artifact view.
 *
 * Resolution order:
 * 1. If a projected field declares `viewRole: 'title'` and its `fromLevel`
 *    threshold is at or below the requested level, resolve its path and use
 *    the value if it is a usable scalar.
 * 2. Otherwise, fall back to `[<kind>] <id>`.
 *
 * Level filtering applies uniformly to role fields: a title declared
 * `fromLevel: 'full'` (the default when omitted) is suppressed at `link`
 * or `summary` level.
 * @param revision - The artifact revision.
 * @param titleField - Declared title role field, if any.
 * @param level - The requested view detail level.
 * @returns The resolved title string.
 */
function resolveTitle(
  revision: ArtifactRevision,
  titleField: ProjectedField | undefined,
  level: ArtifactViewLevel,
): string {
  if (titleField && isFieldVisibleAtLevel(titleField, level)) {
    const value = resolveDotPath(revision.data, titleField.path);
    if (value !== MISSING && isUsableScalar(value)) {
      return String(value);
    }
  }
  // representations.summary remains summary-only; kind registrations own
  // semantic titles by declaring a projected field with viewRole: 'title'.
  return `[${revision.kind}] ${revision.id}`;
}

/**
 * Resolve the semantic summary for the artifact view.
 *
 * Resolution order:
 * 1. If a projected field declares `viewRole: 'summary'` and its `fromLevel`
 *    threshold is at or below the requested level, resolve its path and use
 *    the value if it is a usable scalar.
 * 2. Otherwise, use `representations.summary` if present.
 * 3. Otherwise, return `undefined`.
 *
 * Level filtering applies uniformly to role fields: a summary declared
 * `fromLevel: 'full'` (the default when omitted) is suppressed at `link`
 * or `summary` level.
 * @param revision - The artifact revision.
 * @param summaryField - Declared summary role field, if any.
 * @param level - The requested view detail level.
 * @returns The resolved summary string, or `undefined`.
 */
function resolveSummary(
  revision: ArtifactRevision,
  summaryField: ProjectedField | undefined,
  level: ArtifactViewLevel,
): string | undefined {
  if (summaryField && isFieldVisibleAtLevel(summaryField, level)) {
    const value = resolveDotPath(revision.data, summaryField.path);
    if (value !== MISSING && isUsableScalar(value)) {
      return String(value);
    }
  }

  const repSummary = revision.representations?.summary;
  if (repSummary && repSummary.length > 0) {
    return repSummary;
  }

  return undefined;
}

/* -------------------------------------------------------------------------- */
/*  Section mapping                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Classify a resolved field value and create the appropriate view section
 * entry, or contribute to the shared properties section.
 *
 * - Scalars and scalar arrays contribute rows to the `propertiesRows` accumulator.
 * - Non-empty arrays of records become table sections.
 * - Objects and heterogeneous arrays become raw sections.
 * - Missing values produce nothing.
 * @param field - The projected field declaration.
 * @param value - The resolved value from artifact data.
 * @param propertiesRows - Accumulator for property rows (mutated in place).
 * @param sections - Accumulator for non-property sections (mutated in place).
 */
function mapFieldToSection(
  field: ProjectedField,
  value: unknown,
  propertiesRows: Array<{ label: string; value: string }>,
  sections: ArtifactViewSection[],
): void {
  const label = humanizeLabel(field.path);

  if (isScalar(value)) {
    propertiesRows.push({ label, value: scalarToString(value) });
    return;
  }

  if (Array.isArray(value)) {
    const classification = classifyArray(value);

    if (classification === 'scalar-array') {
      propertiesRows.push({
        label,
        value: value.map(scalarToString).join(', '),
      });
      return;
    }

    if (classification === 'record-array') {
      const records = value as Record<string, unknown>[];
      const columnKeys = collectFirstSeenColumns(records);
      const columns = columnKeys.map(humanizeLabel);

      const rows = records.map((record) => ({
        cells: columnKeys.map((key) => {
          const cellVal = record[key];
          return cellVal !== undefined && cellVal !== null ? scalarToString(cellVal) : '';
        }),
      }));

      const tableSection: ArtifactViewTableSection = {
        type: 'table',
        title: label,
        columns,
        rows,
      };
      sections.push(tableSection);
      return;
    }

    // heterogeneous array — deep-copy to prevent aliasing artifact.data
    const rawSection: ArtifactViewRawSection = {
      type: 'raw',
      title: label,
      json: structuredClone(value) as unknown[],
    };
    sections.push(rawSection);
    return;
  }

  // plain object — deep-copy to prevent aliasing artifact.data
  if (isRecord(value)) {
    const rawSection: ArtifactViewRawSection = {
      type: 'raw',
      title: label,
      json: structuredClone(value),
    };
    sections.push(rawSection);
    return;
  }
}

/* -------------------------------------------------------------------------- */
/*  Relation section building                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Build a relations section from the artifact's direct relations.
 *
 * Only artifact-class relations (refClass `'artifact'`) are included.
 * Relations are grouped by type.
 * @param relations - The artifact's typed relations.
 * @returns A relations section, or `undefined` if there are no artifact relations.
 */
function buildRelationsSection(relations: readonly ArtifactRelation[]): ArtifactViewRelationsSection | undefined {
  const groupMap = new Map<string, Array<{ artifactId?: string; url?: string; label: string }>>();

  for (const relation of relations) {
    if (relation.target.refClass !== 'artifact') continue;

    const target = relation.target;
    const items = groupMap.get(relation.type) ?? [];
    items.push({
      artifactId: target.id,
      label: `[${target.kind}] ${target.id}`,
    });
    groupMap.set(relation.type, items);
  }

  if (groupMap.size === 0) return undefined;

  const groups = [...groupMap.entries()].map(([type, items]) => ({
    type,
    items,
  }));

  return {
    type: 'relations',
    title: 'Relations',
    groups,
  };
}

/* -------------------------------------------------------------------------- */
/*  Evidence section building                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Build an evidence section from the artifact's confidence basis.
 *
 * Only basis entries with an `evidenceRef` whose refClass is `'evidence'`
 * contribute items.
 * @param revision - The artifact revision.
 * @returns An evidence section, or `undefined` if there are no evidence refs.
 */
function buildEvidenceSection(revision: ArtifactRevision): ArtifactViewEvidenceSection | undefined {
  if (!revision.confidence?.basis) return undefined;

  const items: ArtifactViewEvidenceSection['items'] = [];

  for (const basis of revision.confidence.basis) {
    const ref = basis.evidenceRef;
    if (ref?.refClass !== 'evidence') continue;

    items.push({
      kind: ref.kind,
      id: ref.id,
      ...(ref.locator ? { locator: ref.locator } : {}),
    });
  }

  if (items.length === 0) return undefined;

  return {
    type: 'evidence',
    title: 'Evidence',
    items,
  };
}

/* -------------------------------------------------------------------------- */
/*  Public API                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Build a deterministic, provider-neutral artifact view model using generic
 * projection rules.
 *
 * This builder is the framework's generic fallback when no kind-specific
 * builder is registered. It projects declared fields from the artifact's
 * `data` payload into typed view sections following a fixed classification
 * algorithm:
 *
 * - Scalars and scalar arrays become property rows in a single properties section.
 * - Non-empty arrays where every entry is a record become table sections.
 * - Objects and heterogeneous arrays become field-scoped raw sections.
 * - Missing paths are silently skipped (no fabricated values).
 * - Undeclared fields are never exposed (no whole-data fallback).
 *
 * Semantic title and summary are resolved from role-declared projected fields
 * first, then from fallback sources (kind/id for title, representations.summary
 * for summary).
 *
 * Relation and evidence sections are included only at `full` level.
 * Navigation is always empty: the generic builder never interprets
 * default context graphs to generate breadcrumbs.
 * @param revision - The complete artifact revision to project.
 * @param registration - The kind registration providing projection declarations.
 * @param level - The requested view detail level.
 * @returns A deterministic {@link ArtifactViewModel}.
 */
export function buildGenericArtifactView(
  revision: ArtifactRevision,
  registration: ArtifactKindRegistration,
  level: ArtifactViewLevel,
): ArtifactViewModel {
  const projectedFields = registration.projection?.projectedFields ?? [];
  const { titleField, summaryField } = findRoleFields(projectedFields);

  // Resolve semantic title and summary (level-filtered)
  const title = resolveTitle(revision, titleField, level);
  const summary = resolveSummary(revision, summaryField, level);

  // Identify role-consumed fields so they are not duplicated as properties
  const consumedRolePaths = new Set<string>();
  if (titleField) consumedRolePaths.add(titleField.path);
  if (summaryField) consumedRolePaths.add(summaryField.path);

  // Map fields to sections
  const propertiesRows: Array<{ label: string; value: string }> = [];
  const fieldSections: ArtifactViewSection[] = [];

  for (const field of projectedFields) {
    // Skip role-consumed fields
    if (consumedRolePaths.has(field.path)) continue;

    // Skip fields below the requested level
    if (!isFieldVisibleAtLevel(field, level)) continue;

    // Resolve value
    const value = resolveDotPath(revision.data, field.path);
    if (value === MISSING) continue;

    mapFieldToSection(field, value, propertiesRows, fieldSections);
  }

  // Build sections array
  const sections: ArtifactViewSection[] = [];

  // Properties section (consolidated)
  if (propertiesRows.length > 0) {
    const propsSection: ArtifactViewPropertiesSection = {
      type: 'properties',
      title: 'Properties',
      rows: propertiesRows,
    };
    sections.push(propsSection);
  }

  // Table and raw sections in declaration order
  sections.push(...fieldSections);

  // Relation and evidence sections only at full level
  if (level === 'full') {
    const relationsSection = buildRelationsSection(revision.relations);
    if (relationsSection) {
      sections.push(relationsSection);
    }

    const evidenceSection = buildEvidenceSection(revision);
    if (evidenceSection) {
      sections.push(evidenceSection);
    }
  }

  return {
    title,
    ...(summary !== undefined ? { summary } : {}),
    sections,
  };
}
