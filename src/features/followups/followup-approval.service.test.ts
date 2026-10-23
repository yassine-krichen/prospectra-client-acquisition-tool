import { beforeEach, describe, expect, it, vi } from 'vitest';

// Orchestration test for the human-approved follow-up send path. Prisma, the
// cap counter and sendEmail are mocked (same style as
// followup-scheduler.test.ts); the real followup-scheduler.ts is used so the
// shared `attemptFollowupSend` (atomic claim, rollback, tagging) is exercised
// exactly as the approval route reaches it.
const { findManyProspectMock, findUniqueProspectMock, updateManyMock, findManyDraftMock } = vi.hoisted(() => ({
  findManyProspectMock: vi.fn(),
  findUniqueProspectMock: vi.fn(),
  updateManyMock: vi.fn(),
  findManyDraftMock: vi.fn(),
}));

vi.mock('@/common/db/client', () => ({
  prisma: {
    prospect: { findMany: findManyProspectMock, findUnique: findUniqueProspectMock, updateMany: updateManyMock },
    draft: { findMany: findManyDraftMock, findUnique: vi.fn().mockResolvedValue(null) },
  },
}));

const getEffectiveDailyCapMock = vi.fn();
vi.mock('@/features/sending/domain-verification-gate', () => ({
  getEffectiveDailyCap: getEffectiveDailyCapMock,
}));

const { dailySendState, reserveDailySendSlotMock, rollBackDailySendSlotMock } = vi.hoisted(() => {
  const state = { reservedCount: 0 };
  return {
    dailySendState: state,
    reserveDailySendSlotMock: vi.fn(async (cap: number) => {
      if (state.reservedCount < cap) {
        state.reservedCount += 1;
        return true;
      }
      return false;
    }),
    rollBackDailySendSlotMock: vi.fn(async () => {
      state.reservedCount = Math.max(0, state.reservedCount - 1);
    }),
  };
});
vi.mock('@/features/sending/daily-send-counter', () => ({
  reserveDailySendSlot: reserveDailySendSlotMock,
  rollBackDailySendSlot: rollBackDailySendSlotMock,
}));

const sendEmailMock = vi.fn();
vi.mock('@/features/sending/resend.client', () => ({ sendEmail: sendEmailMock }));

const isFollowupApprovalRequiredMock = vi.fn();
vi.mock('@/features/followups/followup-approval-setting', () => ({
  isFollowupApprovalRequired: isFollowupApprovalRequiredMock,
}));

const { approveFollowups, listFollowupQueue } = await import('./followup-approval.service');
const { FOLLOWUP_INTERVAL_DAYS } = await import('./followup-scheduler');
const { renderFollowupTemplate } = await import('./followup-templates');

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * MS_PER_DAY);
}

const SIGNAL = {
  type: 'no_https' as const,
  description: 'checkout page is served over plain HTTP',
  evidence: null,
  strength: 'medium' as const,
};

interface CandidateOverrides {
  id?: string;
  status?: string;
  doNotContact?: boolean;
  sentAt?: Date | null;
  priorityScore?: number;
  tags?: string[];
  activeDraftId?: string | null;
  lastFollowupAt?: Date | null;
  companyName?: string;
}

function buildCandidate(overrides: CandidateOverrides = {}) {
  return {
    id: overrides.id ?? 'prospect-1',
    companyName: overrides.companyName ?? 'Acme Co',
    contactEmail: 'contact@example.com',
    doNotContact: overrides.doNotContact ?? false,
    status: overrides.status ?? 'sent',
    followupCount: 0,
    lastFollowupAt: overrides.lastFollowupAt ?? null,
    sentAt: overrides.sentAt === undefined ? daysAgo(FOLLOWUP_INTERVAL_DAYS + 1) : overrides.sentAt,
    signal: SIGNAL,
    statusHistory: [{ status: 'sent', timestamp: '2026-01-01T00:00:00.000Z' }],
    activeDraftId: overrides.activeDraftId ?? null,
    priorityScore: overrides.priorityScore ?? 1,
    tags: overrides.tags ?? [],
  };
}

// Serves `candidates` as both the ranking read and the per-id fresh read.
function seedCandidates(...candidates: ReturnType<typeof buildCandidate>[]): void {
  findManyProspectMock.mockImplementation(async (args: { where?: { id?: unknown; tags?: unknown } }) => {
    if (args.where?.tags) return [];
    return candidates.map((c) => ({ id: c.id, priorityScore: c.priorityScore }));
  });
  findUniqueProspectMock.mockImplementation(
    async (args: { where: { id: string } }) => candidates.find((c) => c.id === args.where.id) ?? null
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  findManyProspectMock.mockResolvedValue([]);
  findUniqueProspectMock.mockResolvedValue(null);
  updateManyMock.mockResolvedValue({ count: 1 });
  findManyDraftMock.mockResolvedValue([]);
  getEffectiveDailyCapMock.mockReturnValue(10);
  dailySendState.reservedCount = 0;
  sendEmailMock.mockResolvedValue({ ok: true, id: 'resend-message-id' });
  isFollowupApprovalRequiredMock.mockReturnValue(true);
});

describe('approveFollowups', () => {
  it('sends a due prospect and moves it to followup_1', async () => {
    seedCandidates(buildCandidate({ id: 'p1' }));

    const results = await approveFollowups(['p1']);

    expect(results).toEqual([{ prospectId: 'p1', outcome: 'sent', touch: 2 }]);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: 'p1', status: 'sent', doNotContact: false },
      data: expect.objectContaining({ status: 'followup_1', followupCount: 1 }),
    });
  });

  it('skips a prospect that is not stale yet, without reserving a cap slot or sending', async () => {
    seedCandidates(buildCandidate({ id: 'p1', sentAt: daysAgo(FOLLOWUP_INTERVAL_DAYS - 1) }));

    const results = await approveFollowups(['p1']);

    expect(results).toEqual([{ prospectId: 'p1', outcome: 'skipped_not_eligible' }]);
    expect(reserveDailySendSlotMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('skips a prospect that replied between listing and approval and never calls sendEmail', async () => {
    seedCandidates(buildCandidate({ id: 'p1', status: 'replied' }));

    const results = await approveFollowups(['p1']);

    expect(results).toEqual([{ prospectId: 'p1', outcome: 'skipped_not_eligible' }]);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it('skips a doNotContact prospect and never calls sendEmail', async () => {
    seedCandidates(buildCandidate({ id: 'p1', doNotContact: true }));

    const results = await approveFollowups(['p1']);

    expect(results).toEqual([{ prospectId: 'p1', outcome: 'skipped_not_eligible' }]);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('reports an unknown id as skipped_not_eligible', async () => {
    seedCandidates();

    const results = await approveFollowups(['missing']);

    expect(results).toEqual([{ prospectId: 'missing', outcome: 'skipped_not_eligible' }]);
  });

  it('refuses a prospect carrying an unconfirmed-send tag', async () => {
    seedCandidates(buildCandidate({ id: 'p1', tags: ['send-unconfirmed'] }));

    const results = await approveFollowups(['p1']);

    expect(results).toEqual([{ prospectId: 'p1', outcome: 'skipped_not_eligible' }]);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('lets only the call whose mocked claim matches a row send, reporting skipped_not_eligible for the other overlapping call', async () => {
    seedCandidates(buildCandidate({ id: 'p1' }));
    // The first claim wins, the second matches zero rows.
    updateManyMock.mockResolvedValueOnce({ count: 1 }).mockResolvedValue({ count: 0 });

    const [first, second] = await Promise.all([approveFollowups(['p1']), approveFollowups(['p1'])]);

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const outcomes = [first[0]?.outcome, second[0]?.outcome].sort();
    expect(outcomes).toEqual(['sent', 'skipped_not_eligible']);
  });

  it('returns skipped_cap for the id that hits the cap and for every remaining id, without claiming them', async () => {
    getEffectiveDailyCapMock.mockReturnValue(1);
    seedCandidates(
      buildCandidate({ id: 'high', priorityScore: 9 }),
      buildCandidate({ id: 'mid', priorityScore: 5 }),
      buildCandidate({ id: 'low', priorityScore: 1 })
    );

    const results = await approveFollowups(['low', 'mid', 'high']);

    expect(results).toEqual([
      { prospectId: 'low', outcome: 'skipped_cap' },
      { prospectId: 'mid', outcome: 'skipped_cap' },
      { prospectId: 'high', outcome: 'sent', touch: 2 },
    ]);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    // One claim for the send; the capped ids were never claimed.
    expect(updateManyMock).toHaveBeenCalledTimes(1);
    // `low` was never even re-read once the cap was reached at `mid`.
    expect(findUniqueProspectMock).toHaveBeenCalledTimes(2);
  });

  it('rolls back the claim and the cap slot after a definite send failure', async () => {
    seedCandidates(buildCandidate({ id: 'p1' }));
    sendEmailMock.mockResolvedValue({ ok: false, reason: 'resend responded with 422', definitelyNotSent: true });

    const results = await approveFollowups(['p1']);

    expect(results).toEqual([{ prospectId: 'p1', outcome: 'failed', reason: 'resend responded with 422' }]);
    expect(rollBackDailySendSlotMock).toHaveBeenCalledTimes(1);
    expect(updateManyMock).toHaveBeenLastCalledWith({
      where: { id: 'p1', status: 'followup_1' },
      data: expect.objectContaining({ status: 'sent', lastFollowupAt: null, followupCount: 0 }),
    });
  });

  it('keeps the claim and the cap slot and tags the prospect after an ambiguous send failure', async () => {
    seedCandidates(buildCandidate({ id: 'p1' }));
    sendEmailMock.mockResolvedValue({ ok: false, reason: 'timeout' });

    const results = await approveFollowups(['p1']);

    expect(results[0]).toMatchObject({ prospectId: 'p1', outcome: 'failed' });
    expect(rollBackDailySendSlotMock).not.toHaveBeenCalled();
    expect(updateManyMock).toHaveBeenLastCalledWith({
      where: { id: 'p1', status: 'followup_1' },
      data: { tags: { push: 'followup-send-unconfirmed' } },
    });
  });
});

describe('listFollowupQueue', () => {
  it('shows the exact rendered subject and body the send would use', async () => {
    const candidate = buildCandidate({ id: 'p1', activeDraftId: 'draft-1', companyName: 'Acme Co' });
    findManyProspectMock.mockImplementation(async (args: { where?: { tags?: unknown } }) =>
      args.where?.tags ? [] : [candidate]
    );
    findManyDraftMock.mockResolvedValue([{ id: 'draft-1', subject: 'Original subject' }]);

    const queue = await listFollowupQueue();

    const rendered = renderFollowupTemplate(2, {
      companyName: 'Acme Co',
      originalSubject: 'Original subject',
      signal: SIGNAL,
    });
    if (!rendered.ok) throw new Error('fixture should render');
    expect(queue.approvalRequired).toBe(true);
    expect(queue.due).toHaveLength(1);
    expect(queue.due[0]).toMatchObject({
      prospectId: 'p1',
      subject: rendered.template.subject,
      body: rendered.template.body,
      daysSinceLastTouch: FOLLOWUP_INTERVAL_DAYS + 1,
    });
    expect(rendered.template.subject).toBe('Re: Original subject');
  });

  it('excludes prospects carrying an unconfirmed-send tag from the due list', async () => {
    const tagged = buildCandidate({ id: 'tagged', tags: ['send-unconfirmed'] });
    const followupTagged = buildCandidate({ id: 'followup-tagged', tags: ['followup-send-unconfirmed'] });
    const clean = buildCandidate({ id: 'clean' });
    findManyProspectMock.mockImplementation(async (args: { where?: { tags?: unknown } }) =>
      args.where?.tags ? [] : [tagged, followupTagged, clean]
    );

    const queue = await listFollowupQueue();

    expect(queue.due.map((item) => item.prospectId)).toEqual(['clean']);
  });

  it('lists prospects whose follow-up send is unconfirmed', async () => {
    findManyProspectMock.mockImplementation(async (args: { where?: { tags?: unknown } }) =>
      args.where?.tags
        ? [{ id: 'u1', companyName: 'Unsure Co', contactEmail: 'u@example.com', lastFollowupAt: new Date('2026-02-01T00:00:00.000Z') }]
        : []
    );

    const queue = await listFollowupQueue();

    expect(queue.unconfirmed).toEqual([
      { prospectId: 'u1', companyName: 'Unsure Co', contactEmail: 'u@example.com', lastFollowupAt: '2026-02-01T00:00:00.000Z' },
    ]);
  });

  it('leaves out a due prospect that has no contact email, since approving it could only fail', async () => {
    const candidate = { ...buildCandidate({ id: 'p1' }), contactEmail: null };
    findManyProspectMock.mockImplementation(async (args: { where?: { tags?: unknown } }) =>
      args.where?.tags ? [] : [candidate]
    );

    const queue = await listFollowupQueue();

    expect(queue.due).toEqual([]);
  });
});
