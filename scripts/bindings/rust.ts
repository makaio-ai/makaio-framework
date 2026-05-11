import { readFile, writeFile } from 'node:fs/promises';
import type { MakaioProtocolManifest, MakaioProtocolSubject } from '../../packages/contracts/src/protocol/types.js';
import { RUST_SUBJECTS_PATH } from '../lib/sdk-generation-paths.js';
import { rustSubjectPayloadType } from './rust-payloads.js';

/**
 * Rust reserved keywords and strict keywords that cannot be used as bare identifiers.
 * When a namespace name collides, the generated module uses the raw identifier syntax `r#name`.
 * @see https://doc.rust-lang.org/reference/keywords.html
 */
const RUST_KEYWORDS = new Set([
  'abstract',
  'as',
  'async',
  'await',
  'become',
  'box',
  'break',
  'const',
  'continue',
  'crate',
  'do',
  'dyn',
  'else',
  'enum',
  'extern',
  'false',
  'final',
  'fn',
  'for',
  'gen',
  'if',
  'impl',
  'in',
  'let',
  'loop',
  'macro',
  'match',
  'mod',
  'move',
  'mut',
  'override',
  'priv',
  'pub',
  'ref',
  'return',
  'self',
  'Self',
  'static',
  'struct',
  'super',
  'trait',
  'true',
  'try',
  'type',
  'typeof',
  'union',
  'unsafe',
  'unsized',
  'use',
  'virtual',
  'where',
  'while',
  'yield',
]);

/**
 * Explicit marker comment before the generated Rust section.
 */
const GENERATED_SECTION_START_MARKER = '// <generated-subjects>';

/**
 * Explicit marker comment after the generated Rust section.
 *
 * Everything after this line is hand-authored and must be preserved across codegen runs.
 */
const GENERATED_SECTION_END_MARKER = '// </generated-subjects>';

/**
 * Convert a subject string (without namespace prefix) to a Rust SCREAMING_SNAKE_CASE constant name.
 *
 * The algorithm is:
 * 1. Replace every `.` with `_`
 * 2. Insert `_` before each uppercase letter
 * 3. Uppercase the entire string
 * @param subject - Subject key inside a namespace, e.g. `contextWindow.updated`
 * @returns SCREAMING_SNAKE_CASE constant name, e.g. `CONTEXT_WINDOW_UPDATED`
 */
export function toRustConstantName(subject: string): string {
  return subject
    .replace(/\./g, '_')
    .replace(/([A-Z])/g, '_$1')
    .toUpperCase()
    .replace(/^_/, '');
}

/**
 * Convert a subject string to a Rust PascalCase zero-sized subject type name.
 * @param subject - Subject key inside a namespace, e.g. `contextWindow.updated`
 * @returns PascalCase type name, e.g. `ContextWindowUpdated`
 */
function toRustSubjectTypeName(subject: string): string {
  return toRustConstantName(subject)
    .split('_')
    .filter((part) => part.length > 0)
    .map((part) => part[0]!.toUpperCase() + part.slice(1).toLowerCase())
    .join('');
}

/**
 * Convert a namespace string to a valid Rust module name.
 *
 * Namespaces may contain `:` (e.g. `storage:adapter`) and `-` (e.g. `account-manager`), neither of
 * which is valid in a Rust identifier.  The mapping is:
 * - `:` → `__` (double underscore, to distinguish `storage:adapter` from a hypothetical
 *   `storage_adapter` namespace)
 * - `.` → `__` (double underscore, same rationale — e.g. `typeview:indexer`)
 * - `-` → `_`
 * - camelCase → snake_case (e.g. `agentRuntime` → `agent_runtime`)
 * - Rust keywords → `r#` prefix (e.g. `loop` → `r#loop`)
 * @param namespace - Raw namespace string, e.g. `storage:adapter`, `typeview:indexer`, or `agentRuntime`
 * @returns Valid Rust snake_case module identifier, e.g. `storage__adapter`, `typeview__indexer`, or `agent_runtime`
 */
export function toRustModuleName(namespace: string): string {
  const sanitized = namespace
    .replace(/[:.]/g, '__')
    .replace(/-/g, '_')
    .replace(/([A-Z])/g, '_$1')
    .toLowerCase();
  return RUST_KEYWORDS.has(sanitized) ? `r#${sanitized}` : sanitized;
}

/**
 * Map a protocol subject kind to its Rust `SubjectKind` variant name.
 * @param kind - Protocol subject kind discriminator
 * @returns Rust enum variant name
 */
function toSubjectKindVariant(kind: MakaioProtocolSubject['kind']): string {
  return kind === 'event' ? 'Event' : 'Request';
}

/**
 * Group subjects by namespace, preserving the sorted order within each group.
 * @param subjects - Protocol subjects sorted by fullSubject
 * @returns Map of namespace to subjects in that namespace
 */
function groupByNamespace(subjects: MakaioProtocolSubject[]): Map<string, MakaioProtocolSubject[]> {
  const groups = new Map<string, MakaioProtocolSubject[]>();

  for (const subject of subjects) {
    const existing = groups.get(subject.namespace);
    if (existing) {
      existing.push(subject);
    } else {
      groups.set(subject.namespace, [subject]);
    }
  }

  return groups;
}

/**
 * Reject namespace or subject names that collapse to duplicate Rust identifiers.
 * @param manifest - Protocol manifest to validate before code generation
 * @returns Nothing; throws when Rust identifier collisions are detected
 */
function assertNoIdentifierCollisions(manifest: MakaioProtocolManifest): void {
  const namespacesByModule = new Map<string, string>();

  for (const subject of manifest.subjects) {
    const moduleName = toRustModuleName(subject.namespace);
    const existingNamespace = namespacesByModule.get(moduleName);
    if (existingNamespace !== undefined && existingNamespace !== subject.namespace) {
      throw new Error(
        `Rust module identifier collision: "${existingNamespace}" and "${subject.namespace}" both map to "${moduleName}"`,
      );
    }
    namespacesByModule.set(moduleName, subject.namespace);
  }

  const subjectsByNamespace = groupByNamespace(manifest.subjects);
  for (const [namespace, subjects] of subjectsByNamespace) {
    const subjectsByConstant = new Map<string, string>();
    for (const subject of subjects) {
      const constantName = toRustConstantName(subject.subject);
      const existingSubject = subjectsByConstant.get(constantName);
      if (existingSubject !== undefined) {
        if (existingSubject === subject.subject) {
          throw new Error(`Duplicate protocol subject in namespace "${namespace}": "${subject.subject}"`);
        }
        throw new Error(
          `Rust subject identifier collision in namespace "${namespace}": "${existingSubject}" and "${subject.subject}" both map to "${constantName}"`,
        );
      }
      subjectsByConstant.set(constantName, subject.subject);
    }
  }
}

/**
 * Detect the line-ending style used by an existing file.
 * @param content - Existing file content that may contain `\n` or `\r\n`
 * @returns Canonical line-ending token to preserve during rewrites
 */
function detectLineEnding(content: string): '\n' | '\r\n' {
  return content.includes('\r\n') ? '\r\n' : '\n';
}

/**
 * Normalize generated content to the target line-ending style.
 * @param content - Generated source content to normalize
 * @param lineEnding - Line-ending style to preserve in the written file
 * @returns Content rewritten to the requested line-ending style
 */
function normalizeLineEndings(content: string, lineEnding: '\n' | '\r\n'): string {
  if (lineEnding === '\n') {
    return content.replace(/\r\n/g, '\n');
  }
  return content.replace(/\r?\n/g, '\r\n');
}

/**
 * Generate the `pub mod <namespace>` block for a group of subjects.
 * @param namespace - Raw namespace string (may contain `:` or `-`)
 * @param subjects - Subjects belonging to this namespace
 * @returns Generated Rust module block as a string
 */
function generateNamespaceModule(namespace: string, subjects: MakaioProtocolSubject[]): string {
  const modName = toRustModuleName(namespace);
  const uses: string[] = [];
  if (subjects.some((subject) => subject.kind === 'event')) {
    uses.push('EventSubject');
  }
  if (subjects.some((subject) => subject.kind === 'request')) {
    uses.push('RequestSubject');
  }
  uses.push('Value');
  const lines: string[] = [`pub mod ${modName} {`, `    use super::{${uses.join(', ')}};`, ''];

  for (const subject of subjects) {
    const constName = toRustConstantName(subject.subject);
    const typeName = toRustSubjectTypeName(subject.subject);
    lines.push(`    pub const ${constName}: &str = "${subject.fullSubject}";`);
    lines.push('');
    lines.push('    #[derive(Debug, Clone, Copy, PartialEq, Eq)]');
    lines.push(`    pub struct ${typeName};`);
    if (subject.kind === 'event') {
      lines.push(`    impl EventSubject for ${typeName} {`);
      lines.push(`        type Payload = ${rustSubjectPayloadType(subject.fullSubject, 'event')};`);
    } else {
      lines.push(`    impl RequestSubject for ${typeName} {`);
      lines.push(`        type Request = ${rustSubjectPayloadType(subject.fullSubject, 'request')};`);
      lines.push(`        type Response = ${rustSubjectPayloadType(subject.fullSubject, 'response')};`);
    }
    lines.push(`        const SUBJECT: &'static str = ${constName};`);
    lines.push('    }');
    lines.push('');
  }

  if (lines.at(-1) === '') {
    lines.pop();
  }
  lines.push('}');
  return lines.join('\n');
}

/**
 * Generate one `ProtocolSubject { ... }` initializer for the SUBJECTS array.
 * @param subject - Protocol subject to render
 * @returns Rust struct initializer block as a string
 */
function generateSubjectsEntry(subject: MakaioProtocolSubject): string {
  const constName = toRustConstantName(subject.subject);
  const modName = toRustModuleName(subject.namespace);
  const kind = toSubjectKindVariant(subject.kind);
  return [
    '    ProtocolSubject {',
    `        kind: SubjectKind::${kind},`,
    `        namespace: "${subject.namespace}",`,
    `        subject: "${subject.subject}",`,
    `        full_subject: ${modName}::${constName},`,
    '    },',
  ].join('\n');
}

/**
 * Generate the constants and SUBJECTS array section of the Rust file.
 *
 * This is the section that gets regenerated on every codegen run. It is wrapped with explicit
 * generated-section markers so codegen never has to infer the preservation boundary from Rust
 * syntax.
 * @param manifest - Protocol manifest to generate bindings from
 * @returns Generated Rust source section (without the hand-authored structs)
 */
export function generateRustSubjectsSection(manifest: MakaioProtocolManifest): string {
  assertNoIdentifierCollisions(manifest);
  const sorted = [...manifest.subjects];
  const groups = groupByNamespace(sorted);

  const lines: string[] = [
    GENERATED_SECTION_START_MARKER,
    '//! Subject bindings generated from `framework/sdks/manifest/makaio-bus-protocol.json`.',
    '#![allow(non_snake_case)]',
    '',
    'use crate::bus::{EventSubject, RequestSubject};',
    'use serde::{Deserialize, Serialize};',
    'use serde_json::{Map, Value};',
    '',
    '/// A manifest subject exported into the Rust SDK.',
    '#[derive(Debug, Clone, Copy, PartialEq, Eq)]',
    'pub struct ProtocolSubject {',
    '    pub kind: SubjectKind,',
    "    pub namespace: &'static str,",
    "    pub subject: &'static str,",
    "    pub full_subject: &'static str,",
    '}',
    '',
    '/// Runtime kind for a protocol subject.',
    '#[derive(Debug, Clone, Copy, PartialEq, Eq)]',
    'pub enum SubjectKind {',
    '    Event,',
    '    Request,',
    '}',
    '',
  ];

  for (const [namespace, subjects] of groups) {
    lines.push(generateNamespaceModule(namespace, subjects));
    lines.push('');
  }

  lines.push('pub const SUBJECTS: &[ProtocolSubject] = &[');

  for (const subject of sorted) {
    lines.push(generateSubjectsEntry(subject));
  }

  lines.push('];');
  lines.push(GENERATED_SECTION_END_MARKER);

  // Trailing newline ensures the splice with the hand-authored section produces
  // the blank line separator between the marker and the hand-authored structs.
  return lines.join('\n') + '\n';
}

/**
 * Extract the hand-authored section from an existing Rust subjects file.
 *
 * Requires explicit generated-section markers in existing files so missing or malformed generated
 * boundaries fail loudly instead of dropping hand-authored Rust code.
 * @param existingContent - Current content of the Rust subjects file
 * @returns The hand-authored suffix (everything after the generated section end marker)
 */
export function extractHandAuthoredSection(existingContent: string): string {
  const lines = existingContent.split('\n');
  const normalizedLines = lines.map((line) => line.replace(/\r$/, ''));
  const startIndex = normalizedLines.findIndex((line) => line === GENERATED_SECTION_START_MARKER);
  const endIndex = normalizedLines.findIndex(
    (line, index) => index > startIndex && line === GENERATED_SECTION_END_MARKER,
  );

  if (startIndex === -1 || endIndex === -1) {
    throw new Error('Missing generated section markers in Rust subjects file');
  }
  if (normalizedLines.findIndex((line, index) => index > endIndex && line === GENERATED_SECTION_START_MARKER) !== -1) {
    throw new Error('Unexpected generated section marker after Rust subjects generated section');
  }

  return lines.slice(endIndex + 1).join('\n');
}

/**
 * Write the generated Rust `subjects.rs` file to disk, preserving the hand-authored
 * structs that follow the generated constants and SUBJECTS array. This requires the
 * committed file to exist already because codegen preserves the hand-authored suffix
 * after the generated markers.
 * @param manifest - Protocol manifest to generate bindings from
 * @returns Resolved path of the written file
 */
export async function writeRustSubjects(manifest: MakaioProtocolManifest): Promise<string> {
  let existingContent: string;
  try {
    existingContent = await readFile(RUST_SUBJECTS_PATH, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot regenerate Rust subjects without existing file at ${RUST_SUBJECTS_PATH}: ${message}`, {
      cause: error,
    });
  }
  const handAuthored = extractHandAuthoredSection(existingContent);
  const lineEnding = detectLineEnding(existingContent);

  const generatedSection = normalizeLineEndings(generateRustSubjectsSection(manifest), lineEnding);
  const normalizedHandAuthored = normalizeLineEndings(handAuthored, lineEnding);
  const fullContent = generatedSection + normalizedHandAuthored;

  await writeFile(RUST_SUBJECTS_PATH, fullContent, 'utf8');
  return RUST_SUBJECTS_PATH;
}
