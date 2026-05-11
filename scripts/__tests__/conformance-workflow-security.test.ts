import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const testFileDir = dirname(fileURLToPath(import.meta.url));

function resolveWorkflowPath(): string {
  if (process.env.CONFORMANCE_WORKFLOW_PATH !== undefined && process.env.CONFORMANCE_WORKFLOW_PATH.trim() !== '') {
    return resolve(process.env.CONFORMANCE_WORKFLOW_PATH);
  }

  // File-relative discovery works in both nested and package-root layouts.
  const reusableWorkflowPath = resolve(testFileDir, '../../.github/workflows/conformance-reusable.yml');
  if (existsSync(reusableWorkflowPath)) {
    return reusableWorkflowPath;
  }

  return resolve(testFileDir, '../../.github/workflows/conformance.yml');
}

function resolveAdapterWorkflowPath(): string {
  return resolve(testFileDir, '../../.github/workflows/conformance-adapter.yml');
}

describe('conformance workflow security', () => {
  const workflowText = readFileSync(resolveWorkflowPath(), 'utf8');
  const adapterWorkflowText = readFileSync(resolveAdapterWorkflowPath(), 'utf8');

  it('rejects fork pull requests before adapter workflows check out code or inject provider API keys', () => {
    const forkGuardIndex = workflowText.indexOf('- name: Reject fork pull requests');
    const adapterJobIndexes = [
      workflowText.indexOf('  openai-node:'),
      workflowText.indexOf('  anthropic-sdk:'),
      workflowText.indexOf('  claude-agent-sdk:'),
      workflowText.indexOf('  claude-code-cli:'),
      workflowText.indexOf('  codex-app-server:'),
      workflowText.indexOf('  gemini-sdk:'),
      workflowText.indexOf('  pi-sdk:'),
      workflowText.indexOf('  qwen-acp:'),
    ];

    expect(forkGuardIndex).toBeGreaterThanOrEqual(0);
    for (const adapterJobIndex of adapterJobIndexes) {
      expect(adapterJobIndex).toBeGreaterThan(forkGuardIndex);
    }
    expect(workflowText).toContain('github.rest.pulls.get');
    expect(workflowText).toContain('headRepository !== baseRepository');
    expect(workflowText).toContain('needs: preflight');
    expect(adapterWorkflowText).toContain('uses: actions/checkout@');
    expect(adapterWorkflowText).toContain('persist-credentials: false');
    expect(adapterWorkflowText).toContain('${{ inputs.provider_env_var }}: ${{ secrets.PROVIDER_API_KEY }}');
  });

  it('grants the issue-comment and pull-request permissions used by the workflow', () => {
    expect(workflowText).toContain('issues: write');
    expect(workflowText).toContain('pull-requests: read');
    expect(workflowText).not.toContain('pull-requests: write');
  });

  it('uploads per-adapter schema violation artifacts and tolerates clean runs', () => {
    expect(adapterWorkflowText).toContain('schema-violations-${{ inputs.adapter }}-adapter-smoke.json');
    expect(adapterWorkflowText).toContain('conformance-result-${{ inputs.adapter }}-adapter-rest.json');
    expect(workflowText).toContain('continue-on-error: true');
    expect(workflowText).toContain("const escapeCell = (value) => String(value).replace(/\\|/g, '\\\\|')");
  });

  it('posts the consolidated report through the Makaio GitHub App token', () => {
    expect(workflowText).toMatch(/^\s*uses: actions\/create-github-app-token@[0-9a-fA-F]{40}(?:\s+# v[\d.]+)?\s*$/m);
    expect(workflowText).toContain('app-id: ${{ secrets.MAKAIO_GITHUB_APP_ID }}');
    expect(workflowText).toContain('private-key: ${{ secrets.MAKAIO_GITHUB_APP_PRIVATE_KEY }}');
    expect(workflowText).toContain('github-token: ${{ steps.app-token.outputs.token }}');
    expect(workflowText).toContain('<!-- makaio-conformance-report -->');
    expect(workflowText).toContain('github.paginate(github.rest.issues.listComments');
    expect(workflowText).toContain("comment.user?.type === 'Bot'");
  });

  it('uses CI-only provider configuration for expensive adapters', () => {
    expect(workflowText).toContain('  claude-agent-sdk:');
    expect(workflowText).toContain('  claude-code-cli:');
    expect(workflowText).toContain('provider_env_var: OPENCODE_GO_API_KEY');
    expect(adapterWorkflowText).toContain('MAKAIO_CONFORMANCE_PROVIDER: ${{ vars.MAKAIO_CONFORMANCE_PROVIDER }}');
    expect(workflowText).not.toContain('github-copilot-sdk');
  });
});
