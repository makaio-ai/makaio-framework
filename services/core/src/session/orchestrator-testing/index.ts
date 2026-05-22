/**
 * Re-export of orchestrator testing utilities.
 *
 * This file exists so that `@makaio/services-core/session/orchestrator-testing`
 * resolves correctly via both tsconfig paths and package.json exports (which are
 * auto-generated from tsdown entry paths).
 */
export {
  collectTurnCompletedEvents,
  collectTurnStartedEvents,
  collectUserMessageAcknowledgedEvents,
  collectUserMessageCompletedEvents,
  collectUserMessageSentEvents,
  createMockAgent,
  createMockSession,
  emitAdapterInitialized,
  emitAgentAdded,
  emitAgentComplete,
  emitAgentError,
  getStoredEvents,
  registerAgentAddedHandler,
  registerCapturingStartAgentHandler,
  registerCreateSessionHandler,
  registerCwdChangeHandler,
  registerFailingSendMessageHandler,
  registerFailingStartAgentHandler,
  registerGetAgentHandler,
  registerGetSessionHandler,
  registerModelChangeHandler,
  registerRehydrateAgentHandler,
  registerSendMessageHandler,
  registerStartAgentHandler,
  resetBusHandlers,
  waitForAsync,
} from '../testing/orchestrator-shared.js';
export type { EventCollector, MockSessionConfig, UnsubscribeFunction } from '../testing/orchestrator-shared.js';
