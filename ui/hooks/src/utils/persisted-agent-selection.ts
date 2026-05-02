import { AgentSelectionSchema, type AgentSelection, type AgentSelectionBase } from '@makaio/contracts';

export type PersistableAdapterSelection = Extract<AgentSelection, { kind: 'adapter' }> & {
  providerConfigId: string;
  model: string;
};

export type PersistableProjectSelection = Exclude<AgentSelection, { kind: 'adapter' }> | PersistableAdapterSelection;

/**
 * Parse persisted browser selection state into the current AgentSelection union.
 *
 * The wire schema intentionally stays open for host-tier extension. Browser
 * persistence is stricter: only current application kinds are accepted, with
 * one-way migration for legacy `'model'` and `'virtualModel'` payloads.
 * @param value - Raw persisted value from storage/preferences
 * @returns Current AgentSelection, or null when the payload is stale/invalid
 */
export function parsePersistedAgentSelection(value: unknown): AgentSelection | null {
  const parsed = AgentSelectionSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }

  const selection = parsed.data as Record<string, unknown>;

  if (selection.kind === 'model') {
    const adapterName = asNonEmptyString(selection.adapterName);
    const model = asNonEmptyString(selection.model);
    const providerConfigId = asNonEmptyString(selection.providerConfigId) ?? asNonEmptyString(selection.providerId);
    if (!adapterName || !model) {
      return null;
    }
    return {
      kind: 'adapter',
      adapterName,
      model,
      ...(providerConfigId ? { providerConfigId } : {}),
    } as AgentSelectionBase as AgentSelection;
  }

  if (selection.kind === 'virtualModel') {
    const virtualModelId = asNonEmptyString(selection.virtualModelId);
    return virtualModelId ? ({ kind: 'virtual-model', virtualModelId } as AgentSelectionBase as AgentSelection) : null;
  }

  switch (selection.kind) {
    case 'adapter': {
      const adapterName = asNonEmptyString(selection.adapterName);
      if (!adapterName) {
        return null;
      }
      const model = asNonEmptyString(selection.model);
      const providerConfigId = asNonEmptyString(selection.providerConfigId);
      return {
        kind: 'adapter',
        adapterName,
        ...(model ? { model } : {}),
        ...(providerConfigId ? { providerConfigId } : {}),
      } as AgentSelectionBase as AgentSelection;
    }
    case 'persona': {
      const personaId = asNonEmptyString(selection.personaId);
      return personaId ? ({ kind: 'persona', personaId } as AgentSelectionBase as AgentSelection) : null;
    }
    case 'profile': {
      const profileId = asNonEmptyString(selection.profileId);
      return profileId ? ({ kind: 'profile', profileId } as AgentSelectionBase as AgentSelection) : null;
    }
    case 'virtual-model': {
      const virtualModelId = asNonEmptyString(selection.virtualModelId);
      return virtualModelId
        ? ({ kind: 'virtual-model', virtualModelId } as AgentSelectionBase as AgentSelection)
        : null;
    }
    default:
      return null;
  }
}

/**
 * Project defaults must be concrete and lossless when persisted.
 * @param selection - Candidate selection from UI state
 * @returns True when the selection can be stored as an explicit project default
 */
export function isPersistableProjectSelection(selection: AgentSelection): selection is PersistableProjectSelection {
  if (selection.kind !== 'adapter') {
    return true;
  }
  return (
    typeof selection.adapterName === 'string' &&
    selection.adapterName.trim().length > 0 &&
    typeof selection.providerConfigId === 'string' &&
    selection.providerConfigId.trim().length > 0 &&
    typeof selection.model === 'string' &&
    selection.model.trim().length > 0
  );
}

/**
 * Normalize unknown persisted values to trimmed non-empty strings.
 * @param value - Candidate persisted field value.
 * @returns Trimmed string content, or null when the value is empty/invalid.
 */
function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
