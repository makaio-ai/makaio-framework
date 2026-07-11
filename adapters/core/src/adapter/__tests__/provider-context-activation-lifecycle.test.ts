import { describe, expect, it } from 'vitest';
import { rollbackAdapterProviderContextActivationAfterFailure } from '../provider-context-activation-lifecycle.js';

describe('provider-context activation failure diagnostics', () => {
  it('sanitizes primary and cleanup errors when auth needs no account activation transaction', async () => {
    const error = await rollbackAdapterProviderContextActivationAfterFailure({
      activation: { terminal: true },
      primaryError: new Error('connector echoed explicit-api-key-value'),
      cleanup: async () => {
        throw new Error('lease cleanup echoed explicit-api-key-value');
      },
      operation: 'Explicit-auth startup',
      cleanupFailureMessage: 'Explicit-auth startup and connector cleanup both failed.',
    }).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).message).toBe('Explicit-auth startup and connector cleanup both failed.');
    expect((error as AggregateError).cause).toBeUndefined();
    expect((error as AggregateError).errors).toEqual([
      expect.objectContaining({ message: 'Explicit-auth startup connector startup failed.' }),
      expect.objectContaining({ message: 'Explicit-auth startup runtime cleanup failed.' }),
    ]);
    expect((error as AggregateError).errors.map(String).join(' ')).not.toContain('explicit-api-key-value');
  });

  it('replaces a pre-aggregated lease rollback failure when no account activation transaction exists', async () => {
    const credentialError = new Error('connector creation echoed oauth-token-value');
    const error = await rollbackAdapterProviderContextActivationAfterFailure({
      activation: { terminal: true },
      primaryError: new AggregateError(
        [credentialError, new Error('lease release echoed oauth-token-value')],
        'Connector creation and lease rollback both failed.',
        { cause: credentialError },
      ),
      operation: 'Explicit-auth inference',
      cleanupFailureMessage: 'Explicit-auth inference and connector cleanup both failed.',
    }).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).cause).toBeUndefined();
    expect((error as AggregateError).errors).toEqual([
      expect.objectContaining({ message: 'Explicit-auth inference connector startup failed.' }),
      expect.objectContaining({ message: 'Explicit-auth inference runtime rollback failed.' }),
    ]);
    expect((error as AggregateError).errors.map(String).join(' ')).not.toContain('oauth-token-value');
  });
});
