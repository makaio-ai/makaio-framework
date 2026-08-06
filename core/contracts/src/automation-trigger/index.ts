export {
  AutomationTriggerBindingSchema,
  AutomationTriggerDescriptorSchema,
  AutomationTriggerKindSchema,
  AutomationTriggerLocalNameSchema,
} from './schemas.js';
export type { AutomationTriggerDescriptor } from './schemas.js';
export { createAutomationTriggerDescriptor, defineAutomationTrigger, toAutomationTriggerType } from './definition.js';
export type {
  AutomationTriggerActivationContext,
  AutomationTriggerBinding,
  AutomationTriggerCleanup,
  AutomationTriggerEvent,
  AutomationTriggerListener,
  AutomationTriggerParams,
  AutomationTriggerPayload,
  AutomationTriggerSubscription,
  AutomationTriggerType,
  DefinedAutomationTrigger,
} from './definition.js';
export type { ExtensionAutomationTriggersContribution } from './contribution.js';
export { AutomationTriggerNamespace, AutomationTriggerSchemas, AutomationTriggerSubjects } from './namespace.js';
export type {
  AutomationTriggerChangedPayload,
  AutomationTriggerListRequest,
  AutomationTriggerListResponse,
} from './namespace.js';
