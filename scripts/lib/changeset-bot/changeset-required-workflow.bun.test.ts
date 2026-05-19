import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'bun:test';

const testFileDir = dirname(fileURLToPath(import.meta.url));

function readWorkflow(path: string): string {
  return readFileSync(path, 'utf8');
}

function existingWorkflowPaths(): string[] {
  const frameworkWorkflow = resolve(testFileDir, '../../../.github/workflows/changeset-required-reusable.yml');
  return [frameworkWorkflow].filter((path) => existsSync(path));
}

describe('changeset-required reusable workflow', () => {
  const workflowPaths = existingWorkflowPaths();

  it('finds at least one workflow file to validate', () => {
    expect(workflowPaths.length).toBeGreaterThan(0);
  });

  for (const workflowPath of workflowPaths) {
    it(`keeps the trusted checker bootstrap guard in ${workflowPath}`, () => {
      const workflow = readWorkflow(workflowPath);
      const fetchIndex = workflow.indexOf('- name: Fetch PR head');
      const detectIndex = workflow.indexOf('- name: Detect package release changeset');
      const checkerIndex = workflow.indexOf('- name: Resolve trusted checker');
      const installIndex = workflow.indexOf('- name: Install dependencies');
      const checkIndex = workflow.indexOf('- name: Check changeset');

      expect(fetchIndex).toBeGreaterThanOrEqual(0);
      expect(detectIndex).toBeGreaterThan(fetchIndex);
      expect(checkerIndex).toBeGreaterThan(detectIndex);
      expect(installIndex).toBeGreaterThan(checkerIndex);
      expect(checkIndex).toBeGreaterThan(installIndex);
      expect(workflow).toContain("steps.head_changeset.outputs.present != 'true'");
      expect(workflow).toContain('changeset_prefix="${framework_root%/}/.changeset/"');
      expect(workflow).toContain("steps.checker.outputs.available == 'true'");
      expect(workflow).toContain('! git cat-file -e "$base:$checker_path"');
      expect(workflow).toContain('git cat-file -e "$head:$checker_path"');
      expect(workflow).toContain('Trusted changeset checker is being introduced by this PR');
      expect(workflow).toContain('Trusted changeset checker is missing from the base checkout');
      expect(workflow).toContain('yarn tsx "${{ steps.checker.outputs.path }}"');
      expect(workflow).toContain('skip:changeset');
      expect(workflow).toContain('skip:ci');
      expect(workflow).toContain('skip:all');
      expect(workflow).not.toContain('git diff --name-status "$base...$head"');
    });
  }
});
