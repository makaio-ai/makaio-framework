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

describe('conformance workflow security', () => {
  const workflowText = readFileSync(resolveWorkflowPath(), 'utf8');

  it('rejects fork pull requests before checking out code or injecting provider API keys', () => {
    const forkGuardIndex = workflowText.indexOf('- name: Reject fork pull requests');
    const checkoutIndex = workflowText.indexOf('uses: actions/checkout@');
    const secretInjectionIndexes = [
      workflowText.indexOf('OPENAI_API_KEY:'),
      workflowText.indexOf('PROVIDER_SECRET_VALUE:'),
    ];

    expect(forkGuardIndex).toBeGreaterThanOrEqual(0);
    expect(checkoutIndex).toBeGreaterThan(forkGuardIndex);
    for (const secretInjectionIndex of secretInjectionIndexes) {
      if (secretInjectionIndex >= 0) {
        expect(secretInjectionIndex).toBeGreaterThan(forkGuardIndex);
      }
    }
    expect(workflowText).toContain('github.rest.pulls.get');
    expect(workflowText).toContain('headRepository !== baseRepository');
    expect(workflowText).toContain('persist-credentials: false');
  });

  it('grants the issue-comment and pull-request permissions used by the workflow', () => {
    expect(workflowText).toContain('issues: write');
    expect(workflowText).toContain('pull-requests: read');
    expect(workflowText).not.toContain('pull-requests: write');
  });

  it('uploads per-adapter schema violation artifacts and tolerates clean runs', () => {
    expect(workflowText).toContain('schema-violations-${{ matrix.adapter }}-adapter-smoke.json');
    expect(workflowText).toContain('conformance-result-${{ matrix.adapter }}-adapter-rest.json');
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

  it('uses the reference adapter gate and CI-only provider overrides for expensive adapters', () => {
    expect(workflowText).toContain('needs: reference-smoke');
    expect(workflowText).toContain('- adapter: claude-agent-sdk');
    expect(workflowText).toContain('- adapter: claude-code-cli');
    expect(workflowText).toContain('conformance_provider: opencode-go-anthropic');
    expect(workflowText).toContain('provider_secret_name: OPENCODE_GO_API_KEY');
    expect(workflowText).toContain('PROVIDER_SECRET_VALUE: ${{ secrets[matrix.provider_secret_name] }}');
    expect(workflowText).toContain('MAKAIO_CONFORMANCE_PROVIDER: ${{ matrix.conformance_provider }}');
    expect(workflowText).not.toContain('github-copilot-sdk');
  });
});
