import type { IMakaioBus } from '@makaio/bus-core';
import { DEFAULT_HARNESSES } from '@makaio/contracts';
import type { CallContext } from '@makaio/core';
import { HarnessStorageSubjects, type HarnessInput } from './storage/namespace.js';

/**
 * Seeds the database with default harnesses if not already present.
 * This function is idempotent and only inserts missing harnesses, matched
 * by stable `id` — immune to key composition changes (e.g. adapterName → clientId migration).
 * @param call - Startup call context of the seeding service, forwarded to every storage request
 * @param bus - MakaioBus instance for sending storage requests
 */
export async function seedDefaultHarnesses(call: CallContext, bus: IMakaioBus): Promise<void> {
  const { harnesses } = await bus.request(call, HarnessStorageSubjects.list, {});
  const existingIds = new Set(harnesses.map((harness) => harness.id));

  for (const defaultHarness of DEFAULT_HARNESSES) {
    if (existingIds.has(defaultHarness.id)) {
      continue;
    }

    const harness: HarnessInput = {
      ...defaultHarness,
    };
    await bus.request(call, HarnessStorageSubjects.set, { harness });
  }
}
