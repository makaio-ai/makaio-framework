import { createBusInstance, ForeignOwnContextError, InvalidCallContextError } from '@makaio/bus-core';
import { createCarrierBus } from '@makaio/bus-core/kernel-api';
import { AccessSubjects, CoreDenialPlace, type AccessDenied } from '@makaio/contracts/access';
import { MAKAIO_EXTENSION_PARTY_KIND, MAKAIO_RULES_PARTY_KIND } from '@makaio/core';
import { expect, it, onTestFinished } from 'vitest';
import { createCoordinatorRights } from '../coordinator-rights.js';
import { CORE_RIGHTS_OWNER } from '../rights-directory.js';
import { collectInto, createAnswerSource } from './fixtures.js';

const ruleCarrier = { kind: MAKAIO_RULES_PARTY_KIND, id: MAKAIO_RULES_PARTY_KIND };
const ask = { right: 'policy.read', context: null };

it('refuses foreign own contexts and unminted contexts before consulting a policy', async () => {
  const bus = createBusInstance();
  const rights = createCoordinatorRights(bus, 'host');
  rights.activate(CORE_RIGHTS_OWNER, {});
  const source = createAnswerSource('policy.test', [ask.right], { kind: 'deny', reason: 'declined' });
  rights.activate('policy', {
    rights: [{ right: ask.right, description: 'Read data', context: {} }],
    rightsSources: [source],
  });
  const denials: AccessDenied[] = [];
  onTestFinished(bus.on(AccessSubjects.denied, collectInto(denials)));

  const other = createCarrierBus(bus, { kind: MAKAIO_EXTENSION_PARTY_KIND, id: 'other' });
  const otherHost = createCarrierBus(createBusInstance(), ruleCarrier);
  const call = createCarrierBus(bus, ruleCarrier).own('observer');
  const { resolveLookupRight } = rights.ruleRights;
  await expect(resolveLookupRight(other.own('observer'), ask)).rejects.toThrow(ForeignOwnContextError);
  await expect(resolveLookupRight(otherHost.own('observer'), ask)).rejects.toThrow(ForeignOwnContextError);
  await expect(resolveLookupRight(Object.assign({}, call), ask)).rejects.toThrow(InvalidCallContextError);
  expect(source.calls).toHaveLength(0);
  expect(denials).toHaveLength(0);

  await expect(resolveLookupRight(call, ask)).resolves.toMatchObject({ granted: false, reason: 'declined' });
  expect(source.calls).toHaveLength(1);
  expect(denials).toEqual([expect.objectContaining({ at: CoreDenialPlace.lookup, right: ask.right })]);
});

it('only resolves lookup rights while the built-in contribution owner is active', async () => {
  const bus = createBusInstance();
  const rights = createCoordinatorRights(bus, 'host');
  rights.activate('policy', { rights: [{ right: ask.right, description: 'Read data', context: {} }] });
  const call = createCarrierBus(bus, ruleCarrier).own('observer');
  const { resolveLookupRight } = rights.ruleRights;

  rights.beginActivation(CORE_RIGHTS_OWNER);
  await expect(resolveLookupRight(call, ask)).rejects.toThrow(/active/);
  rights.activate(CORE_RIGHTS_OWNER, {});
  await expect(resolveLookupRight(call, ask)).resolves.toEqual({ granted: true });
  rights.deactivate(CORE_RIGHTS_OWNER);
  await expect(resolveLookupRight(call, ask)).rejects.toThrow(/active/);
});
