import { defineToolset } from '@makaio/tools-core';
import type { AnyToolDefinition } from '@makaio/tools-core';
import { prStatusTool } from './tool.js';

/**
 * Toolset exposing PR entity operations.
 *
 * Groups the `pr_status` tool under the `pr-entity` toolset name so it is
 * registered and listed as a coherent unit by `ToolRegistry`.
 */
export const prEntityToolset = defineToolset({
  name: 'pr-entity',
  description: 'Tools for querying enriched PR state',
  version: '0.1.0',
  tools: [prStatusTool as AnyToolDefinition],
});
