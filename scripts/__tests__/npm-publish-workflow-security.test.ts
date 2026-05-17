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

    expect(workflow).toContain('issue_comment:');
    expect(workflow).toContain('pull-requests: read');
    expect(workflow).toContain('permission-deployments: write');
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
    expect(workflow).toContain('deployment:');
    expect(workflow).toContain('name: canary');
    expect(workflow).toContain('deployment: false');
    expect(workflow).toContain("github.event_name == 'deployment'");
    expect(workflow).toContain("github.event.deployment.environment == 'canary'");
    expect(workflow).toContain('ref: ${{ steps.request.outputs.checkout-ref }}');
    expect(workflow).toContain('Verify checked out source');
    expect(workflow).toContain('yarn tsx scripts/dev-publish.ts publish');
    expect(workflow).toContain('permission-issues: write');
    expect(workflow).toContain('permission-pull-requests: write');
    expect(workflow).toContain('github-token: ${{ steps.app-token.outputs.token }}');
    expect(workflow).toContain("if: github.ref != ''");
    expect(workflow).toContain('continue-on-error: true');
    expect(workflow).not.toContain('issue_comment:');
    expect(workflow).not.toContain('/publish-dev');
  });
});
