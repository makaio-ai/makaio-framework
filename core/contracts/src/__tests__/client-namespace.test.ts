import { describe, expect, it } from 'vitest';
import { ClientSubjects } from '@makaio/contracts/client';

describe('ClientSubjects', () => {
  it('exposes scan, account, session account, and usage subjects', () => {
    expect(ClientSubjects.scan.subject).toBe('scan');
    expect(ClientSubjects.account.observe.subject).toBe('account.observe');
    expect(ClientSubjects.session.account.observe.subject).toBe('session.account.observe');
    expect(ClientSubjects.usage.ingest.subject).toBe('usage.ingest');
    expect(ClientSubjects.usage.snapshot.subject).toBe('usage.snapshot');
    expect(ClientSubjects.scan.$meta.namespace).toBe('client');
    expect(ClientSubjects.account.observe.$meta.namespace).toBe('client');
    expect(ClientSubjects.session.account.observe.$meta.namespace).toBe('client');
  });
});
