import { describe, expect, it } from 'vitest';

import { isDefinitionInvalidError, WorkflowError, WorkflowErrorCode } from '../errors';

type DefinitionInvalidErrorCase = {
  name: string;
  error: Error;
  expected: boolean;
};

const message = 'Stored workflow definition is invalid';
const cases: DefinitionInvalidErrorCase[] = [
  {
    name: 'recognizes a WorkflowError with the definition-invalid code',
    error: new WorkflowError(WorkflowErrorCode.DEFINITION_INVALID, message),
    expected: true,
  },
  {
    name: 'recognizes an Error caused by a definition-invalid WorkflowError',
    error: new Error(message, {
      cause: new WorkflowError(WorkflowErrorCode.DEFINITION_INVALID, message),
    }),
    expected: true,
  },
  {
    name: 'recognizes an Error with its own definition-invalid code property',
    error: Object.assign(new Error(message), { code: WorkflowErrorCode.DEFINITION_INVALID }),
    expected: true,
  },
  {
    name: 'rejects a WorkflowError with a different code',
    error: new WorkflowError(WorkflowErrorCode.NOT_EXECUTABLE, message),
    expected: false,
  },
  {
    name: 'rejects an Error with the same message but no code',
    error: new Error(message),
    expected: false,
  },
];

describe('isDefinitionInvalidError', () => {
  it.each(cases)('$name', ({ error, expected }) => {
    expect(isDefinitionInvalidError(error)).toBe(expected);
  });
});
