/**
 * Case 205 and §3.3's structural additions — every adapter declares a teardown
 * class, and the weak ones explain themselves.
 *
 * **Why it lives here and not beside the other conformance cases.** The suite in
 * `__tests__/` runs one adapter per process under `MAKAIO_TEST_ADAPTER` and is
 * excluded from the default test run, because most of its cases spend real provider
 * money. This case spends none: it constructs a connector and closes it again, which
 * needs no prompt and no round trip. A gate case that no command in the gate
 * executes does not count as met, so the structural half of §3.3 runs *here*, in the
 * default suite, and only what genuinely needs the live harness stays there.
 *
 * **Why it is driven by discovery rather than by a list.** The adapters are
 * enumerated by the same authority the conformance runner uses — a descriptor that
 * contributes an adapter — and each connector is built through that adapter's own
 * conformance config, which routes creation via
 * `ConformanceConnectorRuntimeRegistry` exactly as production routes it. A
 * hard-coded list would let a new adapter arrive without answering the question,
 * which is the whole property this case exists to hold.
 */
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { TeardownEvidenceSchema, teardownWasObserved } from '@makaio/contracts';
import type { ConformanceTestConfig, CreateConformanceTestConfigOptions } from '@makaio/ai-adapters-core';
import { discoverAdapters } from '../../scripts/lib/conformance/discovery.js';
import { loadConformanceProviderDefinitions } from '../../scripts/lib/conformance/provider-catalog.js';
// Imported for its module-level harness — the framework namespaces and the
// credential channel a real connector resolves its auth through. Nothing else from
// it is used, because this case needs no agent, no session and no MCP server.
import { importAdapter } from './__tests__/shared.js';

const evidenceClasses = TeardownEvidenceSchema.options;
const adapterNames = discoverAdapters();

/**
 * Load one adapter's conformance configuration.
 * @param adapterName - Adapter directory name.
 * @returns The adapter's conformance config.
 */
async function loadTestConfig(adapterName: string): Promise<ConformanceTestConfig> {
  const imported = (await importAdapter(adapterName)) as {
    createTestConfig?: (options?: CreateConformanceTestConfigOptions) => Promise<ConformanceTestConfig>;
  };
  if (imported.createTestConfig === undefined) {
    throw new Error(
      `Adapter '${adapterName}' contributes an adapter but exports no createTestConfig, so it cannot answer §3.3. ` +
        'Add a conformance config, or stop contributing the adapter in descriptor.json.',
    );
  }
  // The provider catalog the conformance harness supplies: adapters declare stable
  // provider IDs without hard-importing provider packages, so the definitions have
  // to travel in. Loading them reads contribution modules only — no credentials, no
  // provider traffic.
  //
  // `declared-credentials` is what makes this case run the same way everywhere. Left
  // to their live-harness default, the three Claude configs select their `inferred`
  // native method, which materializes only where somebody has logged the vendor
  // client in — green on a developer machine, unmaterializable on a bare runner. The
  // selection is asked for a method whose credentials are declared instead, and
  // `withPlaceholderCredentials` below supplies them. This is not a stub standing in
  // for the seam under test: the seam under test is the teardown declaration, and the
  // connector that answers it is the adapter's real one, built through its real
  // config, holding a real client config lease.
  return imported.createTestConfig({
    providerDefinitions: await loadConformanceProviderDefinitions(),
    authSelection: 'declared-credentials',
  });
}

/**
 * Supply a placeholder for every credential this adapter's preset reads from the
 * environment, and hand back the undo.
 *
 * A connector cannot be *constructed* without its auth snapshot resolving, and the
 * adapters read theirs from an environment variable that a default test run has no
 * reason to hold. The variable names are taken from the preset's own
 * credential refs — which the provider definitions derive from their declared
 * environment source hints — so there is no second list to drift from. Nothing is
 * ever *sent*: this case closes the connector without a single round trip, which is
 * precisely why it belongs in the default run.
 *
 * A value already present is left alone, so a developer with real credentials
 * exercises the same path with them.
 * @param testConfig - Conformance config whose preset names the credentials.
 * @returns Restore function returning the environment to what it was.
 */
function withPlaceholderCredentials(testConfig: ConformanceTestConfig): () => void {
  const auth = testConfig.testProviderContext?.state === 'resolved' ? testConfig.testProviderContext.auth : undefined;
  const refs = auth?.mode === 'explicit' ? Object.values(auth.credentialRefs) : [];
  const applied: string[] = [];
  for (const ref of refs) {
    const variable = ref.startsWith('env:') ? ref.slice('env:'.length) : undefined;
    if (variable === undefined || process.env[variable] !== undefined) continue;
    process.env[variable] = 'conformance-placeholder-never-sent';
    applied.push(variable);
  }
  return () => {
    for (const variable of applied) delete process.env[variable];
  };
}

describe('§3.3: every adapter answers the teardown question', () => {
  it('enumerates the adapters from their descriptors rather than from a list', () => {
    // The guard that keeps the parameterisation below from going vacuous: an
    // enumeration that silently returned nothing would make every arm pass.
    expect(adapterNames.length).toBeGreaterThan(0);
  });

  // Case 205. Deliberately does **not** assert *which* class an adapter reports: a
  // suite cannot see a provider's internals, and one demanding `exited` would
  // manufacture exactly the dishonest claims the taxonomy exists to remove.
  it.each(adapterNames)('%s declares a class from the taxonomy, and explains a weak one', async (adapterName) => {
    const testConfig = await loadTestConfig(adapterName);
    const restoreCredentials = withPlaceholderCredentials(testConfig);
    try {
      const connector = await testConfig.createConnector({
        cwd: tmpdir(),
        agentId: crypto.randomUUID(),
        reasoningEffort: testConfig.options?.primaryModel?.reasoningEffort ?? 'low',
        model: testConfig.options?.primaryModel?.modelName,
      });
      const report = await connector.close();

      expect(
        evidenceClasses,
        `Adapter '${adapterName}' close() must resolve with a ConnectorTeardownResult whose evidence is one of ` +
          `[${evidenceClasses.join(', ')}]; received ${JSON.stringify(report)}`,
      ).toContain(report.evidence);

      if (!teardownWasObserved(report.evidence)) {
        expect(
          report.detail,
          `Adapter '${adapterName}' reported the weak class '${report.evidence}' without a detail. ` +
            'A class meaning "we cannot say more" is only actionable when it names what is unobservable.',
        ).toBeTruthy();
      }
    } finally {
      restoreCredentials();
      await testConfig.cleanup?.();
    }
  });
});
