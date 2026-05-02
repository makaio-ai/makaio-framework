/**
 * Resolve a provider definition by ID and require a concrete `defaultModel`.
 * @param definitions - Available provider definitions for an adapter.
 * @param definitionId - Provider definition identifier to resolve.
 * @returns The matching definition with a guaranteed `defaultModel`.
 * @throws Error when the definition does not exist or does not define `defaultModel`.
 */
export function getDefinitionOrThrow<TDefinition extends { id: string; defaultModel?: string }>(
  definitions: TDefinition[],
  definitionId: string,
): TDefinition & { defaultModel: string } {
  const definition = definitions.find((candidate) => candidate.id === definitionId);
  if (!definition) {
    throw new Error(`Provider definition not found: '${definitionId}'`);
  }
  if (!hasDefaultModel(definition)) {
    throw new Error(`Provider definition '${definitionId}' is missing a defaultModel`);
  }

  return definition;
}

/**
 * Narrow a provider definition to one with a concrete `defaultModel`.
 * @param definition - Provider definition candidate to narrow.
 * @returns True when `defaultModel` is present.
 */
function hasDefaultModel<TDefinition extends { defaultModel?: string }>(
  definition: TDefinition,
): definition is TDefinition & { defaultModel: string } {
  return typeof definition.defaultModel === 'string' && definition.defaultModel.length > 0;
}
