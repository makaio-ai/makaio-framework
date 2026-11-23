import { describe, expect, it } from 'vitest';
import * as kernelApi from '../kernel-api.js';
import * as packageIndex from '../index.js';

// ---------------------------------------------------------------------------
// Expected lists (explicit and sorted, so a later change shows up as a diff)
// ---------------------------------------------------------------------------

/** The kernel names (call contexts, carrier buses, namespace ownership), exported by `kernel-api.ts` only. */
const KERNEL_NAMES = [
  'CORE_NAMESPACE_PREFIXES',
  'HOST_NAMESPACE_HOLDER',
  'NamespaceOwnershipError',
  'assertCallCarrier',
  'busCarrierOf',
  'busContextOf',
  'callFromReceive',
  'createBusContext',
  'createCarrierBus',
  'createFilteredBus',
  'hasNamespace',
  'hostPartyOf',
  'leaseNamespace',
  'listOwners',
  'mintCallContext',
  'namespaceOf',
  'ownCarrierOf',
  'ownerOf',
] as const;

/** Bus-core internals that neither entry point may export. */
const INTERNAL_NAMES = [
  'buildBusInstance',
  'busCarrierOf',
  'busContextOf',
  'createCarrierBus',
  'deriveSent',
  'enterSend',
  'mintCallContext',
] as const;

/** Call-context names the package index must export for extension authors. */
const AUTHOR_NAMES = [
  'ForeignOwnContextError',
  'InvalidCallContextError',
  'MakaioBus',
  'createBusInstance',
  'isMintedCallContext',
] as const;

describe('kernel-api entry point', () => {
  it('exports exactly the kernel names', () => {
    expect(Object.keys(kernelApi).sort()).toEqual([...KERNEL_NAMES]);
  });
});

describe('package index', () => {
  it.each(KERNEL_NAMES)('does not export the kernel name %s', (name) => {
    expect(Object.keys(packageIndex)).not.toContain(name);
  });

  it.each(INTERNAL_NAMES)('does not export the internal name %s', (name) => {
    expect(Object.keys(packageIndex)).not.toContain(name);
  });

  it.each(AUTHOR_NAMES)('exports the author-facing name %s', (name) => {
    expect(Object.keys(packageIndex)).toContain(name);
  });

  it('exports no internal name from the kernel entry point either', () => {
    const kernelExports = Object.keys(kernelApi);
    expect(kernelExports).not.toContain('buildBusInstance');
    expect(kernelExports).not.toContain('enterSend');
    expect(kernelExports).not.toContain('deriveSent');
  });
});
