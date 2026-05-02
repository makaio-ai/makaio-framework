import { defineToolset } from '@makaio/tools-core';
import type { AnyToolDefinition } from '@makaio/tools-core';
import { reviewFindingsTool } from './tool.js';

/**
 * Review toolset.
 * Groups the review_findings tool for registration with the framework tool registry.
 */
export const reviewToolset = defineToolset({
  name: 'review',
  description: 'Tools for managing review findings from external reviewers and agents',
  version: '0.1.0',
  tools: [reviewFindingsTool as AnyToolDefinition],
});
