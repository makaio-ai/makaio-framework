import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { MakaioProtocolManifest, MakaioProtocolSubject } from '../../packages/contracts/src/protocol/types.js';
import { PYTHON_GENERATED_DIR, PYTHON_SUBJECTS_PATH } from '../lib/sdk-generation-paths.js';
import { camelToSnake, capitalize, fullSubjectToPascalClass, groupByNamespace } from './python-payloads.js';

/**
 * Convert a fullSubject string to a Python SCREAMING_SNAKE_CASE constant name.
 *
 * The algorithm is:
 * 1. Replace every `:` with `__` (double underscore, to avoid collision with `_` separators)
 * 2. Replace every `-` with `_`
 * 3. Replace every `.` with `_`
 * 4. Insert `_` before each uppercase letter
 * 5. Uppercase the entire string
 * @param fullSubject - Fully-qualified subject key, e.g. `agent.contextWindow.updated`,
 *   `storage:adapter.get`, or `account-manager:credentials.switched`
 * @returns SCREAMING_SNAKE_CASE constant name, e.g. `AGENT_CONTEXT_WINDOW_UPDATED`,
 *   `STORAGE__ADAPTER_GET`, or `ACCOUNT_MANAGER__CREDENTIALS_SWITCHED`
 */
export function toPythonConstantName(fullSubject: string): string {
  return fullSubject
    .replace(/:/g, '__')
    .replace(/-/g, '_')
    .replace(/\./g, '_')
    .replace(/([A-Z])/g, '_$1')
    .toUpperCase();
}

/**
 * Generate the Python `subjects.py` binding file content from a protocol manifest.
 *
 * The output matches the hand-authored format exactly:
 * - One constant per subject, sorted by fullSubject
 * - An `ALL_SUBJECTS` tuple referencing all constants in the same order
 * - Trailing comma after every tuple entry including the last
 * - Trailing newline at end of file
 * @param manifest - Protocol manifest to generate bindings from
 * @returns Generated Python source as a string
 */
export function generatePythonSubjects(manifest: MakaioProtocolManifest): string {
  const sorted = [...manifest.subjects];
  const subjectsByConstant = new Map<string, string>();

  for (const subject of sorted) {
    const constName = toPythonConstantName(subject.fullSubject);
    const existing = subjectsByConstant.get(constName);
    if (existing !== undefined) {
      throw new Error(
        `Python subject constant collision: "${existing}" and "${subject.fullSubject}" both map to "${constName}"`,
      );
    }
    subjectsByConstant.set(constName, subject.fullSubject);
  }

  const lines: string[] = [
    '"""Subject constants generated from framework/sdks/manifest/makaio-bus-protocol.json."""',
    '',
  ];

  for (const subject of sorted) {
    const constName = toPythonConstantName(subject.fullSubject);
    lines.push(`${constName} = "${subject.fullSubject}"`);
  }

  lines.push('');
  lines.push('ALL_SUBJECTS = (');

  for (const subject of sorted) {
    const constName = toPythonConstantName(subject.fullSubject);
    lines.push(`    ${constName},`);
  }

  lines.push(')');
  lines.push('');

  return lines.join('\n');
}

/**
 * Write the generated Python `subjects.py` file to disk.
 * @param manifest - Protocol manifest to generate bindings from
 * @returns Resolved path of the written file
 */
export async function writePythonSubjects(manifest: MakaioProtocolManifest): Promise<string> {
  const content = generatePythonSubjects(manifest);
  await writeFile(PYTHON_SUBJECTS_PATH, content, 'utf8');
  return PYTHON_SUBJECTS_PATH;
}

// ---------------------------------------------------------------------------
// Namespace module generation
// ---------------------------------------------------------------------------

/**
 * Convert a protocol `subject` key (without namespace prefix) to a valid
 * Python identifier for use as a module-level variable name.
 *
 * Examples:
 * - `complete`               → `complete`
 * - `contextWindow.updated`  → `context_window_updated`
 * - `cwd.changed`            → `cwd_changed`
 * - `sendMessage`            → `send_message`
 * - `message_delta`          → `message_delta`
 * - `toolApprove`            → `tool_approve`
 * - `user_message.acknowledged` → `user_message_acknowledged`
 * @param subject - Subject key inside a namespace, e.g. `contextWindow.updated`
 * @returns Python snake_case identifier
 */
export function subjectToVariableName(subject: string): string {
  return camelToSnake(subject.replace(/\./g, '_'));
}

/**
 * Derive the Python class name(s) for a protocol subject's payload type(s).
 *
 * - Event subjects have one class: `*Payload`
 * - Request subjects have two classes: `*Request` and `*Response`
 * @param subject - Protocol subject entry
 * @returns Array of Python class names referenced in the namespace module
 */
function subjectPayloadClasses(subject: MakaioProtocolSubject): string[] {
  const base = fullSubjectToPascalClass(subject.fullSubject);
  if (subject.kind === 'event') {
    return [`${base}Payload`];
  }
  return [`${base}Request`, `${base}Response`];
}

/**
 * Determine which `makaio.types` names must be imported for the namespace module.
 *
 * - Event subjects use `EventSubject`
 * - Request subjects use `RequestSubject`
 * @param subjects - Protocol subjects in the namespace
 * @returns Sorted list of names to import from `makaio.types`
 */
function collectTypeImports(subjects: MakaioProtocolSubject[]): string[] {
  const names = new Set<string>();
  for (const s of subjects) {
    if (s.kind === 'event') {
      names.add('EventSubject');
    } else {
      names.add('RequestSubject');
    }
  }
  return [...names].sort();
}

/**
 * Generate the Python namespace module for one namespace.
 *
 * The module exposes one typed subject descriptor per protocol subject:
 * - `EventSubject[*Payload]` for event subjects
 * - `RequestSubject[*Request, *Response]` for request subjects
 *
 * All payload classes are imported from the corresponding
 * `makaio.generated.payloads.<namespace>` module.
 * @param namespace - Protocol namespace name, e.g. `agent`
 * @param subjects - Protocol subjects belonging to this namespace
 * @returns Generated Python source string for the namespace module
 */
export function generatePythonNamespaceModule(namespace: string, subjects: MakaioProtocolSubject[]): string {
  const typeImports = collectTypeImports(subjects);

  // Collect all payload class names in the order they appear
  const payloadClassNames: string[] = [];
  for (const s of subjects) {
    payloadClassNames.push(...subjectPayloadClasses(s));
  }

  const lines: string[] = [
    `"""${capitalize(namespace)} namespace subjects — generated from makaio-bus-protocol.json."""`,
    '',
    'from __future__ import annotations',
    '',
    `from makaio.types import ${typeImports.join(', ')}`,
    `from makaio.generated.payloads.${namespace} import (`,
  ];

  for (const cls of payloadClassNames) {
    lines.push(`    ${cls},`);
  }

  lines.push(')');
  lines.push('');

  // Subject variable declarations
  for (const subject of subjects) {
    const varName = subjectToVariableName(subject.subject);
    if (subject.kind === 'event') {
      const cls = `${fullSubjectToPascalClass(subject.fullSubject)}Payload`;
      lines.push(`${varName}: EventSubject[${cls}] = EventSubject("${subject.fullSubject}", payload_type=${cls})`);
    } else {
      const reqCls = `${fullSubjectToPascalClass(subject.fullSubject)}Request`;
      const resCls = `${fullSubjectToPascalClass(subject.fullSubject)}Response`;
      lines.push(
        `${varName}: RequestSubject[${reqCls}, ${resCls}] = RequestSubject("${subject.fullSubject}", request_type=${reqCls}, response_type=${resCls})`,
      );
    }
  }

  lines.push('');

  return lines.join('\n');
}

/**
 * Write generated Python namespace module files and the generated `__init__.py`
 * for every namespace in the manifest.
 *
 * Creates `<PYTHON_GENERATED_DIR>/<namespace>.py` for each namespace and updates
 * `<PYTHON_GENERATED_DIR>/__init__.py` to re-export all namespace modules.
 * @param manifest - Protocol manifest to generate namespace modules from
 * @returns Resolved paths of all written files
 */
export async function writePythonNamespaceModules(manifest: MakaioProtocolManifest): Promise<string[]> {
  await mkdir(PYTHON_GENERATED_DIR, { recursive: true });

  const groups = groupByNamespace(manifest.subjects);
  const namespaces = [...groups.keys()].sort();
  const written: string[] = [];

  // Write per-namespace module files
  for (const [namespace, subjects] of groups) {
    const content = generatePythonNamespaceModule(namespace, subjects);
    const filePath = resolve(PYTHON_GENERATED_DIR, `${namespace}.py`);
    await writeFile(filePath, content, 'utf8');
    written.push(filePath);
  }

  // Write __init__.py that re-exports all namespace modules
  const initLines: string[] = [
    '"""Generated namespace modules — re-export for convenient access."""',
    '',
    `from makaio.generated import ${namespaces.join(', ')}`,
    '',
  ];
  const initPath = resolve(PYTHON_GENERATED_DIR, '__init__.py');
  await writeFile(initPath, initLines.join('\n'), 'utf8');
  written.push(initPath);

  return written;
}
