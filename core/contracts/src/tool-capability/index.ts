/**
 * Public API for the tool-capability taxonomy module.
 * @packageDocumentation
 */

export {
  computeMetaTags,
  DESTRUCTIVE_CAPABILITIES,
  READ_ONLY_CAPABILITIES,
  ToolCapability,
  ToolCapabilitySchema,
} from './capabilities.js';
export type { ToolMetaTag } from './capabilities.js';
export type { CapabilityGroup, CapabilityItem, CapabilityPickerValue } from './picker-types.js';
