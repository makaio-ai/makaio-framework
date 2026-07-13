export {
  SubagentFailureFinalizationError,
  SubagentService,
  type SubagentFailureFinalizationErrorCode,
} from './subagent-service.js';
export { createSubagentServicePackage, subagentServicePackage, SubagentServiceToken } from './package.js';
export { SubagentManager, type TrackOptions } from './manager/index.js';
export type {
  AwaitResult,
  InputResolver,
  InternalPendingRequest,
  SpawnOptions,
  TrackedSubagent,
} from './manager/index.js';
export { isPeerAuthorizedToDelegate } from './spawn-delegation.js';
export type { SpawnDelegationAllowSet } from './spawn-delegation.js';
