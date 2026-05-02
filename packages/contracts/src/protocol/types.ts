import type { SchemaRecord } from '@makaio/core';

/** JSON object used for embedded JSON Schema documents. */
export type JsonObject = Record<string, unknown>;

/** Protocol manifest emitted for language-specific SDK generation. */
export interface MakaioProtocolManifest {
  /** Manifest format version. */
  version: 1;
  /** Published bus subjects selected by the protocol catalog. */
  subjects: MakaioProtocolSubject[];
}

/** Shared fields for every published protocol subject. */
export interface MakaioProtocolSubjectBase {
  /** Namespace passed to `registerNamespace()`. */
  namespace: string;
  /** Subject key inside the namespace. */
  subject: string;
  /** Fully-qualified subject key in `namespace.subject` form. */
  fullSubject: string;
  /** Whether the subject is local-only in the TypeScript bus. */
  local: boolean;
  /** Whether the subject is channel-only in the TypeScript bus. */
  channel: boolean;
}

/** Published fire-and-forget event subject. */
export interface MakaioProtocolEventSubject extends MakaioProtocolSubjectBase {
  /** Subject kind discriminator. */
  kind: 'event';
  /** JSON Schema for the event payload. */
  payloadSchema: JsonObject;
}

/** Published request/response subject. */
export interface MakaioProtocolRequestSubject extends MakaioProtocolSubjectBase {
  /** Subject kind discriminator. */
  kind: 'request';
  /** JSON Schema for the request payload. */
  requestSchema: JsonObject;
  /** JSON Schema for the response payload. */
  responseSchema: JsonObject;
}

/** One published protocol subject entry. */
export type MakaioProtocolSubject = MakaioProtocolEventSubject | MakaioProtocolRequestSubject;

/** Status for one protocol export audit check. */
export type ProtocolExportAuditStatus = 'passed' | 'failed' | 'skipped';

/** One protocol export audit check result. */
export interface ProtocolExportAuditCheckResult {
  /** Audit check status. */
  status: ProtocolExportAuditStatus;
  /** Human-readable detail for failed or skipped checks. */
  message?: string;
}

/** One failed protocol export audit check. */
export interface ProtocolExportAuditIssue {
  /** Namespace passed to `registerNamespace()`. */
  namespace: string;
  /** Subject key inside the namespace. */
  subject: string;
  /** Fully-qualified subject key in `namespace.subject` form. */
  fullSubject: string;
  /** Audit check that produced the issue. */
  check: 'jsonSchema' | 'rustModel';
  /** Failure message for the selected subject. */
  message: string;
}

/** Per-subject protocol export audit result. */
export interface ProtocolExportSubjectAudit {
  /** Namespace passed to `registerNamespace()`. */
  namespace: string;
  /** Subject key inside the namespace. */
  subject: string;
  /** Fully-qualified subject key in `namespace.subject` form. */
  fullSubject: string;
  /** JSON Schema export representability result. */
  jsonSchema: ProtocolExportAuditCheckResult;
  /** Rust model generation representability result. */
  rustModel: ProtocolExportAuditCheckResult;
}

/** Structured protocol export audit report. */
export interface ProtocolExportAuditReport {
  /** Per-subject audit results for the selected catalog. */
  subjects: ProtocolExportSubjectAudit[];
  /** Failed audit checks that should block manifest export. */
  issues: ProtocolExportAuditIssue[];
}

/** Checks whether a manifest subject can be represented as generated Rust structs. */
export type RustModelRepresentabilityChecker = (subject: MakaioProtocolSubject) => ProtocolExportAuditCheckResult;

/** Options for protocol manifest export and audit. */
export interface ProtocolExportOptions {
  /**
   * Optional explicit catalog. When omitted, auto-discovers all registered subjects
   * and silently skips those that cannot be exported (non-blocking mode).
   */
  catalog?: ProtocolNamespaceCatalog;
  /** Optional override for the built-in Rust model representability checker. */
  rustModelChecker?: RustModelRepresentabilityChecker;
}

/** Catalog entry selecting one namespace for protocol publication. */
export interface ProtocolNamespaceCatalogEntry {
  /** Registered namespace to publish from. */
  namespace: string;
  /** Source schemas owned by `@makaio/contracts`. */
  schemas: SchemaRecord;
  /** Optional named subset of schema keys to publish. */
  subjects?: readonly string[];
}

/** Explicit publication policy for protocol manifest generation. */
export type ProtocolNamespaceCatalog = readonly ProtocolNamespaceCatalogEntry[];
