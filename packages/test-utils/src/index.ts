export {
  countSubjectHandlers,
  createMockBus,
  createMockGlobalBus,
  createMockScopedBus,
  createTestBusInstance,
  expectSubjectHandlerLifecycle,
  listRegisteredSubjects,
  type BusSubjectRef,
  type MockBusResult,
  type MockGlobalBusResult,
  type MockScopedBusResult,
} from './bus-test-harness.js';

export { createTestCall, type TestCallOptions } from './call-context.js';

export { createTestHandlerContext } from './handler-context.js';

export {
  makeStubExtensionBus,
  makeStubExtensionContext,
  makeStubNodeExtensionContext,
  makeStubOpenContributionReader,
  stubExtensionIdentity,
} from './stub-extension-context.js';
