/**
 * Client definition for the OpenAI Codex CLI.
 *
 * Codex is a first-party agentic coding assistant binary (`codex`) that
 * Makaio harnesses via the codex-app-server adapter. Capability annotations
 * are derived from `codexCapabilityMap` in `@makaio/contracts` to keep
 * capability taxonomy in a single canonical location.
 * @packageDocumentation
 */

import { codexCapabilityMap, createClientDefinition } from '@makaio/contracts';

/**
 * Static client definition for `@makaio/client-codex`.
 *
 * Declares the two native tools the `codex` binary exposes (`bash` and
 * `patch`) and the recommended default approval policy for new harnesses
 * targeting this client.
 */
export const clientDefinition = createClientDefinition({
  id: 'codex',
  name: 'Codex',
  version: '0.1.0',
  description: 'OpenAI Codex CLI — an agentic coding assistant',
  binary: {
    name: 'codex',
    supportedVersions: '0.130.0',
  },
  managedInstall: {
    type: 'npm',
    package: '@openai/codex',
    version: '0.130.0',
  },
  versionCommand: {
    executable: {
      default: 'node_modules/.bin/codex',
      win32: 'node_modules/.bin/codex.cmd',
    },
    args: ['--version'],
  },
  configIsolation: { envVar: 'CODEX_HOME', defaultPath: '~/.codex' },
  nativeTools: [
    {
      name: 'bash',
      friendlyName: 'Terminal',
      description: 'Execute shell commands in the Codex sandbox',
      category: 'System',
      capabilities: (codexCapabilityMap.bash ?? []).map((tag) => ({ tag })),
    },
    {
      name: 'patch',
      friendlyName: 'Patch File',
      description: 'Apply unified diff patches to files',
      category: 'Files',
      capabilities: (codexCapabilityMap.patch ?? []).map((tag) => ({ tag })),
    },
  ],
  defaultApprovalPolicy: 'full-access',
  authMethods: [
    {
      id: 'native',
      mode: 'inferred',
      label: 'Native account',
    },
    {
      id: 'access-token',
      mode: 'explicit',
      label: 'Access token',
      fields: [
        {
          id: 'accessToken',
          label: 'Access token',
          required: true,
          secret: true,
          sourceHints: [{ kind: 'environment', variable: 'CODEX_ACCESS_TOKEN' }],
        },
      ],
    },
  ],
  defaultAuth: {
    providerDefinitionId: 'openai-codex',
    methodId: 'native',
  },
  runtimeCapabilities: {
    supportsHooks: true,
    supportsStatusline: false,
    supportsSupervisorLaunch: true,
    supportsManagedBinary: true,
    hookEvents: [
      { name: 'SessionStart', frameworkSubject: 'client.session.started' },
      {
        name: 'UserPromptSubmit',
        frameworkSubject: 'client.session.userPrompt.submitted',
      },
      { name: 'PreToolUse', frameworkSubject: 'client.session.tool.pre' },
      { name: 'PostToolUse', frameworkSubject: 'client.session.tool.post' },
      { name: 'Stop', frameworkSubject: 'client.session.turn.completed' },
    ],
  },
});
