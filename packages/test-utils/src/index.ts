export {
  countSubjectHandlers,
  createMockBus,
  createMockGlobalBus,
  createMockScopedBus,
  createTestBusInstance,
  expectSubjectHandlerLifecycle,
  type BusSubjectRef,
  type MockBusResult,
  type MockGlobalBusResult,
  type MockScopedBusResult,
} from './bus-test-harness.js';

export {
  makeStubExtensionContext,
  makeStubNodeExtensionContext,
  makeStubOpenContributionReader,
  stubExtensionIdentity,
} from './stub-extension-context.js';
