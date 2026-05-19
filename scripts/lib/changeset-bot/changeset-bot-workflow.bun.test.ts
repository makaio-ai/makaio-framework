import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'bun:test';

const testFileDir = dirname(fileURLToPath(import.meta.url));

function readWorkflow(path: string): string {
  return readFileSync(path, 'utf8');
}

function existingWorkflowPaths(): string[] {
  const frameworkWorkflow = resolve(testFileDir, '../../../.github/workflows/changeset-bot-reusable.yml');
  return [frameworkWorkflow].filter((path) => existsSync(path));
}

describe('changeset-bot reusable workflow', () => {
  const workflowPaths = existingWorkflowPaths();

  it('finds at least one workflow file to validate', () => {
    expect(workflowPaths.length).toBeGreaterThan(0);
  });

  for (const workflowPath of workflowPaths) {
    it(`does not check out PR code in the privileged issue_comment workflow ${workflowPath}`, () => {
      const workflow = readWorkflow(workflowPath);

      expect(workflow).not.toContain('Checkout target PR branch');
      expect(workflow).not.toContain('--target-root');
      expect(workflow).not.toContain('working-directory: target');
    });
  }
});
