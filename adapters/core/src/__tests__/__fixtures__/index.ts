/**
 * Shared test utilities and fixtures for ai-adapters-core testing.
 *
 * This module exports reusable test fixtures that adapter implementations
 * and integration tests can use to verify adapter behavior and bus integration.
 * @example
 * ```typescript
 * import {
 *   MockTransport,
 *   createMinimalAdapter,
 *   TestAdapterNamespace,
 *   TestSubjects,
 * } from './__fixtures__';
 *
 * describe('My Adapter Test', () => {
 *   it('should emit events', async () => {
 *     const transport = new MockTransport();
 *     const adapter = createMinimalAdapter();
 *     // ... test implementation
 *   });
 * });
 * ```
 */

export { MockTransport } from './mock-transport.js';
export { createMinimalAdapter } from './test-adapter.js';
export type { MinimalAdapterOptions } from './test-adapter.js';
export { TestAdapterNamespace, TestSubjects } from './test-subjects.js';
export { BridgeTestSubjects, BridgeTestSubjects_Refs } from './bridge-test-subjects.js';
