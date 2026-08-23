import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Prisma } from '@/lib/generated/prisma/client';

import { ACTIVE_FRAMEWORKS } from './prompt-templates';

// This is an orchestration test: gemini.client.ts/groq.client.ts and
// model-rotation.ts have their own dedicated suites, and claude-bridge.client.ts
// does too, so all three are mocked here - only drafting.service.ts's own
// signal-validation, variant/humanize orchestration, status-advancement, and
// batch-stopping logic is under test.
const {
  findUniqueMock,
  findManyProspectMock,
  updateProspectMock,
  createDraftMock,
  findManyDraftMock,
  updateDraftMock,
  transactionMock,
} = vi.hoisted(() => {
  const findUnique = vi.fn();
  const findManyProspect = vi.fn();
  const updateProspect = vi.fn();
  const createDraft = vi.fn();
  const findManyDraft = vi.fn();
  const updateDraft = vi.fn();
  const transaction = vi.fn();
  return {
    findUniqueMock: findUnique,
    findManyProspectMock: findManyProspect,
    updateProspectMock: updateProspect,
    createDraftMock: createDraft,
    findManyDraftMock: findManyDraft,
    updateDraftMock: updateDraft,
    transactionMock: transaction,
  };
});

vi.mock('@/common/db/client', () => ({
  prisma: {
    prospect: { findUnique: findUniqueMock, findMany: findManyProspectMock, update: updateProspectMock },
    draft: { create: createDraftMock, findMany: findManyDraftMock, update: updateDraftMock },
    $transaction: transactionMock,
  },
}));

const generateDraftWithFallbackMock = vi.fn();
vi.mock('@/features/drafting/model-rotation', () => ({
  generateDraftWithFallback: generateDraftWithFallbackMock,
}));

const humanizeMock = vi.fn();
vi.mock('@/features/drafting/claude-bridge.client', () => ({ humanize: humanizeMock }));

const { draftProspect, draftBatch, humanizeBatch, HIGH_PRIORITY_THRESHOLD } = await import('./drafting.service');

interface ProspectRowOverrides {
  id?: string;
  priorityScore?: number;
  status?: string;
  statusHistory?: unknown;
  signal?: unknown;
}

function buildValidSignal(): unknown {
  return {
    type: 'outdated_site',
    description: 'stale pricing page',
    evidence: 'archive.org snapshot',
    strength: 'strong',
  };
}

function buildProspectRow(overrides: ProspectRowOverrides = {}) {
  return {
    id: overrides.id ?? 'prospect-1',
    companyName: 'Acme Inc',
    contactName: 'Jane Doe',
    contactTitle: 'CEO',
    industry: 'saas',
    projectFit: 'full_stack_app',
    estimatedBudget: 'mid',
    signal: overrides.signal === undefined ? buildValidSignal() : overrides.signal,
    priorityScore: overrides.priorityScore ?? 1,
    status: overrides.status ?? 'enriched',
    statusHistory: overrides.statusHistory ?? [],
  };
}

// 60 filler words (comfortably inside the 50-125 MIN_WORDS/MAX_WORDS range)
// prefixed with a label so each variant's body is distinguishable, and
// containing none of BANNED_PHRASES - needed so these fixtures pass
// validate-draft-output.ts's post-generation validation, which
// drafting.service.ts now runs on every generation.
function validBody(label: string): string {
  return `Body ${label} ${Array(60).fill('filler').join(' ')}`;
}

function draftGeneration(label: string, modelUsed: 'gemini' | 'groq' | 'claude-bridge' = 'gemini') {
  return { ok: true as const, subject: `Subject ${label}`, body: validBody(label), modelUsed };
}

beforeEach(() => {
  vi.clearAllMocks();

  transactionMock.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      draft: { create: createDraftMock },
      prospect: { update: updateProspectMock },
    })
  );

  createDraftMock.mockImplementation(
    ({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({
        id: `draft-${data.variant as number}`,
        prospectId: data.prospectId,
        variant: data.variant,
        subject: data.subject,
        body: data.body,
        humanizedBody: data.humanizedBody ?? null,
        modelUsed: data.modelUsed,
        framework: data.framework ?? null,
        generatedAt: new Date('2026-01-01T00:00:00.000Z'),
        edited: false,
        approved: false,
      })
  );
});

describe('draftProspect', () => {
  it('returns null (mapped to a 404 by the route) when no prospect exists with the given id', async () => {
    findUniqueMock.mockResolvedValue(null);

    const result = await draftProspect('missing-id');

    expect(result).toBeNull();
  });

  it('flags missing_signal and never calls the LLM when the prospect has no valid signal on file', async () => {
    findUniqueMock.mockResolvedValue(buildProspectRow({ signal: null }));

    const result = await draftProspect('prospect-1');

    expect(result).toEqual({
      ok: false,
      flagged: 'missing_signal',
      message: expect.stringContaining('no valid signal'),
    });
    expect(generateDraftWithFallbackMock).not.toHaveBeenCalled();
    expect(createDraftMock).not.toHaveBeenCalled();
  });

  it('persists the missing_signal failure to Prospect.lastDraftFailure', async () => {
    findUniqueMock.mockResolvedValue(buildProspectRow({ signal: null }));

    await draftProspect('prospect-1');

    expect(updateProspectMock).toHaveBeenCalledWith({
      where: { id: 'prospect-1' },
      data: {
        lastDraftFailure: {
          flagged: 'missing_signal',
          message: expect.stringContaining('no valid signal'),
          occurredAt: expect.any(String),
        },
      },
    });
  });

  it('flags missing_signal for a signal object that fails schema validation (e.g. wrong shape)', async () => {
    findUniqueMock.mockResolvedValue(buildProspectRow({ signal: { type: 'not-a-real-type' } }));

    const result = await draftProspect('prospect-1');

    expect(result).toEqual({
      ok: false,
      flagged: 'missing_signal',
      message: expect.any(String),
    });
    expect(createDraftMock).not.toHaveBeenCalled();
  });

  it('persists exactly 3 Draft rows with variants 1/2/3 and the modelUsed the rotation reported, on a successful generation', async () => {
    findUniqueMock.mockResolvedValue(buildProspectRow({ priorityScore: 1 }));
    generateDraftWithFallbackMock
      .mockResolvedValueOnce(draftGeneration('one'))
      .mockResolvedValueOnce(draftGeneration('two'))
      .mockResolvedValueOnce(draftGeneration('three'));

    const result = await draftProspect('prospect-1');
    if (!result) throw new Error('expected a non-null result');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected a drafted result');
    expect(result.drafts).toHaveLength(3);
    expect(result.drafts.map((d) => d.variant)).toEqual([1, 2, 3]);
    expect(result.drafts.every((d) => d.modelUsed === 'gemini')).toBe(true);
    expect(createDraftMock).toHaveBeenCalledTimes(3);
  });

  it('samples a distinct framework per variant, builds a distinct prompt per variant, and persists each framework on its Draft row', async () => {
    findUniqueMock.mockResolvedValue(buildProspectRow({ priorityScore: 1 }));
    generateDraftWithFallbackMock
      .mockResolvedValueOnce(draftGeneration('one'))
      .mockResolvedValueOnce(draftGeneration('two'))
      .mockResolvedValueOnce(draftGeneration('three'));

    const result = await draftProspect('prospect-1');
    if (!result) throw new Error('expected a non-null result');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected a drafted result');

    // ACTIVE_FRAMEWORKS currently has exactly 3 entries and VARIANT_COUNT is
    // 3, so every active framework is used exactly once, in some order -
    // never the same framework twice, never a shared prompt across variants.
    const promptsUsed = generateDraftWithFallbackMock.mock.calls.map(([prompt]) => prompt as string);
    expect(new Set(promptsUsed).size).toBe(promptsUsed.length);

    const persistedFrameworks = createDraftMock.mock.calls.map(
      ([{ data }]) => data.framework as string
    );
    expect(new Set(persistedFrameworks)).toEqual(new Set(ACTIVE_FRAMEWORKS));
    expect(result.drafts.map((d) => d.framework).sort()).toEqual([...ACTIVE_FRAMEWORKS].sort());
  });

  it('threads isHighPriority through to generateDraftWithFallback for every variant', async () => {
    findUniqueMock.mockResolvedValue(buildProspectRow({ priorityScore: HIGH_PRIORITY_THRESHOLD }));
    generateDraftWithFallbackMock
      .mockResolvedValueOnce(draftGeneration('one'))
      .mockResolvedValueOnce(draftGeneration('two'))
      .mockResolvedValueOnce(draftGeneration('three'));
    humanizeMock.mockResolvedValue({ ok: true, text: 'Humanized body one.' });

    await draftProspect('prospect-1');

    expect(generateDraftWithFallbackMock).toHaveBeenCalledTimes(3);
    for (const [, options] of generateDraftWithFallbackMock.mock.calls) {
      expect(options).toEqual({ isHighPriority: true });
    }
  });

  it('flags no_llm_available and creates no Draft rows when the rotation reports no provider is available', async () => {
    findUniqueMock.mockResolvedValue(buildProspectRow());
    generateDraftWithFallbackMock.mockResolvedValue({ ok: false, reason: 'no LLM available: gemini/groq unconfigured' });

    const result = await draftProspect('prospect-1');

    expect(result).toEqual({
      ok: false,
      flagged: 'no_llm_available',
      message: 'no LLM available: gemini/groq unconfigured',
    });
    expect(createDraftMock).not.toHaveBeenCalled();
    expect(transactionMock).not.toHaveBeenCalled();
    expect(updateProspectMock).toHaveBeenCalledWith({
      where: { id: 'prospect-1' },
      data: {
        lastDraftFailure: {
          flagged: 'no_llm_available',
          message: 'no LLM available: gemini/groq unconfigured',
          occurredAt: expect.any(String),
        },
      },
    });
  });

  it('retries a variant once through the rotation when the first generation fails post-generation validation, and persists the compliant retry', async () => {
    findUniqueMock.mockResolvedValue(buildProspectRow());
    generateDraftWithFallbackMock
      .mockResolvedValueOnce({ ok: true, subject: 'Subject', body: 'circle back soon', modelUsed: 'gemini' }) // fails: too short + banned phrase
      .mockResolvedValueOnce(draftGeneration('retry', 'groq')) // compliant retry
      .mockResolvedValueOnce(draftGeneration('two'))
      .mockResolvedValueOnce(draftGeneration('three'));

    const result = await draftProspect('prospect-1');
    if (!result) throw new Error('expected a non-null result');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected a drafted result');
    expect(generateDraftWithFallbackMock).toHaveBeenCalledTimes(4);
    expect(result.drafts[0].modelUsed).toBe('groq');
    expect(result.drafts[0].body).toBe(validBody('retry'));
  });

  it('flags invalid_draft_output and creates no Draft rows when a variant fails post-generation validation twice in a row', async () => {
    findUniqueMock.mockResolvedValue(buildProspectRow());
    generateDraftWithFallbackMock.mockResolvedValue({ ok: true, subject: 'Subject', body: 'circle back soon', modelUsed: 'gemini' });

    const result = await draftProspect('prospect-1');

    expect(result).toEqual({
      ok: false,
      flagged: 'invalid_draft_output',
      message: expect.stringContaining('failed post-generation validation twice'),
    });
    expect(generateDraftWithFallbackMock).toHaveBeenCalledTimes(2);
    expect(createDraftMock).not.toHaveBeenCalled();
    expect(transactionMock).not.toHaveBeenCalled();
    expect(updateProspectMock).toHaveBeenCalledWith({
      where: { id: 'prospect-1' },
      data: {
        lastDraftFailure: {
          flagged: 'invalid_draft_output',
          message: expect.stringContaining('failed post-generation validation twice'),
          occurredAt: expect.any(String),
        },
      },
    });
  });

  it('never calls humanize for variants 2 and 3, only ever variant 1', async () => {
    findUniqueMock.mockResolvedValue(buildProspectRow({ priorityScore: HIGH_PRIORITY_THRESHOLD }));
    generateDraftWithFallbackMock
      .mockResolvedValueOnce(draftGeneration('one'))
      .mockResolvedValueOnce(draftGeneration('two'))
      .mockResolvedValueOnce(draftGeneration('three'));
    humanizeMock.mockResolvedValue({ ok: true, text: 'Humanized body one.' });

    await draftProspect('prospect-1');

    expect(humanizeMock).toHaveBeenCalledTimes(1);
    expect(humanizeMock).toHaveBeenCalledWith(validBody('one'));
  });

  it('runs an inline humanize pass and stores humanizedBody on variant 1 only for a high-priority prospect', async () => {
    findUniqueMock.mockResolvedValue(buildProspectRow({ priorityScore: HIGH_PRIORITY_THRESHOLD }));
    generateDraftWithFallbackMock
      .mockResolvedValueOnce(draftGeneration('one'))
      .mockResolvedValueOnce(draftGeneration('two'))
      .mockResolvedValueOnce(draftGeneration('three'));
    humanizeMock.mockResolvedValue({ ok: true, text: 'Humanized body one.' });

    const result = await draftProspect('prospect-1');
    if (!result) throw new Error('expected a non-null result');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected a drafted result');
    expect(result.drafts[0].humanizedBody).toBe('Humanized body one.');
    expect(result.drafts[1].humanizedBody).toBeNull();
    expect(result.drafts[2].humanizedBody).toBeNull();
    expect(result.humanize).toEqual({ attempted: true, outcome: 'humanized' });
  });

  it('never attempts humanize for a below-threshold priority prospect', async () => {
    findUniqueMock.mockResolvedValue(buildProspectRow({ priorityScore: HIGH_PRIORITY_THRESHOLD - 1 }));
    generateDraftWithFallbackMock
      .mockResolvedValueOnce(draftGeneration('one'))
      .mockResolvedValueOnce(draftGeneration('two'))
      .mockResolvedValueOnce(draftGeneration('three'));

    const result = await draftProspect('prospect-1');
    if (!result) throw new Error('expected a non-null result');

    expect(humanizeMock).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected a drafted result');
    expect(result.humanize).toEqual({ attempted: false });
  });

  it('still creates all 3 drafts and advances status to drafted even when the inline humanize call fails', async () => {
    findUniqueMock.mockResolvedValue(buildProspectRow({ priorityScore: HIGH_PRIORITY_THRESHOLD, status: 'enriched' }));
    generateDraftWithFallbackMock
      .mockResolvedValueOnce(draftGeneration('one'))
      .mockResolvedValueOnce(draftGeneration('two'))
      .mockResolvedValueOnce(draftGeneration('three'));
    humanizeMock.mockResolvedValue({ ok: false, kind: 'failure', reason: 'claude-bridge internal error' });

    const result = await draftProspect('prospect-1');
    if (!result) throw new Error('expected a non-null result');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected a drafted result');
    expect(result.drafts).toHaveLength(3);
    expect(result.drafts[0].humanizedBody).toBeNull();
    expect(result.humanize).toEqual({ attempted: true, outcome: 'failed', reason: 'claude-bridge internal error' });
    expect(updateProspectMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'drafted' }) })
    );
  });

  it('reports a rate-limited inline humanize attempt as deferred rather than failed, without blocking drafting', async () => {
    findUniqueMock.mockResolvedValue(buildProspectRow({ priorityScore: HIGH_PRIORITY_THRESHOLD }));
    generateDraftWithFallbackMock
      .mockResolvedValueOnce(draftGeneration('one'))
      .mockResolvedValueOnce(draftGeneration('two'))
      .mockResolvedValueOnce(draftGeneration('three'));
    humanizeMock.mockResolvedValue({ ok: false, kind: 'rate_limited', reason: 'shared quota exhausted', retryAfterSeconds: 120 });

    const result = await draftProspect('prospect-1');
    if (!result) throw new Error('expected a non-null result');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected a drafted result');
    expect(result.drafts).toHaveLength(3);
    expect(result.humanize).toEqual({ attempted: true, outcome: 'deferred', reason: 'shared quota exhausted' });
  });

  it('advances status from enriched to drafted and appends a statusHistory entry', async () => {
    findUniqueMock.mockResolvedValue(buildProspectRow({ status: 'enriched', statusHistory: [] }));
    generateDraftWithFallbackMock.mockResolvedValue(draftGeneration('one'));

    await draftProspect('prospect-1');

    const call = updateProspectMock.mock.calls[0][0] as {
      data: { status: string; statusHistory: Array<{ status: string }>; lastDraftFailure: unknown };
    };
    expect(call.data.status).toBe('drafted');
    expect(call.data.statusHistory).toHaveLength(1);
    expect(call.data.statusHistory[0].status).toBe('drafted');
    expect(call.data.lastDraftFailure).toBe(Prisma.DbNull);
  });

  it('clears a previously recorded lastDraftFailure once a later draft attempt for the same prospect succeeds', async () => {
    findUniqueMock.mockResolvedValue(buildProspectRow());
    generateDraftWithFallbackMock
      .mockResolvedValueOnce(draftGeneration('one'))
      .mockResolvedValueOnce(draftGeneration('two'))
      .mockResolvedValueOnce(draftGeneration('three'));

    await draftProspect('prospect-1');

    expect(updateProspectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'prospect-1' },
        data: expect.objectContaining({ lastDraftFailure: Prisma.DbNull }),
      })
    );
  });
});

describe('draftBatch', () => {
  it('runs draftProspect for every candidate returned by the enriched-status query and reports each outcome by prospectId', async () => {
    findManyProspectMock.mockResolvedValue([{ id: 'prospect-a' }, { id: 'prospect-b' }]);
    findUniqueMock.mockImplementation(({ where }: { where: { id: string } }) =>
      Promise.resolve(buildProspectRow({ id: where.id }))
    );
    generateDraftWithFallbackMock.mockResolvedValue(draftGeneration('one'));

    const results = await draftBatch(2);

    expect(results.map((r) => r.prospectId)).toEqual(['prospect-a', 'prospect-b']);
    expect(results.every((r) => r.outcome.ok === true)).toBe(true);
    expect(findManyProspectMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: 'enriched' }, take: 2 })
    );
  });

  it('omits a candidate from the results entirely if the prospect no longer exists by the time it is drafted', async () => {
    findManyProspectMock.mockResolvedValue([{ id: 'prospect-a' }]);
    findUniqueMock.mockResolvedValue(null);

    const results = await draftBatch(2);

    expect(results).toEqual([]);
  });

  it('restricts candidates to the given signal strength when options.signalStrength is set', async () => {
    findManyProspectMock.mockResolvedValue([]);

    await draftBatch(5, { signalStrength: 'strong' });

    expect(findManyProspectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: 'enriched', signal: { path: ['strength'], equals: 'strong' } },
      })
    );
  });
});

describe('humanizeBatch', () => {
  function buildCandidateDraft(id: string) {
    return {
      id,
      prospectId: 'prospect-1',
      variant: 1,
      subject: 'Subject',
      body: `Body for ${id}`,
      humanizedBody: null,
      modelUsed: 'gemini',
      generatedAt: new Date('2026-01-01T00:00:00.000Z'),
      edited: false,
      approved: false,
    };
  }

  it('humanizes every eligible draft when every call succeeds', async () => {
    findManyDraftMock.mockResolvedValue([buildCandidateDraft('draft-a'), buildCandidateDraft('draft-b')]);
    humanizeMock.mockResolvedValue({ ok: true, text: 'humanized text' });

    const summary = await humanizeBatch();

    expect(summary.attempted).toBe(2);
    expect(summary.results.every((r) => r.outcome === 'humanized')).toBe(true);
    expect(updateDraftMock).toHaveBeenCalledTimes(2);
  });

  it('stops humanizing further drafts once a bridge call comes back non-success, rather than skipping and continuing', async () => {
    findManyDraftMock.mockResolvedValue([buildCandidateDraft('draft-a'), buildCandidateDraft('draft-b')]);
    humanizeMock.mockResolvedValueOnce({ ok: false, kind: 'rate_limited', reason: 'shared quota exhausted' });

    const summary = await humanizeBatch();

    expect(humanizeMock).toHaveBeenCalledTimes(1);
    expect(summary.results).toEqual([{ draftId: 'draft-a', outcome: 'stopped', reason: 'shared quota exhausted' }]);
    expect(updateDraftMock).not.toHaveBeenCalled();
  });

  it('picks up a stranded high-priority prospect\'s null-humanizedBody draft rather than excluding it by priorityScore', async () => {
    // Regression coverage for the bug where a high-priority prospect's inline
    // humanize attempt (in draftProspect) could come back deferred/failed,
    // leaving humanizedBody null forever because this query used to exclude
    // any prospect at/above HIGH_PRIORITY_THRESHOLD.
    findManyDraftMock.mockResolvedValue([buildCandidateDraft('draft-high-priority')]);
    humanizeMock.mockResolvedValue({ ok: true, text: 'humanized text' });

    const summary = await humanizeBatch();

    expect(summary.results).toEqual([{ draftId: 'draft-high-priority', outcome: 'humanized' }]);
    const query = findManyDraftMock.mock.calls[0][0] as { where: { prospect: Record<string, unknown> } };
    expect(query.where.prospect).not.toHaveProperty('priorityScore');
  });

  it('does not call humanize a second time even though a second eligible draft was fetched', async () => {
    findManyDraftMock.mockResolvedValue([
      buildCandidateDraft('draft-a'),
      buildCandidateDraft('draft-b'),
      buildCandidateDraft('draft-c'),
    ]);
    humanizeMock
      .mockResolvedValueOnce({ ok: true, text: 'humanized a' })
      .mockResolvedValueOnce({ ok: false, kind: 'logged_out', reason: 'bridge session logged out' });

    const summary = await humanizeBatch();

    expect(humanizeMock).toHaveBeenCalledTimes(2);
    expect(summary.results.map((r) => r.outcome)).toEqual(['humanized', 'stopped']);
  });

  it('restricts candidates to the given signal strength when options.signalStrength is set', async () => {
    findManyDraftMock.mockResolvedValue([]);

    await humanizeBatch(5, { signalStrength: 'strong' });

    const query = findManyDraftMock.mock.calls[0][0] as { where: { prospect: Record<string, unknown> } };
    expect(query.where.prospect).toEqual({ status: 'drafted', signal: { path: ['strength'], equals: 'strong' } });
  });
});
