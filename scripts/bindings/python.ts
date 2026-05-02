import { writeFile } from 'node:fs/promises';
import type { MakaioProtocolManifest } from '../../packages/contracts/src/protocol/types.js';
import { PYTHON_SUBJECTS_PATH } from '../lib/sdk-generation-paths.js';

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
