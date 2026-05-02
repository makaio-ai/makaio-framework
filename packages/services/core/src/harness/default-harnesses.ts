import type { IMakaioBus } from '@makaio/bus-core';
import { DEFAULT_HARNESSES } from '@makaio/contracts';
import { HarnessStorageSubjects, type HarnessInput } from './storage/namespace.js';

/**
 * Seeds the database with default harnesses if not already present.
 * This function is idempotent and only inserts missing harnesses, matched
 * by stable `id` — immune to key composition changes (e.g. adapterName → clientId migration).
 * @param bus - MakaioBus instance for sending storage requests
 */
export async function seedDefaultHarnesses(bus: IMakaioBus): Promise<void> {
  const { harnesses } = await bus.request(HarnessStorageSubjects.list, {});
  const existingIds = new Set(harnesses.map((harness) => harness.id));

  for (const defaultHarness of DEFAULT_HARNESSES) {
    if (existingIds.has(defaultHarness.id)) {
      continue;
    }

    const harness: HarnessInput = {
      ...defaultHarness,
    };
    await bus.request(HarnessStorageSubjects.set, { harness });
  }
}
