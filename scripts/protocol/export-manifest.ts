import type { RegisteredSubjectSchema } from '@makaio/bus-core';
import { inspectSubjectSchema, isRequestSchema } from '@makaio/core';
import type {
  MakaioProtocolEventSubject,
  MakaioProtocolManifest,
  MakaioProtocolRequestSubject,
  MakaioProtocolSubject,
  ProtocolExportAuditCheckResult,
  ProtocolExportAuditIssue,
  ProtocolExportAuditReport,
  ProtocolExportOptions,
  ProtocolExportSubjectAudit,
  ProtocolNamespaceCatalog,
  ProtocolNamespaceCatalogEntry,
} from '../../core/contracts/src/protocol/types.js';
import {
  createAuditIssue,
  createSubjectAudit,
  formatProtocolExportAuditIssues,
  getCatalogEntries,
  getCatalogSubjectKeys,
} from '../../core/contracts/src/protocol/export-manifest-audit-utils.js';
import { defaultRustModelChecker } from '../../core/contracts/src/protocol/export-manifest-rust-checker.js';
import { toManifestJsonSchema } from '../../core/contracts/src/protocol/export-manifest-json-utils.js';
import { compareStrings } from '../../core/contracts/src/protocol/export-manifest-string-utils.js';

export { defaultRustModelChecker };

const MANIFEST_VERSION = 2;

/**
 * Input of a protocol export: either an explicit publication catalog (catalog mode) or the list of
 * subjects registered on a runtime bus (auto-discovery mode). The caller obtains the list at a place
 * that may read the namespace registry; the export itself never reads a bus.
 */
export type ProtocolExportSource =
  | { readonly catalog: ProtocolNamespaceCatalog }
  | { readonly registeredSubjects: readonly RegisteredSubjectSchema[] };

/**
 * Internal protocol export collection used to share one catalog pass between audit and manifest generation.
 */
interface ProtocolExportCollection {
  /** Structured audit report for the selected catalog. */
  audit: ProtocolExportAuditReport;
  /** Exported manifest subjects built while auditing. */
  subjects: MakaioProtocolSubject[];
}

/**
 * Format an unknown thrown value as an audit message.
 * @param error - Thrown value to format
 * @returns Human-readable error message
 */
function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Read the runtime namespace registry as a subject lookup table.
 * @returns Registered subject metadata keyed by fully-qualified subject
 */
/**
 * Convert one registered subject into a manifest subject entry.
 * @param subject - Registered subject metadata to export
 * @returns Manifest subject entry with JSON Schema payloads
 */
function exportRegisteredSubject(subject: RegisteredSubjectSchema): MakaioProtocolSubject {
  const base = {
    namespace: subject.namespace,
    subject: subject.subject,
    fullSubject: subject.fullSubject,
    local: subject.local,
    channel: subject.channel,
  };

  if (isRequestSchema(subject.schema)) {
    return {
      kind: 'request',
      ...base,
      requestSchema: toManifestJsonSchema(subject.namespace, subject.subject, subject.schema.request),
      responseSchema: toManifestJsonSchema(subject.namespace, subject.subject, subject.schema.response),
    } satisfies MakaioProtocolRequestSubject;
  }

  return {
    kind: 'event',
    ...base,
    payloadSchema: toManifestJsonSchema(subject.namespace, subject.subject, subject.schema),
  } satisfies MakaioProtocolEventSubject;
}

/**
 * Resolve a cataloged subject into exportable metadata, unwrapping any
 * journal and routing wrappers through a single inspection.
 * @param catalogEntry - Catalog entry that selected the subject
 * @param subject - Subject key to resolve
 * @returns Runtime metadata for the selected subject
 */
function resolveCatalogSubject(catalogEntry: ProtocolNamespaceCatalogEntry, subject: string): RegisteredSubjectSchema {
  if (!(subject in catalogEntry.schemas)) {
    throw new Error(`Protocol catalog selected ${catalogEntry.namespace}.${subject}, but no catalog schema exists`);
  }

  const fullSubject = `${catalogEntry.namespace}.${subject}`;
  const schema = catalogEntry.schemas[subject];
  const { schema: baseSchema, marks } = inspectSubjectSchema(schema);

  return {
    namespace: catalogEntry.namespace,
    subject,
    fullSubject,
    schema: baseSchema,
    local: marks.local,
    collectorOnly: marks.collectorOnly,
    channel: marks.channel,
    hostLocalRequest: marks.hostLocalRequest,
  };
}

/**
 * Run the Rust representability checker and normalize thrown errors.
 * @param subject - Manifest subject to check for Rust model generation
 * @param options - Protocol export options
 * @returns Rust model generation audit result
 */
function checkRustModelRepresentability(
  subject: MakaioProtocolSubject,
  options: ProtocolExportOptions,
): ProtocolExportAuditCheckResult {
  const checker = options.rustModelChecker ?? defaultRustModelChecker;

  try {
    return checker(subject);
  } catch (error) {
    return {
      status: 'failed',
      message: getErrorMessage(error),
    };
  }
}

/**
 * Run an audit in auto-discovery mode: iterate all registered subjects, silently skip
 * those that fail JSON Schema export or Rust representability, and return a non-blocking
 * report (the `issues` array is always empty in this mode).
 * @param allSubjects - Registered subjects to inspect
 * @param options - Protocol export options
 * @returns Audit report with all subjects recorded and an empty issues array
 */
function auditAutoDiscovery(
  allSubjects: readonly RegisteredSubjectSchema[],
  options: ProtocolExportOptions,
): ProtocolExportAuditReport {
  const subjects: ProtocolExportSubjectAudit[] = [];

  for (const registered of allSubjects) {
    let exportedSubject: MakaioProtocolSubject;

    try {
      exportedSubject = exportRegisteredSubject(registered);
    } catch (error) {
      const message = getErrorMessage(error);
      subjects.push(
        createSubjectAudit(
          registered.namespace,
          registered.subject,
          { status: 'failed', message },
          { status: 'skipped', message: 'Skipped because JSON Schema export failed' },
        ),
      );
      continue;
    }

    const rustModel = checkRustModelRepresentability(exportedSubject, options);
    subjects.push(createSubjectAudit(registered.namespace, registered.subject, { status: 'passed' }, rustModel));
  }

  return { subjects, issues: [] };
}

/**
 * Collect exported subjects and audit results from an explicit protocol catalog.
 *
 * Performs a single pass over the catalog entries, exporting each subject and recording both
 * the audit result and the manifest-ready subject in one traversal.
 * @param catalog - Namespace catalog that selects which subjects to collect
 * @param options - Protocol export options
 * @returns Internal export collection with manifest subjects and a blocking audit report
 */
function collectCatalogExport(
  catalog: ProtocolNamespaceCatalog,
  options: ProtocolExportOptions,
): ProtocolExportCollection {
  const catalogEntries = getCatalogEntries(catalog);
  const auditSubjects: ProtocolExportSubjectAudit[] = [];
  const manifestSubjects: MakaioProtocolSubject[] = [];
  const issues: ProtocolExportAuditIssue[] = [];

  for (const catalogEntry of [...catalogEntries.values()].sort((left, right) =>
    compareStrings(left.namespace, right.namespace),
  )) {
    for (const subject of getCatalogSubjectKeys(catalogEntry)) {
      let exportedSubject: MakaioProtocolSubject;

      try {
        exportedSubject = exportRegisteredSubject(resolveCatalogSubject(catalogEntry, subject));
      } catch (error) {
        const message = getErrorMessage(error);
        issues.push(createAuditIssue(catalogEntry.namespace, subject, 'jsonSchema', message));
        auditSubjects.push(
          createSubjectAudit(
            catalogEntry.namespace,
            subject,
            { status: 'failed', message },
            { status: 'skipped', message: 'Skipped because JSON Schema export failed' },
          ),
        );
        continue;
      }

      const rustModel = checkRustModelRepresentability(exportedSubject, options);
      auditSubjects.push(createSubjectAudit(catalogEntry.namespace, subject, { status: 'passed' }, rustModel));
      manifestSubjects.push(exportedSubject);

      if (rustModel.status === 'failed') {
        issues.push(
          createAuditIssue(
            catalogEntry.namespace,
            subject,
            'rustModel',
            rustModel.message ?? 'Rust model generation cannot represent this subject',
          ),
        );
      }
    }
  }

  return {
    audit: {
      subjects: auditSubjects,
      issues,
    },
    subjects: manifestSubjects,
  };
}

/**
 * Audit the protocol export pipeline before publishing a manifest.
 *
 * When `source` carries a `catalog` the audit runs in **catalog mode**: every selected
 * subject must export cleanly, and failures are recorded as blocking issues.
 *
 * When `source` carries `registeredSubjects` the audit runs in **auto-discovery mode**: all
 * listed subjects are inspected, subjects that cannot be exported are silently skipped, and
 * the returned `issues` array is always empty.
 * @param source - Catalog or registered subjects to audit
 * @param options - Optional representability check hooks
 * @returns Structured audit report with per-subject results and (catalog mode only) blocking issues
 */
export function auditProtocolExport(
  source: ProtocolExportSource,
  options: ProtocolExportOptions = {},
): ProtocolExportAuditReport {
  if ('catalog' in source) {
    return collectCatalogExport(source.catalog, options).audit;
  }

  return auditAutoDiscovery(source.registeredSubjects, options);
}

/**
 * Export a deterministic protocol manifest.
 *
 * When `source` carries a `catalog` the export runs in **catalog mode**: all selected
 * subjects must export without error; any blocking issue throws immediately.
 *
 * When `source` carries `registeredSubjects` the export runs in **auto-discovery mode**: all
 * listed subjects are inspected, and only those that pass both JSON Schema export and Rust
 * representability checks are included in the manifest.
 * @param source - Catalog or registered subjects to export
 * @param options - Optional representability check hooks
 * @returns Serializable Makaio protocol manifest sorted by fully-qualified subject key
 */
export function exportProtocolManifest(
  source: ProtocolExportSource,
  options: ProtocolExportOptions = {},
): MakaioProtocolManifest {
  if ('catalog' in source) {
    return exportCatalogManifest(source.catalog, options);
  }

  return exportAutoDiscoveryManifest(source.registeredSubjects, options);
}

/**
 * Export a manifest from an explicit publication catalog, throwing on any blocking issue.
 * @param catalog - Namespace catalog selecting which registered subjects to publish
 * @param options - Protocol export options
 * @returns Serializable Makaio protocol manifest
 */
function exportCatalogManifest(
  catalog: ProtocolNamespaceCatalog,
  options: ProtocolExportOptions,
): MakaioProtocolManifest {
  const { audit, subjects } = collectCatalogExport(catalog, options);
  if (audit.issues.length > 0) {
    throw new Error(formatProtocolExportAuditIssues(audit.issues));
  }

  subjects.sort((left, right) => compareStrings(left.fullSubject, right.fullSubject));

  return { version: MANIFEST_VERSION, subjects };
}

/**
 * Export a manifest from all registered subjects, silently skipping those that fail.
 * @param allSubjects - Registered subjects to export
 * @param options - Protocol export options
 * @returns Serializable Makaio protocol manifest containing only successfully exported subjects
 */
function exportAutoDiscoveryManifest(
  allSubjects: readonly RegisteredSubjectSchema[],
  options: ProtocolExportOptions,
): MakaioProtocolManifest {
  const subjects: MakaioProtocolSubject[] = [];

  for (const registered of allSubjects) {
    let exportedSubject: MakaioProtocolSubject;

    try {
      exportedSubject = exportRegisteredSubject(registered);
    } catch {
      continue;
    }

    const rustModel = checkRustModelRepresentability(exportedSubject, options);
    if (rustModel.status !== 'failed') {
      subjects.push(exportedSubject);
    }
  }

  subjects.sort((left, right) => compareStrings(left.fullSubject, right.fullSubject));

  return { version: MANIFEST_VERSION, subjects };
}

/**
 * Format a protocol manifest for deterministic committed output.
 * @param manifest - Protocol manifest to format
 * @returns Stable JSON string with a trailing newline
 */
export function formatProtocolManifest(manifest: MakaioProtocolManifest): string {
  return JSON.stringify(manifest, null, 2) + '\n';
}
