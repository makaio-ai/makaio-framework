import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import type { ProviderDefinitionInput } from '@makaio/contracts';
import { PROVIDERS_PATH } from './types.js';

type ProviderModule = {
  providerDefinition?: ProviderDefinitionInput;
  providerDefinitions?: readonly ProviderDefinitionInput[];
};

let providerDefinitionsCache: readonly ProviderDefinitionInput[] | undefined;

/**
 * Load provider definitions from framework provider contribution packages.
 *
 * The conformance harness owns this dynamic discovery so adapter packages can
 * keep declaring stable provider IDs without hard-importing provider packages.
 * @returns Provider definitions available to conformance tests
 */
export async function loadConformanceProviderDefinitions(): Promise<readonly ProviderDefinitionInput[]> {
  if (providerDefinitionsCache) return providerDefinitionsCache;

  const definitions: ProviderDefinitionInput[] = [];
  const seen = new Set<string>();

  for (const dirent of readdirSync(PROVIDERS_PATH, { withFileTypes: true })) {
    if (!dirent.isDirectory() || dirent.name.startsWith('.') || dirent.name.includes('node_modules')) continue;

    const jsModulePath = join(PROVIDERS_PATH, dirent.name, 'src/index.js');
    const tsModulePath = join(PROVIDERS_PATH, dirent.name, 'src/index.ts');
    const modulePath = existsSync(jsModulePath) ? jsModulePath : existsSync(tsModulePath) ? tsModulePath : undefined;
    if (!modulePath) continue;

    const providerModule = (await import(pathToFileURL(modulePath).href)) as ProviderModule;
    const moduleDefinitions = providerModule.providerDefinitions ?? [];
    const singleDefinition = providerModule.providerDefinition ? [providerModule.providerDefinition] : [];

    for (const definition of [...moduleDefinitions, ...singleDefinition]) {
      if (seen.has(definition.id)) continue;
      seen.add(definition.id);
      definitions.push(definition);
    }
  }

  providerDefinitionsCache = definitions;
  return providerDefinitionsCache;
}
