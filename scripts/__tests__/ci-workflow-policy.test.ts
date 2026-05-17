import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflowsDir = resolve(import.meta.dirname, '../../.github/workflows');

function readWorkflow(name: string): string {
  return readFileSync(resolve(workflowsDir, name), 'utf8');
}

describe('CI workflow policy', () => {
  it('keeps the full matrix CI workflow manual-only', () => {
    const workflow = readWorkflow('ci.yml');

    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).not.toContain('pull_request:');
    expect(workflow).not.toContain('push:');
  });

  it('runs quick PR CI as one non-matrix job with combined validation and sdk codegen checks', () => {
    const workflowPath = resolve(workflowsDir, 'ci-quick.yml');
    expect(existsSync(workflowPath)).toBe(true);

    const workflow = readFileSync(workflowPath, 'utf8');
    expect(workflow).toContain('pull_request:');
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).not.toContain('matrix:');
    expect(workflow).toContain('yarn tsx scripts/validate.ts --no-fix --cache --tsconfig tsconfig.json');
    expect(workflow).toContain('yarn validate:sdk-codegen');
    expect(workflow).toContain('.eslintcache');
  });
});
