/**
 * Client definition for GitHub Copilot.
 *
 * GitHub Copilot is an SDK-only AI pair programming assistant with a
 * `copilot` CLI binary used for detection. It has no native tools of
 * its own. Harnesses targeting this client default to `always-ask` to
 * ensure all tool invocations require explicit user approval.
 * @packageDocumentation
 */

import { createClientDefinition } from '@makaio/contracts';

/**
 * Static client definition for `@makaio/client-github-copilot`.
 *
 * GitHub Copilot exposes no native tools (SDK-only integration). The
 * `copilot` binary is used for CLI detection during onboarding. All
 * tool invocations default to `always-ask` approval policy.
 */
export const clientDefinition = createClientDefinition({
  id: 'github-copilot',
  name: 'GitHub Copilot',
  description: 'GitHub Copilot — AI pair programming assistant',
  binaryName: 'copilot',
  configIsolation: { envVar: 'COPILOT_HOME', defaultPath: '~/.copilot' },
  defaultApprovalPolicy: 'always-ask',
  defaultProviderId: 'github-copilot',
});
