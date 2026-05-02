import type {
  ProtocolExportAuditCheckResult,
  ProtocolExportAuditIssue,
  ProtocolExportSubjectAudit,
  ProtocolNamespaceCatalog,
  ProtocolNamespaceCatalogEntry,
} from './types.js';
import { compareStrings } from './export-manifest-string-utils.js';

/**
 * Resolve the selected subject keys for a catalog entry.
 * @param entry - Protocol catalog entry to inspect
 * @returns Sorted subject keys selected by the catalog entry
 */
export function getCatalogSubjectKeys(entry: ProtocolNamespaceCatalogEntry): string[] {
  const keys = entry.subjects ?? Object.keys(entry.schemas);
  const seen = new Set<string>();

  for (const key of keys) {
    if (seen.has(key)) {
      throw new Error(`Duplicate protocol catalog subject for ${entry.namespace}: ${key}`);
    }
    seen.add(key);
  }

  return [...keys].sort(compareStrings);
}

/**
 * Build a namespace-keyed catalog map and reject duplicate entries.
 * @param catalog - Explicit publication catalog
 * @returns Catalog entries keyed by namespace
 */
export function getCatalogEntries(catalog: ProtocolNamespaceCatalog): Map<string, ProtocolNamespaceCatalogEntry> {
  const entries = new Map<string, ProtocolNamespaceCatalogEntry>();

  for (const entry of catalog) {
    if (entries.has(entry.namespace)) {
      throw new Error(`Duplicate protocol catalog namespace: ${entry.namespace}`);
    }

    entries.set(entry.namespace, entry);
  }

  return entries;
}

/**
 * Create a blocking audit issue for one selected subject.
 * @param namespace - Namespace selected by the catalog
 * @param subject - Subject key selected by the catalog
 * @param check - Audit check that failed
 * @param message - Failure message to report
 * @returns Structured protocol export audit issue
 */
export function createAuditIssue(
  namespace: string,
  subject: string,
  check: ProtocolExportAuditIssue['check'],
  message: string,
): ProtocolExportAuditIssue {
  return {
    namespace,
    subject,
    fullSubject: `${namespace}.${subject}`,
    check,
    message,
  };
}

/**
 * Create an audit entry for a selected subject.
 * @param namespace - Namespace selected by the catalog
 * @param subject - Subject key selected by the catalog
 * @param jsonSchema - JSON Schema export audit result
 * @param rustModel - Rust model generation audit result
 * @returns Per-subject protocol export audit result
 */
export function createSubjectAudit(
  namespace: string,
  subject: string,
  jsonSchema: ProtocolExportAuditCheckResult,
  rustModel: ProtocolExportAuditCheckResult,
): ProtocolExportSubjectAudit {
  return {
    namespace,
    subject,
    fullSubject: `${namespace}.${subject}`,
    jsonSchema,
    rustModel,
  };
}

/**
 * Format blocking audit issues for a thrown export error.
 * @param issues - Blocking audit issues to format
 * @returns Human-readable audit failure summary
 */
export function formatProtocolExportAuditIssues(issues: readonly ProtocolExportAuditIssue[]): string {
  const lines = issues.map((issue) => `- ${issue.fullSubject} [${issue.check}]: ${issue.message}`);
  return ['Protocol export audit failed:', ...lines].join('\n');
}
