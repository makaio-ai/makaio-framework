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
  const e2eWorkflowText = readWorkflow('ci-e2e.yml');

  it('runs the package overview drift check in the validation job', () => {
    expect(reusableWorkflowText).toContain('- name: Check package overview drift');
    expect(reusableWorkflowText).toContain(
      'run: bun ${{ inputs.framework_root }}/scripts/validate-package-overview.ts',
    );
  });

  it('does not skip CI for package overview documentation changes', () => {
    expect(reusableWorkflowText).toContain('if [ "$file" = "docs/package-overview.md" ]; then');
    expect(reusableWorkflowText).toContain('docs_only=false');
  });

  it('counts deleted files when classifying documentation-only changes', () => {
    expect(reusableWorkflowText).not.toContain('--diff-filter=d');
    expect(e2eWorkflowText).not.toContain('--diff-filter=d');
  });

  it('fetches PR head refs from the authenticated origin remote', () => {
    expect(reusableWorkflowText).toContain('git fetch --no-tags origin "refs/pull/${pr_number}/head"');
    expect(e2eWorkflowText).toContain('git fetch --no-tags origin "refs/pull/${pr_number}/head"');
  });

  it('fails precheck before looping when skip label configuration is malformed', () => {
    expect(reusableWorkflowText).toContain('configured_labels="$(jq -r');
    expect(reusableWorkflowText).toContain('done <<< "$configured_labels"');
  });
});
