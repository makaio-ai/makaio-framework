/**
 * Client definition for Qwen Code.
 *
 * Qwen Code is an agentic coding assistant binary (`qwen`) that Makaio
 * harnesses via the qwen-acp adapter using the Agent Client Protocol.
 * @packageDocumentation
 */

import { createClientDefinition } from '@makaio/contracts';

/**
 * Static client definition for `@makaio/client-qwen`.
 *
 * Qwen exposes tools via ACP (Agent Client Protocol), so native tools
 * are discovered dynamically at runtime rather than declared statically.
 */
export const clientDefinition = createClientDefinition({
  id: 'qwen',
  name: 'Qwen Code',
  version: '0.1.0',
  description: 'Qwen Code CLI — an agentic coding assistant via ACP',
  binary: {
    name: 'qwen',
    supportedVersions: '*',
  },
  configIsolation: {
    envVar: 'QWEN_CODE_SYSTEM_DEFAULTS_PATH',
    defaultPath: '/etc/qwen-code/system-defaults.json',
    pathKind: 'file',
  },
  defaultApprovalPolicy: 'always-ask',
  defaultProviderId: 'qwen-oauth',
});
