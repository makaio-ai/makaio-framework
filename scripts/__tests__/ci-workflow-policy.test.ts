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
    expect(workflow).toContain('repository_dispatch:');
    expect(workflow).toContain('types: [full-ci-requested]');
    expect(workflow).toContain('checkout_ref');
    expect(workflow).toContain('source_sha');
    expect(workflow).toContain('Verify checked out source');
    expect(workflow).toContain('REUSE_QUICK_VALIDATION');
    expect(workflow).toContain('validation: true');
    expect(workflow).toContain('Validation reused from Quick Checks');
    expect(workflow).not.toContain('pull_request:');
    expect(workflow).not.toContain('push:');
  });

  it('runs full CI from a maintainer /ci issue comment through the dispatcher and request workflow', () => {
    const workflowPath = resolve(workflowsDir, 'ci-request.yml');
    expect(existsSync(workflowPath)).toBe(true);

    const dispatcher = readWorkflow('slash-command-dispatcher.yml');
    expect(dispatcher).toContain('issue_comment:');
    expect(dispatcher).toContain("trimmed === '/ci' || trimmed.startsWith('/ci ')");
    expect(dispatcher).toContain("['OWNER', 'MEMBER'].includes(association)");
    expect(dispatcher).toContain('uses: ./.github/workflows/ci-request.yml');
    expect(dispatcher).toContain('secrets: inherit');

    const workflow = readFileSync(workflowPath, 'utf8');
    expect(workflow).toContain('workflow_call:');
    expect(workflow).not.toContain('issue_comment:');
    expect(workflow).toContain('headRepository !== baseRepository');
    expect(workflow).toContain("event_type: 'full-ci-requested'");
    expect(workflow).toContain("core.setOutput('checkout-ref', pullRequest.head.ref)");
    expect(workflow).toContain("core.setOutput('source-sha', pullRequest.head.sha)");
    expect(workflow).toContain("labels.includes('skip:ci') || labels.includes('skip:all')");
    expect(workflow).toContain('client-id: ${{ vars.MAKAIO_GITHUB_APP_CLIENT_ID }}');
    expect(workflow).toContain('github-token: ${{ steps.app-token.outputs.token }}');
    expect(workflow).toContain("check_name: 'Quick Checks'");
    expect(workflow).toContain("name: 'Validation Reused'");
    expect(workflow).toContain('reuse_quick_validation: reuseQuickValidation');
    expect(workflow).toContain('checkout_ref: process.env.CHECKOUT_REF');
    expect(workflow).toContain('source_sha: process.env.SOURCE_SHA');
    expect(workflow).not.toContain('actions/checkout');
    expect(workflow).not.toContain('yarn ');
  });

  it('includes CodeQL advanced setup in full CI', () => {
    const workflow = readWorkflow('ci.yml');
    const configPath = resolve(workflowsDir, '../codeql/codeql-config.yml');
    expect(existsSync(configPath)).toBe(true);

    expect(workflow).toContain('name: CodeQL');
    expect(workflow).toContain('security-events: write');
    expect(workflow).toContain('language: [javascript-typescript, actions]');
    expect(workflow).toContain('github/codeql-action/init@');
    expect(workflow).toContain('github/codeql-action/analyze@');
    expect(workflow).toContain('languages: ${{ matrix.language }}');
    expect(workflow).toContain('build-mode: none');
    expect(workflow).toContain('config-file: ./.github/codeql/codeql-config.yml');
    expect(workflow).toContain('category: full-ci/${{ matrix.language }}');

    const config = readFileSync(configPath, 'utf8');
    expect(config).toContain('security-extended');
    expect(config).toContain('paths-ignore:');
    expect(config).toContain("'**/dist/**'");
    expect(config).toContain("'**/node_modules/**'");
  });

  it('skips expensive quick PR validation for documentation-only pull requests', () => {
    const workflow = readWorkflow('ci-quick.yml');

    expect(workflow).toContain('- name: Classify PR changes');
    expect(workflow).toContain("core.setOutput('docs_only'");
    expect(workflow).toContain("file.endsWith('.md')");
    expect(workflow).toContain("file.startsWith('docs/')");
    expect(workflow).toContain("(file.startsWith('.changeset/') && file.endsWith('.md'))");
    expect(workflow).toContain("steps.changes.outputs.docs_only != 'true'");
  });

  it('ensures classification runs before trusted checker resolution and changeset check for non-publish diffs', () => {
    const workflow = readWorkflow('changeset-required-reusable.yml');
    const classifyIndex = workflow.indexOf('- name: Classify publish relevance');
    const checkerIndex = workflow.indexOf('- name: Resolve trusted checker');
    const checkIndex = workflow.indexOf('- name: Check changeset');

    expect(classifyIndex).toBeGreaterThan(-1);
    expect(classifyIndex).toBeLessThan(checkerIndex);
    expect(classifyIndex).toBeLessThan(checkIndex);
    expect(workflow).toContain("publish_relevance.outputs.relevant != 'false'");
    expect(workflow).toContain('.github/*|docs/*|.changeset/*.md|*.md');
    expect(workflow).not.toContain('.github/*|docs/*|.changeset/*|*.md');
  });
});
