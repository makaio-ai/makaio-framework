import { describe, expect, it } from 'vitest';
import { AccessNamespace } from '../access/namespace.js';
import { JournalNamespace } from '../journal/namespace.js';
import { SubjectDirectoryNamespace } from '../journal/subject-directory-namespace.js';
import { FrameworkContractNamespaces } from '../namespace-catalog.js';
import { RightsNamespace } from '../rights/namespace.js';

describe('automation namespaces in FrameworkContractNamespaces', () => {
  it.each([
    ['makaio:journal', JournalNamespace],
    ['makaio:subjects', SubjectDirectoryNamespace],
    ['makaio:rights', RightsNamespace],
    ['makaio:access', AccessNamespace],
  ])('registers %s at boot through the catalog', (domain, namespace) => {
    expect(namespace.name).toBe(domain);
    expect(FrameworkContractNamespaces).toContain(namespace);
  });
});
