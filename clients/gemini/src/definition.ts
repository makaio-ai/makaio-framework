/**
 * Client definition for Google Gemini.
 *
 * Gemini is Google's AI assistant binary (`gemini`) that Makaio
 * harnesses via the gemini-sdk adapter.
 * @packageDocumentation
 */

import { createClientDefinition } from '@makaio/contracts';

/**
 * Static client definition for `@makaio/client-gemini`.
 *
 * Gemini exposes tools dynamically at runtime. Native tools are not
 * declared statically in this definition.
 */
export const clientDefinition = createClientDefinition({
  id: 'gemini',
  name: 'Gemini',
  version: '0.1.0',
  description: 'Google Gemini CLI — AI assistant',
  binary: {
    name: 'gemini',
    supportedVersions: '*',
  },
  configIsolation: {
    envVar: 'GEMINI_CLI_SYSTEM_SETTINGS_PATH',
    defaultPath: '~/.gemini/settings.json',
    pathKind: 'file',
  },
  defaultApprovalPolicy: 'always-ask',
  defaultProviderId: 'google-oauth',
});
