import type { IMakaioBus } from '@makaio/bus-core';
import type { IsolatedNodeExtensionContext } from '@makaio/contracts/extension';
import type { KernelExtensionContext, KernelMakaioExtension } from '@makaio/kernel';
import { expect, expectTypeOf, it } from 'vitest';
import type { IsolatedWorkflowRuntime } from '../isolated-workflow-runtime.js';

type FullStorageContext = KernelExtensionContext & { readonly database: object };

/**
 * Compile-check the coordinator's extension admission contract.
 * @param coordinator - Isolated workflow coordinator.
 * @param isolated - Extension that uses only the isolated context.
 * @param full - Extension requiring a database in its context.
 */
function checkAdmission(
  coordinator: IsolatedWorkflowRuntime['coordinator'],
  isolated: KernelMakaioExtension<IsolatedNodeExtensionContext<IMakaioBus>>,
  full: KernelMakaioExtension<FullStorageContext>,
): void {
  expectTypeOf(coordinator.load([isolated])).toEqualTypeOf<readonly (typeof isolated)[]>();
  // @ts-expect-error a factory that requires a database cannot run in the isolated coordinator
  coordinator.load([full]);
}

it('loads the compile-time admission assertions', () => {
  expect(typeof checkAdmission).toBe('function');
});
