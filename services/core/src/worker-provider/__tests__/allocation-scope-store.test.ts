import type { ExtensionOperatorConfigEntry } from '@makaio/contracts';
import { createHostDatabase, getTransactionQueryContext } from '@makaio/storage-drizzle';
import { describe, expect, it } from 'vitest';
import {
  resolveStorageConformanceConfig,
  useSuiteDatabaseContext,
} from '../../../../../storage/conformance/src/index.js';
import { readAllocationScopeSetting } from '../allocation-scope-source.js';
import { readBinding, writeBindingIfAbsent } from '../allocation-scope-store.js';
import { confirmAllocationScope } from '../scope-confirmation.js';
import { decideAllocationScope } from '../scope-decision.js';

const actor = {
  caller: { kind: 'makaio.user', id: 'operator' },
  principal: { kind: 'makaio.user', id: 'operator' },
};

const config = resolveStorageConformanceConfig();
if (config === null) throw new Error('MAKAIO_STORAGE_TEST_URL is required for PostgreSQL scope tests');

describe(`worker allocation scope storage (${config.dialect})`, () => {
  const getDatabase = useSuiteDatabaseContext(config);

  it('persists the first scope and rolls back confirmations with their host transaction', async () => {
    const database = getDatabase();
    const host = createHostDatabase(database.db);
    await expect(host.transaction(async (tx) => getTransactionQueryContext(tx).dialect)).resolves.toBe(config.dialect);
    await expect(host.transaction(readBinding)).resolves.toBeUndefined();
    await expect(
      host.transaction(async (tx) => {
        await writeBindingIfAbsent(tx, 'aborted-scope', actor);
        throw new Error('abort confirmation');
      }),
    ).rejects.toThrow('abort confirmation');
    await expect(host.transaction(readBinding)).resolves.toBeUndefined();

    const setting = readAllocationScopeSetting(
      new Map<string, ExtensionOperatorConfigEntry>([
        ['example.owner', { kind: 'config', source: 'operator', config: { allocationScope: 'confirmed-scope' } }],
      ]),
      'example.owner',
    );
    await expect(confirmAllocationScope(host, setting, 'other-scope', actor)).resolves.toEqual({
      outcome: 'refused',
      code: 'setting-mismatch',
    });
    await expect(host.transaction(readBinding)).resolves.toBeUndefined();
    await expect(confirmAllocationScope(host, setting, 'confirmed-scope', actor)).resolves.toEqual({
      outcome: 'confirmed',
      effect: 'restart-required',
    });
    const first = await host.transaction(readBinding);
    expect(first?.allocationScope).toBe('confirmed-scope');
    expect(first?.confirmedBy).toBe(JSON.stringify(actor));
    await expect(confirmAllocationScope(host, setting, 'confirmed-scope', actor)).resolves.toEqual({
      outcome: 'already-confirmed',
    });
    await expect(host.transaction((tx) => writeBindingIfAbsent(tx, 'other-scope', actor))).resolves.toEqual({
      binding: first,
      inserted: false,
    });

    const sibling = await database.createSiblingClient();
    const reopened = createHostDatabase(sibling.db);
    const reloaded = await reopened.transaction(readBinding);
    expect(reloaded).toEqual(first);
    expect(decideAllocationScope(setting, reloaded?.allocationScope)).toEqual({
      kind: 'bound',
      scope: { value: 'confirmed-scope' },
    });
  });
});
