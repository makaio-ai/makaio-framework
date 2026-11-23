import { describe, expect, it } from 'vitest';
import { renderPromptTemplate, resolveTemplate, TemplatePlaceholderError } from '../template.js';
import type { ExpressionContext } from '../types.js';

/** A prompt interpolation input and its expected rendered text. */
type PromptTemplateCase = {
  name: string;
  context: ExpressionContext;
  expected: string;
};

const promptTemplateCases: PromptTemplateCase[] = [
  { name: 'renders text verbatim', context: { value: 'Hello Ada' }, expected: 'Result: Hello Ada' },
  { name: 'renders a number as text', context: { value: 42 }, expected: 'Result: 42' },
  {
    name: 'renders an object as indented JSON',
    context: { value: { name: 'Ada' } },
    expected: 'Result: {\n  "name": "Ada"\n}',
  },
  {
    name: 'renders an array as indented JSON',
    context: { value: ['Ada', 7] },
    expected: 'Result: [\n  "Ada",\n  7\n]',
  },
  { name: 'renders a missing path as an empty string', context: {}, expected: 'Result: ' },
];

describe('renderPromptTemplate', () => {
  it.each(promptTemplateCases)('$name', ({ context, expected }) => {
    expect(renderPromptTemplate('Result: {{ value }}', context)).toBe(expected);
  });

  it('throws TemplatePlaceholderError with the failed expression', () => {
    expect.assertions(2);

    try {
      renderPromptTemplate('Result: {{  value +  }}', { value: 42 });
    } catch (error) {
      expect(error).toBeInstanceOf(TemplatePlaceholderError);
      expect(error).toMatchObject({ expression: 'value +' });
    }
  });
});

describe('resolveTemplate', () => {
  it('keeps the existing string coercion for objects', () => {
    expect(resolveTemplate('Result: {{ value }}', { value: { name: 'Ada' } })).toBe('Result: [object Object]');
  });
});
