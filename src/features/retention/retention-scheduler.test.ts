import { beforeEach, describe, expect, it, vi } from 'vitest';

// This is the highest-stakes orchestration test in this phase: the atomic
// claim inside `attemptRetentionSend` is what makes the
// concurrent-scheduler-run / concurrent-status-change race impossible to
// lose - a status change (or a second scheduler run claiming the same
// touch) landing between this module's read and its claim must make the
// claim match zero rows and abort before `sendEmail` is ever called. Prisma,
// the daily-cap gate, the send-count reader, and `sendEmail` are all mocked
// (matching followup-scheduler.test.ts's own style); `retention-templates.ts`
// is left real since it's pure and already covered by its own suite.
const { findManyJobMock, updateManyJobMock, findFirstJobMock } = vi.hoisted(() => ({
  findManyJobMock: vi.fn(),
  updateManyJobMock: vi.fn(),
  findFirstJobMock: vi.fn(),
}));

vi.mock('@/common/db/client', () => ({
  prisma: {
    job: { findMany: findManyJobMock, updateMany: updateManyJobMock, findFirst: findFirstJobMock },
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

const { runRetentionScheduler, QUARTERLY_REPEAT_DAYS } = await import('./retention-scheduler');

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * MS_PER_DAY);
}

interface CandidateOverrides {
  id?: string;
  clientId?: string;
  cadence?: 'one_off' | 'recurring';
  status?: 'delivered' | 'monthly';
  soldAt?: Date;
  deliveredAt?: Date | null;
  lastRetentionTouchAt?: Date | null;
  retentionTouchCount?: number;
  statusHistory?: unknown;
  companyName?: string;
  contactEmail?: string | null;
  doNotContact?: boolean;
}

function buildCandidate(overrides: CandidateOverrides = {}) {
  const cadence = overrides.cadence ?? 'one_off';
  return {
    id: overrides.id ?? 'job-1',
    clientId: overrides.clientId ?? 'client-1',
    cadence,
    status: overrides.status ?? (cadence === 'recurring' ? 'monthly' : 'delivered'),
    soldAt: overrides.soldAt ?? daysAgo(200),
    deliveredAt: overrides.deliveredAt === undefined ? daysAgo(200) : overrides.deliveredAt,
    lastRetentionTouchAt: overrides.lastRetentionTouchAt === undefined ? null : overrides.lastRetentionTouchAt,
    retentionTouchCount: overrides.retentionTouchCount ?? 0,
    statusHistory: overrides.statusHistory ?? [],
    client: {
      companyName: overrides.companyName ?? 'Acme Co',
      contactEmail: overrides.contactEmail === undefined ? 'contact@example.com' : overrides.contactEmail,
      doNotContact: overrides.doNotContact ?? false,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  findManyJobMock.mockResolvedValue([]);
  updateManyJobMock.mockResolvedValue({ count: 1 });
  findFirstJobMock.mockResolvedValue(null);
  getEffectiveDailyCapMock.mockReturnValue(10);
  dailySendState.reservedCount = 0;
  sendEmailMock.mockResolvedValue({ ok: true, id: 'resend-message-id' });
});

describe('runRetentionScheduler candidate query', () => {
  it('queries one-off delivered Jobs OR recurring monthly Jobs, joined through doNotContact:false on the Client', async () => {
    await runRetentionScheduler();

    expect(findManyJobMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [
            { cadence: 'one_off', status: 'delivered' },
            { cadence: 'recurring', status: 'monthly' },
          ],
          client: { doNotContact: false },
        },
      })
    );
  });
});

describe('runRetentionScheduler one-off staleness/touch progression', () => {
  it('sends touch 1 (review) once 3 days have elapsed since deliveredAt', async () => {
    const candidate = buildCandidate({ deliveredAt: daysAgo(3), retentionTouchCount: 0 });
    findManyJobMock.mockResolvedValue([candidate]);

    const outcomes = await runRetentionScheduler();

    expect(outcomes).toEqual([{ jobId: candidate.id, outcome: 'sent', touchNumber: 1 }]);
    expect(updateManyJobMock).toHaveBeenCalledWith({
      where: {
        id: candidate.id,
        status: 'delivered',
        lastRetentionTouchAt: null,
        retentionTouchCount: 0,
        client: { doNotContact: false },
      },
      data: {
        lastRetentionTouchAt: expect.any(Date),
        retentionTouchCount: { increment: 1 },
        statusHistory: expect.arrayContaining([expect.objectContaining({ status: 'retention_touch_1' })]),
      },
    });
  });

  it('does not send touch 1 before 3 days have elapsed since deliveredAt', async () => {
    const candidate = buildCandidate({ deliveredAt: daysAgo(2), retentionTouchCount: 0 });
    findManyJobMock.mockResolvedValue([candidate]);

    const outcomes = await runRetentionScheduler();

    expect(outcomes).toEqual([]);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('sends touch 2 (referral) once 11 days have elapsed since the touch-1 timestamp (day 14 total)', async () => {
    const candidate = buildCandidate({ retentionTouchCount: 1, lastRetentionTouchAt: daysAgo(11) });
    findManyJobMock.mockResolvedValue([candidate]);

    const outcomes = await runRetentionScheduler();

    expect(outcomes).toEqual([{ jobId: candidate.id, outcome: 'sent', touchNumber: 2 }]);
  });

  it('sends touch 3 (check-in-30) once 16 days have elapsed since the touch-2 timestamp (day 30 total)', async () => {
    const candidate = buildCandidate({ retentionTouchCount: 2, lastRetentionTouchAt: daysAgo(16) });
    findManyJobMock.mockResolvedValue([candidate]);

    const outcomes = await runRetentionScheduler();

    expect(outcomes).toEqual([{ jobId: candidate.id, outcome: 'sent', touchNumber: 3 }]);
  });

  it('sends touch 4 (quarterly) once 60 days have elapsed since the touch-3 timestamp (day 90 total)', async () => {
    const candidate = buildCandidate({ retentionTouchCount: 3, lastRetentionTouchAt: daysAgo(60) });
    findManyJobMock.mockResolvedValue([candidate]);

    const outcomes = await runRetentionScheduler();

    expect(outcomes).toEqual([{ jobId: candidate.id, outcome: 'sent', touchNumber: 4 }]);
  });

  it('keeps sending touch 4 (quarterly) every 90 days indefinitely once past the first quarterly touch', async () => {
    const candidate = buildCandidate({ retentionTouchCount: 6, lastRetentionTouchAt: daysAgo(QUARTERLY_REPEAT_DAYS) });
    findManyJobMock.mockResolvedValue([candidate]);

    const outcomes = await runRetentionScheduler();

    expect(outcomes).toEqual([{ jobId: candidate.id, outcome: 'sent', touchNumber: 4 }]);
  });

  it('does not send the next touch shortly before its gap elapses', async () => {
    const candidate = buildCandidate({ retentionTouchCount: 3, lastRetentionTouchAt: daysAgo(59) });
    findManyJobMock.mockResolvedValue([candidate]);

    const outcomes = await runRetentionScheduler();

    expect(outcomes).toEqual([]);
  });
});

describe('runRetentionScheduler recurring (monthly) Job cadence', () => {
  it('sends only the quarterly touch at day 90 from soldAt, never a day-3/14/30 touch', async () => {
    const candidate = buildCandidate({
      cadence: 'recurring',
      status: 'monthly',
      soldAt: daysAgo(90),
      retentionTouchCount: 0,
    });
    findManyJobMock.mockResolvedValue([candidate]);

    const outcomes = await runRetentionScheduler();

    expect(outcomes).toEqual([{ jobId: candidate.id, outcome: 'sent', touchNumber: 4 }]);
  });

  it('does not send before day 90 has elapsed since soldAt for a recurring Job with no prior touch', async () => {
    const candidate = buildCandidate({ cadence: 'recurring', status: 'monthly', soldAt: daysAgo(89) });
    findManyJobMock.mockResolvedValue([candidate]);

    const outcomes = await runRetentionScheduler();

    expect(outcomes).toEqual([]);
  });

  it('sends the next quarterly touch 90 days after the previous recurring touch, measured from lastRetentionTouchAt not soldAt', async () => {
    const candidate = buildCandidate({
      cadence: 'recurring',
      status: 'monthly',
      soldAt: daysAgo(400),
      retentionTouchCount: 3,
      lastRetentionTouchAt: daysAgo(90),
    });
    findManyJobMock.mockResolvedValue([candidate]);

    const outcomes = await runRetentionScheduler();

    expect(outcomes).toEqual([{ jobId: candidate.id, outcome: 'sent', touchNumber: 4 }]);
  });
});

describe('runRetentionScheduler upsell suppression', () => {
  it('renders with_upsell (checking the sibling query) for a day-30 touch when no sibling monthly Job exists', async () => {
    findFirstJobMock.mockResolvedValue(null);
    const candidate = buildCandidate({ retentionTouchCount: 2, lastRetentionTouchAt: daysAgo(16) });
    findManyJobMock.mockResolvedValue([candidate]);

    await runRetentionScheduler();

    expect(findFirstJobMock).toHaveBeenCalledWith({
      where: { clientId: candidate.clientId, status: 'monthly', id: { not: candidate.id } },
      select: { id: true },
    });
    expect(sendEmailMock).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringMatching(/recurring plan|retainer|hosting|maintenance/i) }));
  });

  it('suppresses the upsell (checkin_only) for a day-30 touch when a sibling monthly Job already exists on the Client', async () => {
    findFirstJobMock.mockResolvedValue({ id: 'sibling-job' });
    const candidate = buildCandidate({ retentionTouchCount: 2, lastRetentionTouchAt: daysAgo(16) });
    findManyJobMock.mockResolvedValue([candidate]);

    await runRetentionScheduler();

    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.not.stringMatching(/recurring plan|retainer/i) })
    );
  });

  it('suppresses the upsell for a quarterly (touch 4) touch when a sibling monthly Job exists', async () => {
    findFirstJobMock.mockResolvedValue({ id: 'sibling-job' });
    const candidate = buildCandidate({ retentionTouchCount: 3, lastRetentionTouchAt: daysAgo(60) });
    findManyJobMock.mockResolvedValue([candidate]);

    await runRetentionScheduler();

    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.not.stringMatching(/recurring plan|retainer/i) })
    );
  });

  it('never checks for a sibling monthly Job for touch 1 (review) or touch 2 (referral)', async () => {
    const touch1 = buildCandidate({ id: 'job-touch1', deliveredAt: daysAgo(3), retentionTouchCount: 0 });
    findManyJobMock.mockResolvedValue([touch1]);

    await runRetentionScheduler();

    expect(findFirstJobMock).not.toHaveBeenCalled();
  });
});

describe('runRetentionScheduler race safety', () => {
  it('does not send when a concurrent claim has already advanced lastRetentionTouchAt/retentionTouchCount (claim matches 0 rows)', async () => {
    const candidate = buildCandidate({ deliveredAt: daysAgo(3), retentionTouchCount: 0 });
    findManyJobMock.mockResolvedValue([candidate]);
    updateManyJobMock.mockResolvedValue({ count: 0 });

    const outcomes = await runRetentionScheduler();

    expect(outcomes).toEqual([{ jobId: candidate.id, outcome: 'skipped_not_eligible' }]);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(rollBackDailySendSlotMock).toHaveBeenCalledTimes(1);
  });

  it('when two concurrent scheduler runs race for the same Job touch, only one atomic claim can win, and the loser never sends', async () => {
    const candidate = buildCandidate({ deliveredAt: daysAgo(3), retentionTouchCount: 0 });
    findManyJobMock.mockResolvedValueOnce([candidate]).mockResolvedValueOnce([candidate]);
    updateManyJobMock.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });

    const [firstRun, secondRun] = await Promise.all([runRetentionScheduler(), runRetentionScheduler()]);

    const outcomes = [firstRun[0]?.outcome, secondRun[0]?.outcome].sort();
    expect(outcomes).toEqual(['sent', 'skipped_not_eligible']);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });
});

describe('runRetentionScheduler daily cap enforcement', () => {
  it('re-reserves a slot before every individual send: with 1 slot of headroom in a batch of 2 due Jobs, sends exactly 1 and skips the rest as skipped_cap', async () => {
    const CAP = 3;
    dailySendState.reservedCount = CAP - 1;
    getEffectiveDailyCapMock.mockReturnValue(CAP);

    const candidateA = buildCandidate({ id: 'job-a', deliveredAt: daysAgo(3), retentionTouchCount: 0 });
    const candidateB = buildCandidate({ id: 'job-b', deliveredAt: daysAgo(3), retentionTouchCount: 0 });
    findManyJobMock.mockResolvedValue([candidateA, candidateB]);

    const outcomes = await runRetentionScheduler();

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(outcomes).toEqual([
      { jobId: 'job-a', outcome: 'sent', touchNumber: 1 },
      { jobId: 'job-b', outcome: 'skipped_cap' },
    ]);
  });

  it('reports every remaining due Job as skipped_cap once the cap is already at/above the limit, without ever calling sendEmail or attempting a claim', async () => {
    getEffectiveDailyCapMock.mockReturnValue(0);
    const candidateA = buildCandidate({ id: 'job-a', deliveredAt: daysAgo(3), retentionTouchCount: 0 });
    const candidateB = buildCandidate({ id: 'job-b', deliveredAt: daysAgo(3), retentionTouchCount: 0 });
    findManyJobMock.mockResolvedValue([candidateA, candidateB]);

    const outcomes = await runRetentionScheduler();

    expect(outcomes.every((o) => o.outcome === 'skipped_cap')).toBe(true);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(updateManyJobMock).not.toHaveBeenCalled();
  });
});

describe('runRetentionScheduler missing contact info', () => {
  it('reports failed without ever attempting the atomic claim when the Client has no contact email on file', async () => {
    const candidate = buildCandidate({ deliveredAt: daysAgo(3), retentionTouchCount: 0, contactEmail: null });
    findManyJobMock.mockResolvedValue([candidate]);

    const outcomes = await runRetentionScheduler();

    expect(outcomes).toEqual([{ jobId: candidate.id, outcome: 'failed', reason: 'client has no contact email on file' }]);
    expect(updateManyJobMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(rollBackDailySendSlotMock).toHaveBeenCalledTimes(1);
  });
});

describe('runRetentionScheduler send failure rollback', () => {
  it('rolls the claim back to the prior lastRetentionTouchAt/retentionTouchCount when sendEmail fails', async () => {
    sendEmailMock.mockResolvedValue({ ok: false, reason: 'resend responded with 500' });
    const candidate = buildCandidate({ deliveredAt: daysAgo(3), retentionTouchCount: 0, lastRetentionTouchAt: null });
    findManyJobMock.mockResolvedValue([candidate]);

    const outcomes = await runRetentionScheduler();

    expect(outcomes).toEqual([{ jobId: candidate.id, outcome: 'failed', reason: 'resend responded with 500' }]);
    expect(updateManyJobMock).toHaveBeenLastCalledWith({
      where: { id: candidate.id, lastRetentionTouchAt: expect.any(Date), retentionTouchCount: 1 },
      data: { lastRetentionTouchAt: null, retentionTouchCount: 0, statusHistory: candidate.statusHistory },
    });
    expect(rollBackDailySendSlotMock).toHaveBeenCalledTimes(1);
  });

  it('does not roll back the reserved daily-cap slot when sendEmail actually succeeds', async () => {
    const candidate = buildCandidate({ id: 'job-a', deliveredAt: daysAgo(3), retentionTouchCount: 0 });
    findManyJobMock.mockResolvedValue([candidate]);

    const outcomes = await runRetentionScheduler();

    expect(outcomes).toEqual([{ jobId: 'job-a', outcome: 'sent', touchNumber: 1 }]);
    expect(reserveDailySendSlotMock).toHaveBeenCalledTimes(1);
    expect(rollBackDailySendSlotMock).not.toHaveBeenCalled();
  });
});
