import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'bun:test';

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

function resolveFrameworkWorkflowPath(fileName: string): string {
  return resolve(testFileDir, '../../.github/workflows', fileName);
}

function readWorkflow(fileName: string): string {
  return readFileSync(resolveFrameworkWorkflowPath(fileName), 'utf8');
}

function readGithubAction(relativePath: string): string {
  return readFileSync(resolve(testFileDir, '../../.github/actions', relativePath), 'utf8');
}

function extractStepBlock(workflowText: string, stepName: string): string {
  const startIndex = workflowText.indexOf(`- name: ${stepName}`);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  const nextStepIndex = workflowText.indexOf('\n      - name:', startIndex + 1);
  return workflowText.slice(startIndex, nextStepIndex === -1 ? undefined : nextStepIndex);
}

describe('conformance workflow security', () => {
  const workflowText = readFileSync(resolveWorkflowPath(), 'utf8');

  it('rejects fork pull requests before checking out code or injecting provider API keys', () => {
    const forkGuardIndex = workflowText.indexOf('- name: Reject fork pull requests');
    const checkoutIndex = workflowText.indexOf('uses: actions/checkout@');
    const secretInjectionIndexes = [
      workflowText.indexOf('OPENAI_API_KEY:'),
      workflowText.indexOf('OPENCODE_GO_API_KEY:'),
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
  });

  it('uploads per-adapter schema violation artifacts and tolerates clean runs', () => {
    expect(workflowText).toContain('schema-violations-${{ matrix.adapter }}-adapter-smoke.json');
    expect(workflowText).toContain('conformance-result-${{ matrix.adapter }}-adapter-rest.json');
    expect(workflowText).toContain('MAKAIO_CONFORMANCE_LOG_DIR: conformance-artifacts/logs');
    expect(workflowText).toContain('TMPDIR: conformance-artifacts/logs');
    expect(workflowText).toContain('mkdir -p conformance-artifacts/logs');
    expect(workflowText).toContain('path: conformance-artifacts/**');
    expect(workflowText).toContain('continue-on-error: true');
    expect(workflowText).toContain("const escapeCell = (value) => String(value).replace(/\\|/g, '\\\\|')");
  });

  it('posts the consolidated report through the Makaio GitHub App token', () => {
    const tokenActionUses = workflowText
      .split('\n')
      .filter((line) => line.includes('uses: actions/create-github-app-token@'));

    expect(tokenActionUses.length).toBeGreaterThan(0);
    for (const line of tokenActionUses) {
      expect(line).toMatch(/^\s*uses: actions\/create-github-app-token@[0-9a-fA-F]{40}(?:\s+# v[\d.]+)?\s*$/);
    }
    expect(workflowText).toContain('client-id: ${{ secrets.MAKAIO_GITHUB_APP_ID }}');
    expect(workflowText).not.toContain('app-id:');
    expect(workflowText).toContain('private-key: ${{ secrets.MAKAIO_GITHUB_APP_PRIVATE_KEY }}');
    expect(workflowText).toContain('github-token: ${{ steps.app-token.outputs.token }}');
    expect(workflowText).toContain('<!-- makaio-conformance-report -->');
    expect(workflowText).toContain('github.paginate(github.rest.issues.listComments');
    expect(workflowText).toContain("comment.user?.type === 'Bot'");
  });

  it('uses the reference adapter gate and CI-only provider overrides for expensive adapters', () => {
    expect(workflowText).toContain('openai_enabled');
    expect(workflowText).toContain('adapter_matrix');
    for (const stepName of ['Run openai-node reference smoke', 'Run openai-node reference rest']) {
      const stepBlock = extractStepBlock(workflowText, stepName);
      expect(stepBlock).toContain(
        'MAKAIO_CONFORMANCE_PROVIDER: ${{ needs.preflight.outputs.openai_conformance_provider }}',
      );
      expect(stepBlock).toContain(
        'MAKAIO_CONFORMANCE_PRIMARY_MODEL: ${{ needs.preflight.outputs.openai_primary_model }}',
      );
      expect(stepBlock).toContain(
        'MAKAIO_CONFORMANCE_SECONDARY_MODEL: ${{ needs.preflight.outputs.openai_secondary_model }}',
      );
    }
    expect(workflowText).toContain("'claude-agent-sdk': {");
    expect(workflowText).toContain("'claude-code-cli': {");
    expect(workflowText).toContain("conformance_provider: 'opencode-go-anthropic'");
    expect(workflowText).toContain("provider_secret_name: 'OPENCODE_GO_API_KEY'");
    expect(workflowText).toContain("provider_env_var: 'OPENCODE_GO_API_KEY'");
    expect(workflowText).toContain('PROVIDER_SECRET_VALUE: ${{ secrets[matrix.provider_secret_name] }}');
    expect(workflowText).toContain('PROVIDER_ENV_VAR: ${{ matrix.provider_env_var }}');
    expect(workflowText).toContain('MAKAIO_CONFORMANCE_PROVIDER: ${{ matrix.conformance_provider }}');
    expect(workflowText).toContain('MAKAIO_CONFORMANCE_PRIMARY_MODEL: ${{ matrix.primary_model }}');
    expect(workflowText).toContain('MAKAIO_CONFORMANCE_SECONDARY_MODEL: ${{ matrix.secondary_model }}');
    expect(workflowText).not.toContain('github-copilot-sdk');
  });

  it('fails adapter workflow jobs before exporting a missing provider secret', () => {
    const adapterWorkflowText = readWorkflow('conformance-adapter.yml');

    for (const stepName of ['Run adapter smoke', 'Run adapter rest']) {
      const stepBlock = extractStepBlock(adapterWorkflowText, stepName);
      const secretGuardIndex = stepBlock.indexOf('if [ -z "${PROVIDER_API_KEY}" ]; then');
      const exportIndex = stepBlock.indexOf('export "${PROVIDER_ENV_VAR}=${PROVIDER_API_KEY}"');

      expect(secretGuardIndex).toBeGreaterThanOrEqual(0);
      expect(exportIndex).toBeGreaterThan(secretGuardIndex);
      expect(stepBlock).toContain('Missing secret');
      expect(stepBlock).toContain('exit 1');
    }
    expect(adapterWorkflowText).toContain('provider_secret_name:');
    expect(adapterWorkflowText).toContain(
      'PROVIDER_SECRET_NAME: ${{ inputs.provider_secret_name || vars.PROVIDER_SECRET_NAME }}',
    );
    expect(adapterWorkflowText).toContain('PROVIDER_ENV_VAR: ${{ inputs.provider_env_var || vars.PROVIDER_ENV_VAR }}');
    expect(adapterWorkflowText).toContain(
      'PROVIDER_API_KEY: ${{ secrets[inputs.provider_secret_name || vars.PROVIDER_SECRET_NAME] }}',
    );
    expect(adapterWorkflowText).toContain(
      'MAKAIO_CONFORMANCE_PROVIDER: ${{ inputs.conformance_provider || vars.MAKAIO_CONFORMANCE_PROVIDER }}',
    );
    expect(adapterWorkflowText).toContain(
      'MAKAIO_CONFORMANCE_PRIMARY_MODEL: ${{ inputs.primary_model || vars.MAKAIO_CONFORMANCE_PRIMARY_MODEL }}',
    );
    expect(adapterWorkflowText).toContain(
      'MAKAIO_CONFORMANCE_SECONDARY_MODEL: ${{ inputs.secondary_model || vars.MAKAIO_CONFORMANCE_SECONDARY_MODEL }}',
    );
    expect(adapterWorkflowText).toContain('MAKAIO_CONFORMANCE_LOG_DIR: conformance-artifacts/logs');
    expect(adapterWorkflowText).toContain('TMPDIR: conformance-artifacts/logs');
    expect(adapterWorkflowText).toContain('mkdir -p conformance-artifacts/logs');
    expect(adapterWorkflowText).toContain('path: conformance-artifacts/**');
    expect(adapterWorkflowText).not.toContain('secrets.PROVIDER_API_KEY');

    const automaticPrWorkflowFiles = readdirSync(resolveFrameworkWorkflowPath('.')).filter(
      (fileName) => fileName.startsWith('conformance-pr-') && fileName.endsWith('.yml'),
    );
    expect(automaticPrWorkflowFiles).toEqual([]);
  });

  it('installs only subprocess adapter CLIs through the shared conformance action', () => {
    const adapterWorkflowText = readWorkflow('conformance-adapter.yml');
    const installActionText = readGithubAction('install-conformance-cli/action.yml');

    expect(workflowText).toContain('uses: ./.github/actions/install-conformance-cli');
    expect(workflowText).toContain('adapter: ${{ matrix.adapter }}');
    expect(adapterWorkflowText).toContain('uses: ./.github/actions/install-conformance-cli');
    expect(adapterWorkflowText).toContain('adapter: ${{ inputs.adapter }}');
    expect(workflowText).not.toContain('name: Install Codex');

    expect(installActionText).toContain('codex-app-server)');
    expect(installActionText).toContain('npm install -g @openai/codex');
    expect(installActionText).toContain('claude-code-cli)');
    expect(installActionText).toContain('curl -fsSL https://claude.ai/install.sh | bash');
    expect(installActionText).not.toContain('claude-agent-sdk)');
  });

  it('only inherits conformance secrets for trusted commenters on pull request comments', () => {
    const callerWorkflowText = readWorkflow('conformance.yml');

    expect(callerWorkflowText).toContain(
      'contains(fromJSON(\'["OWNER","MEMBER"]\'), github.event.comment.author_association)',
    );
    expect(callerWorkflowText).not.toContain('github.event.issue.author_association');
    expect(callerWorkflowText).not.toContain('github.event.pull_request.author_association');
    expect(callerWorkflowText).toContain('comment_body: ${{ github.event.comment.body }}');
    expect(callerWorkflowText).toContain('secrets: inherit');
  });
});
