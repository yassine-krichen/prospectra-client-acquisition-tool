import { beforeEach, describe, expect, it, vi } from 'vitest';

// This is an orchestration test: each individual source is tested on its own
// (hunter.source.test.ts, peopledatalabs.source.test.ts) and the DB layer is
// exercised for real in prospects.repository.test.ts/hunter.source.test.ts,
// so only enrichment.service.ts's own fallback-chain and persistence logic
// is under test here. `smtp-verify.ts`'s DNS check is mocked (same boundary
// its own test suite mocks); `pattern-guess.ts` is left real since it's a
// pure function already covered by its own test.
const { prospectMock, findUniqueMock, updateMock } = vi.hoisted(() => {
  const findUnique = vi.fn();
  const update = vi.fn();
  return { prospectMock: { findUnique, update }, findUniqueMock: findUnique, updateMock: update };
});

vi.mock('@/common/db/client', () => ({ prisma: { prospect: prospectMock } }));

const runHunterEnrichmentMock = vi.fn();
vi.mock('@/features/enrichment/hunter.source', () => ({ runHunterEnrichment: runHunterEnrichmentMock }));

const runPeopleDataLabsEnrichmentMock = vi.fn();
vi.mock('@/features/enrichment/peopledatalabs.source', () => ({
  runPeopleDataLabsEnrichment: runPeopleDataLabsEnrichmentMock,
}));

const domainAcceptsEmailMock = vi.fn();
vi.mock('@/features/enrichment/smtp-verify', () => ({ domainAcceptsEmail: domainAcceptsEmailMock }));

const { enrichProspect } = await import('./enrichment.service');

interface ProspectRowOverrides {
  id?: string;
  domain?: string | null;
  contactName?: string | null;
  contactEmail?: string | null;
  emailVerified?: boolean;
  emailConfidence?: number;
  status?: string;
  statusHistory?: unknown;
}

function buildProspectRow(overrides: ProspectRowOverrides = {}) {
  return {
    id: overrides.id ?? 'prospect-1',
    companyName: 'Acme Inc',
    domain: overrides.domain === undefined ? 'acme.com' : overrides.domain,
    contactName: overrides.contactName ?? null,
    contactTitle: null,
    contactEmail: overrides.contactEmail ?? null,
    emailVerified: overrides.emailVerified ?? false,
    emailConfidence: overrides.emailConfidence ?? 0,
    linkedinUrl: null,
    status: overrides.status ?? 'new',
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    statusHistory: overrides.statusHistory ?? [],
  };
}

const hunterContact = {
  contactName: 'Jane Hunter',
  contactTitle: 'CEO',
  contactEmail: 'jane@acme.com',
  emailVerified: true,
  emailConfidence: 95,
  linkedinUrl: 'https://linkedin.com/in/janehunter',
};

const pdlContact = {
  contactName: 'Jane PDL',
  contactTitle: 'COO',
  contactEmail: 'jane.pdl@acme.com',
  emailVerified: true,
  emailConfidence: 80,
  linkedinUrl: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  updateMock.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({ ...buildProspectRow(), ...data })
  );
});

describe('enrichProspect', () => {
  it('returns null (mapped to a 404 by the route) when no prospect exists with the given id', async () => {
    findUniqueMock.mockResolvedValue(null);

    const result = await enrichProspect('missing-id');

    expect(result).toBeNull();
  });

  it('uses the Hunter result and never calls PeopleDataLabs when Hunter succeeds', async () => {
    findUniqueMock.mockResolvedValue(buildProspectRow());
    runHunterEnrichmentMock.mockResolvedValue({ ok: true, contact: hunterContact });

    const result = await enrichProspect('prospect-1');

    expect(result?.sources).toEqual([{ source: 'hunter', ran: true, used: true }]);
    expect(runPeopleDataLabsEnrichmentMock).not.toHaveBeenCalled();
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ contactEmail: 'jane@acme.com', emailConfidence: 95, emailVerified: true }),
      })
    );
  });

  it('falls back to PeopleDataLabs when Hunter reports itself unavailable (e.g. quota exhausted)', async () => {
    findUniqueMock.mockResolvedValue(buildProspectRow());
    runHunterEnrichmentMock.mockResolvedValue({
      ok: false,
      reason: 'source unavailable: Hunter.io free-tier quota (50/month) already used this month',
    });
    runPeopleDataLabsEnrichmentMock.mockResolvedValue({ ok: true, contact: pdlContact });

    const result = await enrichProspect('prospect-1');

    expect(result?.sources).toEqual([
      {
        source: 'hunter',
        ran: false,
        reason: 'source unavailable: Hunter.io free-tier quota (50/month) already used this month',
        used: false,
      },
      { source: 'people_data_labs', ran: true, used: true },
    ]);
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ contactEmail: 'jane.pdl@acme.com' }) })
    );
  });

  it('falls back to pattern-guess+MX when both Hunter and PeopleDataLabs are unavailable, and finds an MX record', async () => {
    findUniqueMock.mockResolvedValue(buildProspectRow({ contactName: 'Jane Doe' }));
    runHunterEnrichmentMock.mockResolvedValue({ ok: false, reason: 'source unavailable: HUNTER_API_KEY not configured' });
    runPeopleDataLabsEnrichmentMock.mockResolvedValue({
      ok: false,
      reason: 'source unavailable: PEOPLE_DATA_LABS_API_KEY not configured',
    });
    domainAcceptsEmailMock.mockResolvedValue(true);

    const result = await enrichProspect('prospect-1');

    expect(result?.sources.map((s) => s.source)).toEqual(['hunter', 'people_data_labs', 'pattern_guess_mx']);
    expect(result?.sources[2]).toEqual({ source: 'pattern_guess_mx', ran: true, used: true });
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ contactEmail: 'jane@acme.com', emailVerified: false }),
      })
    );
  });

  it('scores a pattern-guess+MX-only email at a much lower emailConfidence than Hunter or PeopleDataLabs results', async () => {
    findUniqueMock.mockResolvedValue(buildProspectRow({ contactName: 'Jane Doe' }));
    runHunterEnrichmentMock.mockResolvedValue({ ok: false, reason: 'unavailable' });
    runPeopleDataLabsEnrichmentMock.mockResolvedValue({ ok: false, reason: 'unavailable' });
    domainAcceptsEmailMock.mockResolvedValue(true);

    await enrichProspect('prospect-1');

    const patternGuessCall = updateMock.mock.calls[0][0] as { data: { emailConfidence: number } };
    expect(patternGuessCall.data.emailConfidence).toBe(15);
    expect(patternGuessCall.data.emailConfidence).toBeLessThan(hunterContact.emailConfidence);
    expect(patternGuessCall.data.emailConfidence).toBeLessThan(pdlContact.emailConfidence);
  });

  it('reports no usable contact and does not touch the DB update when every source is unavailable, including a domain with no MX record', async () => {
    findUniqueMock.mockResolvedValue(buildProspectRow({ contactName: 'Jane Doe' }));
    runHunterEnrichmentMock.mockResolvedValue({ ok: false, reason: 'source unavailable: HUNTER_API_KEY not configured' });
    runPeopleDataLabsEnrichmentMock.mockResolvedValue({
      ok: false,
      reason: 'source unavailable: PEOPLE_DATA_LABS_API_KEY not configured',
    });
    domainAcceptsEmailMock.mockResolvedValue(false);

    const result = await enrichProspect('prospect-1');

    expect(result?.sources.every((s) => !s.used)).toBe(true);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('reports every source as unavailable without calling any of them when the prospect has no domain', async () => {
    findUniqueMock.mockResolvedValue(buildProspectRow({ domain: null }));

    const result = await enrichProspect('prospect-1');

    expect(result?.sources).toEqual([
      { source: 'hunter', ran: false, reason: 'source unavailable: prospect has no domain to enrich against', used: false },
      {
        source: 'people_data_labs',
        ran: false,
        reason: 'source unavailable: prospect has no domain to enrich against',
        used: false,
      },
      {
        source: 'pattern_guess_mx',
        ran: false,
        reason: 'source unavailable: prospect has no domain to enrich against',
        used: false,
      },
    ]);
    expect(runHunterEnrichmentMock).not.toHaveBeenCalled();
    expect(runPeopleDataLabsEnrichmentMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('advances status from new to enriched on the persisted row after a successful enrichment', async () => {
    findUniqueMock.mockResolvedValue(buildProspectRow({ status: 'new' }));
    runHunterEnrichmentMock.mockResolvedValue({ ok: true, contact: hunterContact });

    await enrichProspect('prospect-1');

    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'enriched' }) })
    );
  });

  it('does not move a prospect backwards in status if it has already progressed past new (e.g. drafted)', async () => {
    findUniqueMock.mockResolvedValue(buildProspectRow({ status: 'drafted' }));
    runHunterEnrichmentMock.mockResolvedValue({ ok: true, contact: hunterContact });

    await enrichProspect('prospect-1');

    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'drafted' }) })
    );
  });

  it('keeps the existing higher-confidence contact and does not touch the DB when a re-enrichment attempt would downgrade it', async () => {
    findUniqueMock.mockResolvedValue(
      buildProspectRow({
        contactEmail: 'jane@acme.com',
        emailVerified: true,
        emailConfidence: 95,
        status: 'enriched',
      })
    );
    // Hunter's quota is exhausted this time, so the chain falls through to a
    // much lower-confidence pattern-guess.
    runHunterEnrichmentMock.mockResolvedValue({ ok: false, reason: 'source unavailable: quota exhausted' });
    runPeopleDataLabsEnrichmentMock.mockResolvedValue({ ok: false, reason: 'source unavailable: no key' });
    domainAcceptsEmailMock.mockResolvedValue(true);

    const result = await enrichProspect('prospect-1');

    expect(updateMock).not.toHaveBeenCalled();
    expect(result?.prospect.contactEmail).toBe('jane@acme.com');
    expect(result?.prospect.emailConfidence).toBe(95);
    expect(result?.downgradeSkipped).toEqual({
      reason: 'kept existing higher-confidence contact, new attempt was lower confidence',
      existingConfidence: 95,
      attemptedConfidence: 15,
    });
  });

  it('keeps the existing verified contact and does not touch the DB when a re-enrichment attempt has equal/higher confidence but is unverified', async () => {
    findUniqueMock.mockResolvedValue(
      buildProspectRow({
        contactEmail: 'jane@acme.com',
        emailVerified: true,
        emailConfidence: 80,
        status: 'enriched',
      })
    );
    // Same source chain, but this attempt's result is an unverified guess at
    // an equal-or-higher confidence score - the confidence-drop check alone
    // would miss this, since confidence didn't drop.
    runHunterEnrichmentMock.mockResolvedValue({
      ok: true,
      contact: { ...pdlContact, emailVerified: false, emailConfidence: 80 },
    });

    const result = await enrichProspect('prospect-1');

    expect(updateMock).not.toHaveBeenCalled();
    expect(result?.prospect.contactEmail).toBe('jane@acme.com');
    expect(result?.prospect.emailVerified).toBe(true);
    expect(result?.downgradeSkipped).toEqual({
      reason: 'kept existing higher-confidence contact, new attempt was lower confidence',
      existingConfidence: 80,
      attemptedConfidence: 80,
    });
  });

  it('still overwrites the existing contact when a re-enrichment result has equal or higher confidence', async () => {
    findUniqueMock.mockResolvedValue(
      buildProspectRow({
        contactEmail: 'old@acme.com',
        emailVerified: false,
        emailConfidence: 80,
        status: 'enriched',
      })
    );
    runHunterEnrichmentMock.mockResolvedValue({ ok: true, contact: hunterContact });

    const result = await enrichProspect('prospect-1');

    expect(result?.downgradeSkipped).toBeUndefined();
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ contactEmail: 'jane@acme.com', emailConfidence: 95 }),
      })
    );
  });

  it('appends a statusHistory entry only when the status actually advances', async () => {
    findUniqueMock.mockResolvedValue(buildProspectRow({ status: 'new', statusHistory: [] }));
    runHunterEnrichmentMock.mockResolvedValue({ ok: true, contact: hunterContact });

    await enrichProspect('prospect-1');

    const call = updateMock.mock.calls[0][0] as { data: { statusHistory: Array<{ status: string }> } };
    expect(call.data.statusHistory).toHaveLength(1);
    expect(call.data.statusHistory[0].status).toBe('enriched');
  });
});
