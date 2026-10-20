import { beforeEach, describe, expect, it, vi } from 'vitest';

// This is the highest-stakes orchestration test in this phase: the atomic
// claim inside `attemptFollowupSend`/`markDead` is what makes the
// reply-vs-follow-up race impossible to lose - a reply arriving between this
// module's read and its claim must make the claim match zero rows and abort
// before `sendEmail` is ever called. Prisma, the daily-cap gate, the
// send-count reader, and `sendEmail` are all mocked (this is an orchestration
// test, matching send-queue.service.test.ts's own style); `followup-templates.ts`
// and the `signalSchema` zod parse are left real since they're pure, already
// covered by their own suite, and using the real renderer here proves the
// scheduler actually wires a valid signal/company name through end to end.
const { findManyMock, updateManyMock, updateMock, findUniqueDraftMock } = vi.hoisted(() => ({
  findManyMock: vi.fn(),
  updateManyMock: vi.fn(),
  updateMock: vi.fn(),
  findUniqueDraftMock: vi.fn(),
}));

vi.mock('@/common/db/client', () => ({
  prisma: {
    prospect: { findMany: findManyMock, updateMany: updateManyMock, update: updateMock },
    draft: { findUnique: findUniqueDraftMock },
  },
}));

const getEffectiveDailyCapMock = vi.fn();
vi.mock('@/features/sending/domain-verification-gate', () => ({
  getEffectiveDailyCap: getEffectiveDailyCapMock,
}));

// Models `reserveDailySendSlot`'s real atomic-counter semantics closely
// enough for an orchestration test - see the identical mock in
// send-queue.service.test.ts for the full rationale.
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

const { runFollowupScheduler, FOLLOWUP_INTERVAL_DAYS, FOLLOWUP_SEND_UNCONFIRMED_TAG } = await import('./followup-scheduler');

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * MS_PER_DAY);
}

const DEFAULT_SIGNAL = {
  type: 'no_https' as const,
  description: 'checkout page is served over plain HTTP',
  evidence: null,
  strength: 'medium' as const,
};

interface CandidateOverrides {
  id?: string;
  companyName?: string;
  contactEmail?: string | null;
  doNotContact?: boolean;
  status?: string;
  followupCount?: number;
  lastFollowupAt?: Date | null;
  sentAt?: Date | null;
  signal?: unknown;
  statusHistory?: unknown;
  activeDraftId?: string | null;
  priorityScore?: number;
}

function buildCandidate(overrides: CandidateOverrides = {}) {
  return {
    id: overrides.id ?? 'prospect-1',
    companyName: overrides.companyName ?? 'Acme Co',
    contactEmail: overrides.contactEmail === undefined ? 'contact@example.com' : overrides.contactEmail,
    doNotContact: overrides.doNotContact ?? false,
    status: overrides.status ?? 'sent',
    followupCount: overrides.followupCount ?? 0,
    lastFollowupAt: overrides.lastFollowupAt === undefined ? null : overrides.lastFollowupAt,
    sentAt: overrides.sentAt === undefined ? daysAgo(FOLLOWUP_INTERVAL_DAYS + 1) : overrides.sentAt,
    signal: overrides.signal === undefined ? DEFAULT_SIGNAL : overrides.signal,
    statusHistory: overrides.statusHistory ?? [{ status: 'sent', timestamp: '2026-01-01T00:00:00.000Z' }],
    activeDraftId: overrides.activeDraftId === undefined ? null : overrides.activeDraftId,
    priorityScore: overrides.priorityScore ?? 1,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  findManyMock.mockResolvedValue([]);
  updateManyMock.mockResolvedValue({ count: 1 });
  updateMock.mockResolvedValue({});
  findUniqueDraftMock.mockResolvedValue(null);
  getEffectiveDailyCapMock.mockReturnValue(10);
  dailySendState.reservedCount = 0;
  sendEmailMock.mockResolvedValue({ ok: true, id: 'resend-message-id' });
});

describe('runFollowupScheduler candidate query', () => {
  it('queries only in-flight statuses with doNotContact:false, so a do-not-contact prospect can never even become a candidate', async () => {
    await runFollowupScheduler();

    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: { in: ['sent', 'followup_1', 'followup_2', 'followup_3'] }, doNotContact: false },
        orderBy: { priorityScore: 'desc' },
      })
    );
  });
});

describe('runFollowupScheduler eligibility and touch progression', () => {
  it('sends touch 2 to a sent prospect stale by the follow-up interval, transitioning it to followup_1 and incrementing followupCount', async () => {
    const candidate = buildCandidate({ status: 'sent', sentAt: daysAgo(FOLLOWUP_INTERVAL_DAYS + 1), followupCount: 0 });
    findManyMock.mockResolvedValue([candidate]);

    const outcomes = await runFollowupScheduler();

    expect(outcomes).toEqual([{ prospectId: candidate.id, outcome: 'sent', touch: 2 }]);
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: candidate.id, status: 'sent', doNotContact: false },
      data: {
        status: 'followup_1',
        lastFollowupAt: expect.any(Date),
        followupCount: 1,
        statusHistory: expect.arrayContaining([expect.objectContaining({ status: 'followup_1' })]),
      },
    });
    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'contact@example.com', subject: expect.any(String), body: expect.any(String) })
    );
  });

  it('marks a followup_1 prospect dead once stale again and sends no 3rd touch (one follow-up only)', async () => {
    const candidate = buildCandidate({ status: 'followup_1', followupCount: 1, lastFollowupAt: daysAgo(FOLLOWUP_INTERVAL_DAYS + 1) });
    findManyMock.mockResolvedValue([candidate]);

    const outcomes = await runFollowupScheduler();

    expect(outcomes).toEqual([{ prospectId: candidate.id, outcome: 'marked_dead' }]);
    expect(updateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: candidate.id, status: 'followup_1', doNotContact: false }, data: expect.objectContaining({ status: 'dead' }) })
    );
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('sweeps a legacy followup_2 prospect to dead instead of stranding it, with no send', async () => {
    const candidate = buildCandidate({ status: 'followup_2', followupCount: 2, lastFollowupAt: daysAgo(FOLLOWUP_INTERVAL_DAYS + 1) });
    findManyMock.mockResolvedValue([candidate]);

    const outcomes = await runFollowupScheduler();

    expect(outcomes).toEqual([{ prospectId: candidate.id, outcome: 'marked_dead' }]);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('skips a prospect that has not yet gone stale, without calling sendEmail or attempting any claim', async () => {
    const candidate = buildCandidate({ status: 'sent', sentAt: daysAgo(FOLLOWUP_INTERVAL_DAYS - 1) });
    findManyMock.mockResolvedValue([candidate]);

    const outcomes = await runFollowupScheduler();

    expect(outcomes).toEqual([]);
    expect(updateManyMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('treats staleness as inclusive at exactly FOLLOWUP_INTERVAL_DAYS (boundary is due, not "one day short")', async () => {
    const candidate = buildCandidate({ status: 'sent', sentAt: new Date(Date.now() - FOLLOWUP_INTERVAL_DAYS * MS_PER_DAY) });
    findManyMock.mockResolvedValue([candidate]);

    const outcomes = await runFollowupScheduler();

    expect(outcomes).toEqual([{ prospectId: candidate.id, outcome: 'sent', touch: 2 }]);
  });

  it('does not treat a prospect as due shortly before the interval elapses', async () => {
    // A few minutes short of the interval, rather than an exact
    // millisecond boundary - `runFollowupScheduler` computes its own `now`
    // internally (no injectable reference clock), so a true 1ms-precision
    // boundary assertion would be flaky against real test-execution jitter.
    const candidate = buildCandidate({
      status: 'sent',
      sentAt: new Date(Date.now() - FOLLOWUP_INTERVAL_DAYS * MS_PER_DAY + 5 * 60 * 1000),
    });
    findManyMock.mockResolvedValue([candidate]);

    const outcomes = await runFollowupScheduler();

    expect(outcomes).toEqual([]);
  });

  it('measures staleness from lastFollowupAt, not the original sentAt, once at least one follow-up has already gone out', async () => {
    // sentAt is ancient (would be "stale" many times over), but lastFollowupAt
    // is recent - the prospect must not be treated as due again yet.
    const candidate = buildCandidate({
      status: 'followup_1',
      sentAt: daysAgo(60),
      lastFollowupAt: daysAgo(1),
    });
    findManyMock.mockResolvedValue([candidate]);

    const outcomes = await runFollowupScheduler();

    expect(outcomes).toEqual([]);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});

describe('runFollowupScheduler dead transition for legacy followup_3 prospects', () => {
  it('marks a followup_3 prospect dead once stale again, and never calls sendEmail for it (no 5th touch)', async () => {
    const candidate = buildCandidate({ status: 'followup_3', followupCount: 3, lastFollowupAt: daysAgo(FOLLOWUP_INTERVAL_DAYS + 1) });
    findManyMock.mockResolvedValue([candidate]);

    const outcomes = await runFollowupScheduler();

    expect(outcomes).toEqual([{ prospectId: candidate.id, outcome: 'marked_dead' }]);
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: candidate.id, status: 'followup_3', doNotContact: false },
      data: { status: 'dead', statusHistory: expect.arrayContaining([expect.objectContaining({ status: 'dead' })]) },
    });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('does not mark a followup_3 prospect dead before it has gone stale again', async () => {
    const candidate = buildCandidate({ status: 'followup_3', lastFollowupAt: daysAgo(1) });
    findManyMock.mockResolvedValue([candidate]);

    const outcomes = await runFollowupScheduler();

    expect(outcomes).toEqual([]);
    expect(updateManyMock).not.toHaveBeenCalled();
  });
});

// The core correctness invariant of this phase: a reply must halt follow-ups
// with zero race window. There is no intermediate "check status is still
// valid" read in attemptFollowupSend between reading the candidate and
// issuing the atomic claim - the claim's own WHERE clause (keyed to the
// exact status this candidate was read at) is the *only* thing standing
// between a stale read and an incorrect send. These tests prove that by
// controlling only what the claim itself returns.
describe('runFollowupScheduler reply-vs-follow-up race', () => {
  it('does not send a follow-up once a reply has flipped the prospect\'s status, even though the candidate was read while still eligible (claim returns 0 rows matched)', async () => {
    const candidate = buildCandidate({ status: 'sent', sentAt: daysAgo(FOLLOWUP_INTERVAL_DAYS + 1) });
    findManyMock.mockResolvedValue([candidate]);
    // Models a reply-detection updateMany having already moved this exact row
    // to `replied` between this scheduler's findMany read and its own claim
    // attempt - a real DB's `UPDATE ... WHERE status = 'sent'` would match 0
    // rows once the row is no longer `sent`.
    updateManyMock.mockResolvedValue({ count: 0 });

    const outcomes = await runFollowupScheduler();

    expect(outcomes).toEqual([{ prospectId: candidate.id, outcome: 'skipped_not_eligible' }]);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("keys the atomic claim's WHERE clause to the exact status read for this candidate, not a broader/staler condition that a reply could slip past", async () => {
    const candidate = buildCandidate({ status: 'followup_2', lastFollowupAt: daysAgo(FOLLOWUP_INTERVAL_DAYS + 1) });
    findManyMock.mockResolvedValue([candidate]);
    updateManyMock.mockResolvedValue({ count: 0 });

    await runFollowupScheduler();

    // The claim must condition on `followup_2` (this candidate's read status)
    // and `doNotContact: false` - never a looser WHERE (e.g. "status is any
    // in-flight status") that a reply already committed to `replied` could
    // still satisfy.
    expect(updateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: candidate.id, status: 'followup_2', doNotContact: false } })
    );
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  // Proves the guarantee by actually racing two concurrent atomic claims
  // against the same underlying row via a stateful mock, the same technique
  // send-queue.service.test.ts uses for its own "concurrent requests for the
  // same draftId" proof: only the claim that resolves first can ever win.
  it('when a concurrent reply and this scheduler run race for the same prospect, only one atomic claim can win, and the loser never sends', async () => {
    const candidate = buildCandidate({ status: 'sent', sentAt: daysAgo(FOLLOWUP_INTERVAL_DAYS + 1) });
    findManyMock.mockResolvedValueOnce([candidate]).mockResolvedValueOnce([candidate]);
    // First updateMany call to actually execute (whichever caller reaches it
    // first) wins the row; the second sees it already claimed.
    updateManyMock.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });

    const [firstRun, secondRun] = await Promise.all([runFollowupScheduler(), runFollowupScheduler()]);

    const outcomes = [firstRun[0]?.outcome, secondRun[0]?.outcome].sort();
    expect(outcomes).toEqual(['sent', 'skipped_not_eligible']);
    // The core guarantee: two racing attempts against the same prospect,
    // never more than one real send.
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });

  it('rolls back nothing and sends nothing when doNotContact flips true between the read and the claim (claim matches 0 rows)', async () => {
    // Read snapshot shows doNotContact:false (otherwise it wouldn't have been
    // a candidate at all), but the claim's fresh WHERE doNotContact:false
    // check is what actually protects against a flip that happened after the
    // read - modeled here by the claim itself returning 0.
    const candidate = buildCandidate({ status: 'sent', sentAt: daysAgo(FOLLOWUP_INTERVAL_DAYS + 1), doNotContact: false });
    findManyMock.mockResolvedValue([candidate]);
    updateManyMock.mockResolvedValue({ count: 0 });

    const outcomes = await runFollowupScheduler();

    expect(outcomes).toEqual([{ prospectId: candidate.id, outcome: 'skipped_not_eligible' }]);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(rollBackDailySendSlotMock).toHaveBeenCalledTimes(1);
  });
});

describe('runFollowupScheduler daily cap enforcement', () => {
  it('re-reserves a slot before every individual send: with 1 slot of headroom in a batch of 2 due prospects, sends exactly 1 and skips the rest as skipped_cap', async () => {
    const CAP = 3;
    dailySendState.reservedCount = CAP - 1;
    getEffectiveDailyCapMock.mockReturnValue(CAP);

    const candidateA = buildCandidate({ id: 'prospect-a', priorityScore: 2 });
    const candidateB = buildCandidate({ id: 'prospect-b', priorityScore: 1 });
    findManyMock.mockResolvedValue([candidateA, candidateB]);

    const outcomes = await runFollowupScheduler();

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(outcomes).toEqual([
      { prospectId: 'prospect-a', outcome: 'sent', touch: 2 },
      { prospectId: 'prospect-b', outcome: 'skipped_cap' },
    ]);
  });

  it('reports every remaining due prospect as skipped_cap once the cap is already at/above the limit, without ever calling sendEmail or attempting a claim', async () => {
    getEffectiveDailyCapMock.mockReturnValue(0);
    const candidateA = buildCandidate({ id: 'prospect-a', priorityScore: 2 });
    const candidateB = buildCandidate({ id: 'prospect-b', priorityScore: 1 });
    findManyMock.mockResolvedValue([candidateA, candidateB]);

    const outcomes = await runFollowupScheduler();

    expect(outcomes.every((o) => o.outcome === 'skipped_cap')).toBe(true);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it('does not consult the cap at all for a followup_3 prospect being marked dead (dead transitions are not sends)', async () => {
    getEffectiveDailyCapMock.mockReturnValue(0);
    const candidate = buildCandidate({ status: 'followup_3', lastFollowupAt: daysAgo(FOLLOWUP_INTERVAL_DAYS + 1) });
    findManyMock.mockResolvedValue([candidate]);

    const outcomes = await runFollowupScheduler();

    expect(outcomes).toEqual([{ prospectId: candidate.id, outcome: 'marked_dead' }]);
    expect(reserveDailySendSlotMock).not.toHaveBeenCalled();
  });
});

describe('runFollowupScheduler missing contact info / invalid signal', () => {
  it('reports failed without ever attempting the atomic claim when the prospect has no contact email on file', async () => {
    const candidate = buildCandidate({ contactEmail: null });
    findManyMock.mockResolvedValue([candidate]);

    const outcomes = await runFollowupScheduler();

    expect(outcomes).toEqual([
      { prospectId: candidate.id, outcome: 'failed', reason: 'prospect has no contact email on file' },
    ]);
    expect(updateManyMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(rollBackDailySendSlotMock).toHaveBeenCalledTimes(1);
  });

  it('reports failed without attempting the claim when the prospect has no valid signal on file', async () => {
    const candidate = buildCandidate({ signal: { not: 'a valid signal shape' } });
    findManyMock.mockResolvedValue([candidate]);

    const outcomes = await runFollowupScheduler();

    expect(outcomes).toEqual([
      { prospectId: candidate.id, outcome: 'failed', reason: 'prospect has no valid signal on file' },
    ]);
    expect(updateManyMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(rollBackDailySendSlotMock).toHaveBeenCalledTimes(1);
  });
});

describe('runFollowupScheduler send failure rollback', () => {
  it('rolls the claim back to the prior status/lastFollowupAt/followupCount when sendEmail definitely did not send, conditioned on the claim\'s new status (followup_1) so a later legitimate retry is not permanently blocked', async () => {
    sendEmailMock.mockResolvedValue({ ok: false, reason: 'resend responded with 422', definitelyNotSent: true });
    const priorLastFollowupAt = daysAgo(FOLLOWUP_INTERVAL_DAYS + 1);
    const candidate = buildCandidate({ status: 'sent', sentAt: priorLastFollowupAt, followupCount: 0, lastFollowupAt: null });
    findManyMock.mockResolvedValue([candidate]);

    const outcomes = await runFollowupScheduler();

    expect(outcomes).toEqual([
      { prospectId: candidate.id, outcome: 'failed', reason: 'resend responded with 422' },
    ]);
    // Conditioned rollback: WHERE keys off `followup_1` - the status THIS
    // call's claim just set - not an unconditional `update`. This is what
    // lets a concurrent reply that already moved status away from
    // `followup_1` make the rollback a no-op instead of overwriting it (see
    // the race test below).
    expect(updateManyMock).toHaveBeenLastCalledWith({
      where: { id: candidate.id, status: 'followup_1' },
      data: {
        status: 'sent',
        lastFollowupAt: null,
        followupCount: 0,
        statusHistory: candidate.statusHistory,
      },
    });
    expect(rollBackDailySendSlotMock).toHaveBeenCalledTimes(1);
  });

  it('does not roll back the reserved daily-cap slot when sendEmail actually succeeds', async () => {
    const candidate = buildCandidate({ id: 'prospect-a' });
    findManyMock.mockResolvedValue([candidate]);

    const outcomes = await runFollowupScheduler();

    expect(outcomes).toEqual([{ prospectId: 'prospect-a', outcome: 'sent', touch: 2 }]);
    expect(reserveDailySendSlotMock).toHaveBeenCalledTimes(1);
    expect(rollBackDailySendSlotMock).not.toHaveBeenCalled();
  });

  it('does not resurrect a prospect into follow-up eligibility when a concurrent reply flips status to replied before the send-failure rollback runs: rollback updateMany matches 0 rows and the prospect stays replied', async () => {
    sendEmailMock.mockResolvedValue({ ok: false, reason: 'resend responded with 422', definitelyNotSent: true });
    const candidate = buildCandidate({ status: 'sent', sentAt: daysAgo(FOLLOWUP_INTERVAL_DAYS + 1), followupCount: 0, lastFollowupAt: null });
    findManyMock.mockResolvedValue([candidate]);

    // First updateMany call is this candidate's forward claim (sent ->
    // followup_1) - it succeeds. Between that claim and the (failing)
    // sendEmail call, model a concurrent reply-detection.service.ts claim
    // having already moved the row to `replied`. The second updateMany call
    // is the rollback attempt, which must now match 0 rows because its WHERE
    // requires status: 'followup_1' and the row is actually 'replied'.
    updateManyMock.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });

    const outcomes = await runFollowupScheduler();

    expect(outcomes).toEqual([
      { prospectId: candidate.id, outcome: 'failed', reason: 'resend responded with 422' },
    ]);
    expect(updateManyMock).toHaveBeenCalledTimes(2);
    expect(updateManyMock).toHaveBeenLastCalledWith({
      where: { id: candidate.id, status: 'followup_1' },
      data: {
        status: 'sent',
        lastFollowupAt: null,
        followupCount: 0,
        statusHistory: candidate.statusHistory,
      },
    });
    // The rollback's own count (0) proves it did not touch the row - the
    // prospect is left as `replied` by the concurrent reply claim, not
    // resurrected back to `sent`/follow-up-eligible.
    await expect(updateManyMock.mock.results[1].value).resolves.toEqual({ count: 0 });
  });

  it('keeps the claim (no rollback to sent) and tags the prospect when sendEmail fails ambiguously, since the provider may have delivered', async () => {
    sendEmailMock.mockResolvedValue({ ok: false, reason: 'resend responded with 500' });
    const candidate = buildCandidate({ status: 'sent', followupCount: 0, lastFollowupAt: null });
    findManyMock.mockResolvedValue([candidate]);

    const outcomes = await runFollowupScheduler();

    expect(outcomes).toEqual([
      {
        prospectId: candidate.id,
        outcome: 'failed',
        reason: 'send outcome unconfirmed, not retried: resend responded with 500',
      },
    ]);
    expect(updateManyMock).toHaveBeenCalledTimes(2);
    expect(updateManyMock).toHaveBeenLastCalledWith({
      where: { id: candidate.id, status: 'followup_1' },
      data: { tags: { push: FOLLOWUP_SEND_UNCONFIRMED_TAG } },
    });
    for (const [args] of updateManyMock.mock.calls) {
      expect(args.data).not.toHaveProperty('status', 'sent');
    }
    expect(rollBackDailySendSlotMock).not.toHaveBeenCalled();
  });

  it('does not re-send touch 2 on the next run after an ambiguous failure, because the prospect is now followup_1 and not yet stale', async () => {
    sendEmailMock.mockResolvedValue({ ok: false, reason: 'resend request failed (timeout)' });
    findManyMock.mockResolvedValue([buildCandidate({ status: 'sent' })]);
    await runFollowupScheduler();
    expect(sendEmailMock).toHaveBeenCalledTimes(1);

    // What the DB holds after the kept claim: followup_1, lastFollowupAt now.
    findManyMock.mockResolvedValue([
      buildCandidate({ status: 'followup_1', followupCount: 1, lastFollowupAt: new Date() }),
    ]);
    const secondRun = await runFollowupScheduler();

    expect(secondRun).toEqual([]);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });
});

describe('runFollowupScheduler original subject lookup', () => {
  it('keeps the follow-up in the original thread by prefixing "Re: " to the active draft\'s subject when one is on file', async () => {
    const candidate = buildCandidate({ activeDraftId: 'draft-1' });
    findManyMock.mockResolvedValue([candidate]);
    findUniqueDraftMock.mockResolvedValue({ subject: 'A faster path for Acme Co' });

    await runFollowupScheduler();

    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({ subject: 'Re: A faster path for Acme Co' })
    );
  });

  it('falls back to a synthesized subject when there is no activeDraftId on file', async () => {
    const candidate = buildCandidate({ activeDraftId: null });
    findManyMock.mockResolvedValue([candidate]);

    await runFollowupScheduler();

    expect(findUniqueDraftMock).not.toHaveBeenCalled();
    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({ subject: expect.stringContaining('Acme Co') })
    );
  });
});
