import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflowsDir = resolve(import.meta.dirname, '../../.github/workflows');

function readWorkflow(name: string): string {
  return readFileSync(resolve(workflowsDir, name), 'utf8');
}

describe('npm publish workflow security', () => {
  it('keeps the slash-command request workflow unprivileged', () => {
    const workflow = readWorkflow('npm-publish-request.yml');
    const dispatcher = readWorkflow('slash-command-dispatcher.yml');

    expect(workflow).toContain('workflow_call:');
    expect(dispatcher).toContain('issue_comment:');
    expect(dispatcher).toContain("trimmed === '/publish-dev' || trimmed.startsWith('/publish-dev ')");
    expect(dispatcher).toContain('uses: ./.github/workflows/npm-publish-request.yml');
    expect(dispatcher).toContain('secrets: inherit');
    expect(workflow).toContain('pull-requests: read');
    expect(workflow).toContain('const PACKAGE_NAME_PATTERN = /^@makaio\\/[a-z0-9][a-z0-9._-]*$/u;');
    expect(workflow).toContain('const normalizedPackageNames = [];');
    expect(workflow).toContain('const invalidPackageNames = [];');
    expect(workflow).toContain('Invalid package name(s):');
    expect(workflow).toContain("core.setOutput('packages', normalizedPackageNames.join(' '));");
    expect(workflow).toContain('client-id: ${{ vars.MAKAIO_GITHUB_APP_CLIENT_ID }}');
    expect(workflow).not.toContain('app-id:');
    expect(workflow).toContain('github.rest.repos.createDeployment');
    expect(workflow).toContain("environment: 'canary'");
    expect(workflow).toContain('ref: process.env.CHECKOUT_REF');
    expect(workflow).toContain('checkout_ref: process.env.CHECKOUT_REF');
    expect(workflow).not.toContain('\n  deployments: write');
    expect(workflow).not.toContain('id-token: write');
    expect(workflow).not.toContain('actions/checkout');
    expect(workflow).not.toContain('yarn ');
    expect(workflow).not.toContain('scripts/dev-publish.ts');
  });

  it('runs dev publishing only from deployment or manual dispatch behind canary', () => {
    const workflow = readWorkflow('npm-publish.yml');

    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('const inputs = context.payload.inputs ?? {};');
    expect(workflow).toContain('const packages = inputs.packages;');
    expect(workflow).toContain("core.setOutput('dry-run', String(inputs['dry-run'] ?? 'true'));");
    expect(workflow).not.toContain('core.getInput');
    expect(workflow).toContain('deployment:');
    expect(workflow).toContain('name: canary');
    expect(workflow).toContain('deployment: false');
    expect(workflow).toContain("github.event_name == 'deployment'");
    expect(workflow).toContain("github.event.deployment.environment == 'canary'");
    expect(workflow).toContain('ref: ${{ steps.request.outputs.checkout-ref }}');
    expect(workflow).toContain('Verify checked out source');
    expect(workflow).toContain('bun scripts/dev-publish.ts publish');
    expect(workflow).toContain('permission-issues: write');
    expect(workflow).toContain('permission-pull-requests: write');
    expect(workflow).toContain('client-id: ${{ secrets.MAKAIO_GITHUB_APP_ID }}');
    expect(workflow).not.toContain('app-id:');
    expect(workflow).toContain('github-token: ${{ steps.app-token.outputs.token }}');
    expect(workflow).toContain("if: github.ref != ''");
    expect(workflow).toContain('continue-on-error: true');
    expect(workflow).not.toContain('issue_comment:');
    expect(workflow).not.toContain('/publish-dev');
  });

  it('keeps dev publish info read-only apart from the sticky PR comment', () => {
    const workflow = readWorkflow('dev-publish-info.yml');
    const dispatcher = readWorkflow('slash-command-dispatcher.yml');

    expect(workflow).toContain('workflow_call:');
    expect(dispatcher).toContain("trimmed === '/dev-publish-info' || trimmed.startsWith('/dev-publish-info ')");
    expect(dispatcher).toContain('uses: ./.github/workflows/dev-publish-info.yml');
    expect(workflow).toContain('pull-requests: read');
    expect(workflow).toContain('permission-issues: write');
    expect(workflow).toContain('permission-pull-requests: read');
    expect(workflow).toContain('<!-- makaio-dev-publish-info -->');
    expect(workflow).toContain('github.paginate(github.rest.issues.listComments');
    expect(workflow).toContain("comment.user?.type === 'Bot' && comment.body?.includes(marker)");
    expect(workflow).toContain('github.rest.issues.updateComment');
    expect(workflow).toContain('github.rest.issues.createComment');
    expect(workflow).toContain('ref: ${{ steps.pr.outputs.base-sha }}');
    expect(workflow).toContain('persist-credentials: false');
    expect(workflow).toContain('GITHUB_TOKEN: ${{ github.token }}');
    expect(workflow).toContain('http.https://github.com/.extraheader=AUTHORIZATION: basic ${auth_header}');
    expect(workflow).toContain(
      'fetch --force --tags origin "pull/${PR_NUMBER}/head:refs/remotes/pull/${PR_NUMBER}/head"',
    );
    expect(workflow).toContain('yarn exec tsx scripts/dev-publish.ts info');
    expect(workflow).not.toContain('      comment_id:\n        required: true');
    expect(workflow).not.toContain('      comment_url:\n        required: true');
    expect(workflow).not.toContain('\n  deployments: write');
    expect(workflow).not.toContain('id-token: write');
    expect(workflow).not.toContain('github.rest.repos.createDeployment');
    expect(workflow).not.toContain('bun scripts/dev-publish.ts publish');
    expect(workflow).not.toContain('npm publish');
    expect(workflow).not.toContain('git tag');
    expect(workflow).not.toContain('/publish-dev');
  });
});
