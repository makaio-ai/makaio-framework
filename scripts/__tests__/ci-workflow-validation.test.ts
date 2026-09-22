import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const testFileDir = dirname(fileURLToPath(import.meta.url));

function readWorkflow(fileName: string): string {
  return readFileSync(resolve(testFileDir, '../../.github/workflows', fileName), 'utf8');
}

describe('CI workflow validation', () => {
  const ciWorkflowText = readWorkflow('ci.yml');
  const labelControllerWorkflowText = readWorkflow('ci-label-controller.yml');
  const reusableWorkflowText = readWorkflow('ci-reusable.yml');
  const e2eWorkflowText = readWorkflow('ci-e2e.yml');

  it('runs the package overview drift check in the validation job', () => {
    expect(reusableWorkflowText).toContain('- name: Check package overview drift');
    expect(reusableWorkflowText).toContain(
      'run: bun ${{ inputs.framework_root }}/scripts/validate-package-overview.ts',
    );
  });

  /**
   * Returns the body of the classifier's case arm for the given pattern, up to
   * its terminating `;;`, so assertions target that arm rather than the whole
   * workflow text.
   * @param pattern - Literal case pattern as it appears in the workflow.
   * @returns The case-arm body between the pattern and its `;;`.
   */
  function classifierCaseArm(pattern: string): string {
    const start = reusableWorkflowText.indexOf(`${pattern})`);
    expect(start).toBeGreaterThan(-1);
    const end = reusableWorkflowText.indexOf(';;', start);
    expect(end).toBeGreaterThan(start);
    return reusableWorkflowText.slice(start, end);
  }

  it('requires validation for package overview changes while keeping the docs-only skips', () => {
    const arm = classifierCaseArm('docs/package-overview.md');
    expect(arm).toContain('requires_validation=true');
    expect(arm).not.toContain('docs_only=false');
  });

  it('routes generated subject-doc changes to the validation job without dropping docs-only', () => {
    const arm = classifierCaseArm('docs/subjects/*');
    expect(arm).toContain('requires_validation=true');
    expect(arm).not.toContain('docs_only=false');
    expect(reusableWorkflowText).toContain("needs.cache.outputs.requires_validation == 'true'");
  });

  it('classifies both sides of renames instead of the rename destination only', () => {
    expect(reusableWorkflowText).toContain('--no-renames');
  });

  it('counts deleted files when classifying documentation-only changes', () => {
    expect(reusableWorkflowText).not.toContain('--diff-filter=d');
    expect(e2eWorkflowText).not.toContain('--diff-filter=d');
  });

  it('fetches PR head refs from the authenticated origin remote', () => {
    expect(reusableWorkflowText).toContain('git fetch --no-tags origin "refs/pull/${pr_number}/head"');
    expect(e2eWorkflowText).toContain('git fetch --no-tags origin "refs/pull/${pr_number}/head"');
    expect(reusableWorkflowText).toContain('persist-credentials: true');
    expect(e2eWorkflowText).toContain('persist-credentials: true');
  });

  it('passes PR base SHA through dispatched CI reruns', () => {
    expect(labelControllerWorkflowText).toContain('base_sha: baseSha');
    expect(ciWorkflowText).toContain('base_sha: ${{ inputs.base_sha }}');
    expect(reusableWorkflowText).toContain("inputs.pr_number != '' && inputs.base_sha != ''");
    expect(e2eWorkflowText).toContain("inputs.pr_number != '' && inputs.base_sha != ''");
  });

  it('fails precheck before looping when skip label configuration is malformed', () => {
    expect(reusableWorkflowText).toContain('configured_labels="$(jq -r');
    expect(reusableWorkflowText).toContain('done <<< "$configured_labels"');
  });
});
