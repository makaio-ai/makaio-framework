import { describe, expect, it } from 'vitest';
import { normalizeOpenAIModel, normalizeOpenAIModels } from '../model-normalization.js';

describe('normalizeOpenAIModel', () => {
  it('prefers id for the callable model name', () => {
    const model = normalizeOpenAIModel({ id: 'gpt-4o', name: 'GPT-4o' }, 'openai');

    expect(model).toMatchObject({
      name: 'gpt-4o',
      friendlyName: 'GPT-4o',
      labId: 'openai',
    });
  });

  it('uses name as the callable model name when id is absent', () => {
    const model = normalizeOpenAIModel({ name: 'provider-only-name' });

    expect(model.name).toBe('provider-only-name');
    expect(model.friendlyName).toBe('provider-only-name');
  });

  it('falls back to unknown only when id and name are absent', () => {
    const model = normalizeOpenAIModel({ display_name: 'Display Only' });

    expect(model.name).toBe('unknown');
    expect(model.friendlyName).toBe('Display Only');
  });

  it('uses 0 as the unknown context-window sentinel', () => {
    const model = normalizeOpenAIModel({ id: 'no-context-model' });

    expect(model.contextWindowSize).toBe(0);
  });

  it('normalizes arrays and preserves labId', () => {
    const models = normalizeOpenAIModels([{ id: 'model-a' }, { name: 'model-b' }], 'lab-a');

    expect(models.map((model) => ({ name: model.name, labId: model.labId }))).toEqual([
      { name: 'model-a', labId: 'lab-a' },
      { name: 'model-b', labId: 'lab-a' },
    ]);
  });
});
