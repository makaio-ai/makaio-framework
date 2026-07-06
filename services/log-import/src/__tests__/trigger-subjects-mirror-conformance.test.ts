/**
 * Conformance pin for the `LogImportTriggerSubjects` mirror.
 *
 * The observed-session ingestion component (services-core) cannot import this
 * package's subject definitions without creating a package cycle, so it ships
 * a minimal local mirror of the three subjects it calls. That mirror is a
 * type carrier, not a second source of truth — this suite makes that claim
 * enforceable instead of aspirational:
 *
 * - Subject addressing: the mirror resolves to the same fully-qualified
 *   subject names as the canonical namespace.
 * - Request direction (caller → owning service): every payload the mirror
 *   type admits must be a valid canonical request.
 * - Response direction (owning service → caller): every canonical response
 *   must be readable through the mirror's (subset) response type.
 *
 * If a canonical contract change breaks one of these, this test fails in the
 * owning package — the drift is caught where the contract lives.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { ExtractSubjectPayload, ExtractSubjectResponse } from '@makaio/core';
import { LogImportTriggerSubjects } from '@makaio/services-core/session';

import { LogImportSubjects } from '../namespace.js';

type MirrorListImportersRequest = ExtractSubjectPayload<typeof LogImportTriggerSubjects.listImporters>;
type MirrorListImportersResponse = ExtractSubjectResponse<typeof LogImportTriggerSubjects.listImporters>;
type MirrorImportFileRequest = ExtractSubjectPayload<typeof LogImportTriggerSubjects.importFile>;
type MirrorImportFileResponse = ExtractSubjectResponse<typeof LogImportTriggerSubjects.importFile>;
type MirrorImportSessionRequest = ExtractSubjectPayload<typeof LogImportTriggerSubjects.importSession>;
type MirrorImportSessionResponse = ExtractSubjectResponse<typeof LogImportTriggerSubjects.importSession>;

type CanonicalListImportersRequest = ExtractSubjectPayload<typeof LogImportSubjects.listImporters>;
type CanonicalListImportersResponse = ExtractSubjectResponse<typeof LogImportSubjects.listImporters>;
type CanonicalImportFileRequest = ExtractSubjectPayload<typeof LogImportSubjects.importFile>;
type CanonicalImportFileResponse = ExtractSubjectResponse<typeof LogImportSubjects.importFile>;
type CanonicalImportSessionRequest = ExtractSubjectPayload<typeof LogImportSubjects.importSession>;
type CanonicalImportSessionResponse = ExtractSubjectResponse<typeof LogImportSubjects.importSession>;

describe('LogImportTriggerSubjects mirror conformance', () => {
  it('addresses the same fully-qualified subjects as the canonical namespace', () => {
    expect(LogImportTriggerSubjects.listImporters.subject).toBe(LogImportSubjects.listImporters.subject);
    expect(LogImportTriggerSubjects.importFile.subject).toBe(LogImportSubjects.importFile.subject);
    expect(LogImportTriggerSubjects.importSession.subject).toBe(LogImportSubjects.importSession.subject);
  });

  it('mirror requests are valid canonical requests (caller → owning service)', () => {
    expectTypeOf<MirrorListImportersRequest>().toExtend<CanonicalListImportersRequest>();
    expectTypeOf<MirrorImportFileRequest>().toExtend<CanonicalImportFileRequest>();
    expectTypeOf<MirrorImportSessionRequest>().toExtend<CanonicalImportSessionRequest>();
  });

  it('canonical responses are readable through the mirror types (owning service → caller)', () => {
    expectTypeOf<CanonicalListImportersResponse>().toExtend<MirrorListImportersResponse>();
    expectTypeOf<CanonicalImportFileResponse>().toExtend<MirrorImportFileResponse>();
    expectTypeOf<CanonicalImportSessionResponse>().toExtend<MirrorImportSessionResponse>();
  });
});
