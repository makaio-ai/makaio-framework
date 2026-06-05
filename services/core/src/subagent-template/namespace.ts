import { createBusNamespace } from '@makaio/core';
import { SubagentTemplateKernelSchemas } from './schemas.js';

/**
 * SubagentTemplate namespace schemas.
 *
 * Split into two concerns:
 * - settings:subagentTemplate.* - Definition CRUD (handled by SettingsService)
 * - subagentTemplate.* - Runtime lifecycle (handled by SubagentTemplateService)
 */

export const SubagentTemplateKernelNamespace = createBusNamespace('subagentTemplate', SubagentTemplateKernelSchemas);

export const SubagentTemplateSubjects = SubagentTemplateKernelNamespace.subjects;
