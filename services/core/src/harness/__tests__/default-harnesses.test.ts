import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { DEFAULT_HARNESSES } from '@makaio/contracts';
import { seedDefaultHarnesses } from '../default-harnesses.js';
import { HarnessStorageSubjects } from '../storage/namespace.js';
import { createHarness, createTestDb } from './shared.js';

describe('seedDefaultHarnesses', () => {
  let cleanup: () => void;

  beforeEach(async () => {
    MakaioBus.__resetHandlers?.();
    const ctx = await createTestDb();
    cleanup = ctx.cleanup;
  });

  afterEach(() => {
    cleanup();
    MakaioBus.__resetHandlers?.();
  });

  it('seeds all default harnesses when missing', async () => {
    await seedDefaultHarnesses(MakaioBus);

    const { harnesses } = await MakaioBus.request(HarnessStorageSubjects.list, {});
    expect(harnesses).toHaveLength(DEFAULT_HARNESSES.length);

    const ids = new Set(harnesses.map((harness) => harness.id));
    for (const definition of DEFAULT_HARNESSES) {
      expect(ids.has(definition.id)).toBe(true);
    }
  });

  it('is idempotent across repeated runs', async () => {
    await seedDefaultHarnesses(MakaioBus);
    await seedDefaultHarnesses(MakaioBus);

    const { harnesses } = await MakaioBus.request(HarnessStorageSubjects.list, {});
    expect(harnesses).toHaveLength(DEFAULT_HARNESSES.length);
  });

  it('does not overwrite a user-customized default harness (same id)', async () => {
    const existingDefault = DEFAULT_HARNESSES[0];
    if (!existingDefault) {
      throw new Error('Expected at least one default harness');
    }

    // Simulate user customizing the default harness — keeps the same id,
    // changes the description.  Matching by id (not composite key) ensures
    // robustness across clientId/adapterName migrations.
    await MakaioBus.request(HarnessStorageSubjects.set, {
      harness: createHarness({
        id: existingDefault.id,
        name: existingDefault.name,
        clientId: existingDefault.clientId,
        adapterName: existingDefault.adapterName,
        description: 'User customized default harness',
      }),
    });

    await seedDefaultHarnesses(MakaioBus);

    const { harnesses } = await MakaioBus.request(HarnessStorageSubjects.list, {
      clientId: existingDefault.clientId,
      adapterName: existingDefault.adapterName,
      name: existingDefault.name,
    });
    expect(harnesses).toHaveLength(1);
    expect(harnesses[0]?.id).toBe(existingDefault.id);
    expect(harnesses[0]?.description).toBe('User customized default harness');
  });
});
