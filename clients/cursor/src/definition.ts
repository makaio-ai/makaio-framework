/**
 * Client definition for the Cursor AI code editor.
 *
 * Cursor is an AI-powered code editor with an SDK that Makaio can harness via
 * hook callbacks. This definition declares the hook events the editor fires so
 * the wiring layer knows what hooks to install.
 * @packageDocumentation
 */

import { createClientDefinition } from '@makaio/contracts';

/**
 * Static client definition for `@makaio/client-cursor`.
 *
 * Cursor exposes hook callbacks (`preToolUse`, `afterFileEdit`) that Makaio
 * installs to observe tool invocations and file edits. The `cursor` binary is
 * used for CLI detection during onboarding. All tool invocations default to
 * `always-ask` approval policy.
 */
const cursorClientDefinitionInput: Parameters<typeof createClientDefinition>[0] = {
  id: 'cursor',
  name: 'Cursor',
  version: '0.1.0',
  description: 'Cursor — AI-powered code editor with SDK',
  binary: {
    name: 'cursor',
    supportedVersions: '*',
  },
  configIsolation: { envVar: 'CURSOR_HOME', defaultPath: '~/.cursor' },
  defaultApprovalPolicy: 'always-ask',
  authMethods: [],
  runtimeCapabilities: {
    supportsHooks: true,
    hookEvents: [
      { name: 'preToolUse', frameworkSubject: 'client.session.tool.pre', mode: 'request' },
      { name: 'afterFileEdit' },
    ],
  },
};

export const clientDefinition = createClientDefinition(cursorClientDefinitionInput);
