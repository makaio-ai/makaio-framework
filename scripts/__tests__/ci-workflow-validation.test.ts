import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const testFileDir = dirname(fileURLToPath(import.meta.url));

function readWorkflow(fileName: string): string {
  return readFileSync(resolve(testFileDir, '../../.github/workflows', fileName), 'utf8');
}

describe('CI workflow validation', () => {
  const reusableWorkflowText = readWorkflow('ci-reusable.yml');

  it('runs the package overview drift check in the validation job', () => {
    expect(reusableWorkflowText).toContain('- name: Check package overview drift');
    expect(reusableWorkflowText).toContain('run: yarn validate:package-overview');
    expect(reusableWorkflowText).toContain('working-directory: ${{ inputs.framework_root }}');
  });

  it('does not skip CI for package overview documentation changes', () => {
    expect(reusableWorkflowText).toContain(
      "const requiresValidation = files.some(({ filename: file }) => file === 'docs/package-overview.md');",
    );
    expect(reusableWorkflowText).toContain('files.length > 0 && !requiresValidation && files.every');
  });
});
