import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Prisma } from '@/lib/generated/prisma/client';

// This is the single riskiest orchestration test in the repo: approveDrafts
// is the ONLY function in the codebase permitted to call sendEmail, and it
// carries the core project invariant - "no code path may send an email
// without a human clicking approve first" - plus the daily-cap and
// do-not-contact fail-closed guarantees. Prisma and resend.client.ts are
// both mocked (this is an orchestration test, not a real-send test); the
// daily-cap gate and send-count reader each have their own dedicated
// suites, so they're mocked here too - only send-queue.service.ts's own
// ordering, cap re-check, and success/failure persistence logic is under
// test.
const {
  findManyDraftMock,
  updateDraftMock,
  updateManyDraftMock,
  findUniqueDraftMock,
  updateProspectMock,
  updateManyProspectMock,
  queryRawMock,
  findUniqueClaimProspectMock,
  transactionMock,
} = vi.hoisted(() => ({
    findManyDraftMock: vi.fn(),
    updateDraftMock: vi.fn(),
    updateManyDraftMock: vi.fn(),
    findUniqueDraftMock: vi.fn(),
    updateProspectMock: vi.fn(),
    updateManyProspectMock: vi.fn(),
    queryRawMock: vi.fn(),
    findUniqueClaimProspectMock: vi.fn(),
    transactionMock: vi.fn(),
}));

vi.mock('@/common/db/client', () => ({
  prisma: {
    // Interactive transaction modeled as invoking the callback with a tx that
    // shares the same mocks (same approach as convert-to-client.service.test.ts).
    // `queryRawMock` stands in for the `SELECT ... FOR UPDATE` row lock.
    $transaction: transactionMock,
    draft: {
      findMany: findManyDraftMock,
      update: updateDraftMock,
      updateMany: updateManyDraftMock,
      findUnique: findUniqueDraftMock,
    },
    prospect: { update: updateProspectMock, updateMany: updateManyProspectMock },
  },
}));

const getEffectiveDailyCapMock = vi.fn();
vi.mock('@/features/sending/domain-verification-gate', () => ({
  getEffectiveDailyCap: getEffectiveDailyCapMock,
}));

// Models `reserveDailySendSlot`'s real atomic-counter semantics closely
// enough for an orchestration test: `dailySendState.reservedCount` stands in
// for the row `ApiUsageCounter`-style atomicity actually protects in
// production (see daily-send-counter.ts) - a test sets it to simulate "N
// already reserved today" the same way it used to seed `sentSoFar` for the
// old `getTodaysSendCount` mock.
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

const { approveDrafts } = await import('./send-queue.service');

// What the claim writes to the draft: approved, plus the marker recording when
// this attempt started (see unconfirmed-send.ts).
const IN_FLIGHT_MARKER = { inFlight: true, startedAt: expect.any(String) };

const MS_PER_MINUTE = 60 * 1000;

function minutesAgo(minutes: number): Date {
  return new Date(Date.now() - minutes * MS_PER_MINUTE);
}

// A sibling draft as the claim and the pre-check see it.
function siblingDraft(overrides: { id?: string; approved?: boolean; generatedAt?: Date; lastSendFailure?: unknown } = {}) {
  return {
    id: overrides.id ?? 'sibling',
    approved: overrides.approved ?? false,
    generatedAt: overrides.generatedAt ?? minutesAgo(60),
    lastSendFailure: overrides.lastSendFailure ?? null,
  };
}

// The prospect row the claim reads after taking the row lock.
function claimProspect(overrides: { status?: string; sentAt?: Date | null; tags?: string[]; drafts?: ReturnType<typeof siblingDraft>[] } = {}) {
  return {
    status: overrides.status ?? 'drafted',
    sentAt: overrides.sentAt === undefined ? null : overrides.sentAt,
    tags: overrides.tags ?? [],
    drafts: overrides.drafts ?? [],
  };
}

interface DraftRowOverrides {
  id?: string;
  prospectId?: string;
  subject?: string;
  body?: string;
  humanizedBody?: string | null;
  priorityScore?: number;
  approved?: boolean;
  prospect?: Partial<{
    doNotContact: boolean;
    contactEmail: string | null;
    statusHistory: unknown;
    tags: string[];
    status: string;
    sentAt: Date | null;
    drafts: Array<ReturnType<typeof siblingDraft>>;
  }>;
}

function buildDraftRow(overrides: DraftRowOverrides = {}) {
  const prospectId = overrides.prospectId ?? 'prospect-1';
  return {
    id: overrides.id ?? 'draft-1',
    prospectId,
    subject: overrides.subject ?? 'Subject',
    body: overrides.body ?? 'Original body',
    humanizedBody: overrides.humanizedBody === undefined ? null : overrides.humanizedBody,
    approved: overrides.approved ?? false,
    prospect: {
      id: prospectId,
      doNotContact: overrides.prospect?.doNotContact ?? false,
      priorityScore: overrides.priorityScore ?? 1,
      contactEmail:
        overrides.prospect?.contactEmail === undefined ? 'contact@example.com' : overrides.prospect.contactEmail,
      statusHistory: overrides.prospect?.statusHistory ?? [],
      tags: overrides.prospect?.tags ?? [],
      status: overrides.prospect?.status ?? 'drafted',
      sentAt: overrides.prospect?.sentAt === undefined ? null : overrides.prospect.sentAt,
      drafts: overrides.prospect?.drafts ?? [],
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  findManyDraftMock.mockResolvedValue([]);
  updateDraftMock.mockResolvedValue({});
  // Happy-path default: the atomic claim always succeeds (count === 1)
  // unless a test deliberately overrides it to model a lost race.
  updateManyDraftMock.mockResolvedValue({ count: 1 });
  findUniqueDraftMock.mockResolvedValue(null);
  queryRawMock.mockResolvedValue([]);
  // Healthy claim-time read by default: still drafted, nothing sent, no siblings.
  findUniqueClaimProspectMock.mockResolvedValue(claimProspect());
  // Interactive transaction modeled as invoking the callback with a tx that
  // shares the same mocks (same approach as convert-to-client.service.test.ts).
  // `queryRawMock` stands in for the `SELECT ... FOR UPDATE` row lock.
  transactionMock.mockImplementation((callback: (tx: unknown) => unknown) =>
    callback({
      $queryRaw: queryRawMock,
      prospect: { findUnique: findUniqueClaimProspectMock },
      draft: { updateMany: updateManyDraftMock },
    })
  );
  updateProspectMock.mockResolvedValue({});
  updateManyProspectMock.mockResolvedValue({ count: 1 });
  getEffectiveDailyCapMock.mockReturnValue(10);
  dailySendState.reservedCount = 0;
  sendEmailMock.mockResolvedValue({ ok: true, id: 'resend-message-id' });
});

describe('approveDrafts empty input', () => {
  it('returns an empty array without querying the database for an empty items array', async () => {
    const results = await approveDrafts([]);

    expect(results).toEqual([]);
    expect(findManyDraftMock).not.toHaveBeenCalled();
  });
});

describe('approveDrafts do-not-contact enforcement', () => {
  it('refuses to send to a doNotContact prospect and never calls sendEmail, even with daily cap room to spare', async () => {
    findManyDraftMock.mockResolvedValue([buildDraftRow({ id: 'draft-1', prospect: { doNotContact: true } })]);

    const results = await approveDrafts([{ draftId: 'draft-1' }]);

    expect(results).toEqual([{ draftId: 'draft-1', outcome: 'skipped_do_not_contact' }]);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(updateManyDraftMock).not.toHaveBeenCalled();
    expect(updateProspectMock).not.toHaveBeenCalled();
  });

  it('checks doNotContact freshly per item in a batch rather than caching a stale value across items', async () => {
    findManyDraftMock.mockResolvedValue([
      buildDraftRow({ id: 'draft-blocked', priorityScore: 10, prospect: { doNotContact: true } }),
      buildDraftRow({ id: 'draft-allowed', priorityScore: 5, prospect: { doNotContact: false } }),
    ]);

    const results = await approveDrafts([{ draftId: 'draft-blocked' }, { draftId: 'draft-allowed' }]);

    expect(results).toEqual([
      { draftId: 'draft-blocked', outcome: 'skipped_do_not_contact' },
      { draftId: 'draft-allowed', outcome: 'sent' },
    ]);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });

  it('does not let a do-not-contact skip count against the daily cap', async () => {
    getEffectiveDailyCapMock.mockReturnValue(1);
    findManyDraftMock.mockResolvedValue([
      buildDraftRow({ id: 'draft-dnc', priorityScore: 2, prospect: { doNotContact: true } }),
      buildDraftRow({ id: 'draft-sendable', priorityScore: 1, prospect: { doNotContact: false } }),
    ]);

    const results = await approveDrafts([{ draftId: 'draft-dnc' }, { draftId: 'draft-sendable' }]);

    expect(results).toEqual([
      { draftId: 'draft-dnc', outcome: 'skipped_do_not_contact' },
      { draftId: 'draft-sendable', outcome: 'sent' },
    ]);
  });
});

describe('approveDrafts daily cap enforcement', () => {
  it('re-reserves a slot before every individual send: a batch of 3 with 1 slot of cap headroom sends exactly 1 and skips the rest as skipped_cap', async () => {
    const CAP = 3;
    dailySendState.reservedCount = CAP - 1; // 2 already reserved/sent today, 1 slot of headroom left
    getEffectiveDailyCapMock.mockReturnValue(CAP);

    findManyDraftMock.mockResolvedValue([
      buildDraftRow({ id: 'draft-a', priorityScore: 3 }),
      buildDraftRow({ id: 'draft-b', priorityScore: 2 }),
      buildDraftRow({ id: 'draft-c', priorityScore: 1 }),
    ]);

    const results = await approveDrafts([{ draftId: 'draft-a' }, { draftId: 'draft-b' }, { draftId: 'draft-c' }]);

    // A "computed/reserved once at batch start" regression would never
    // re-reserve after the first send and would send all 3 instead of 1 -
    // this assertion on the exact call count is what would catch that
    // regression.
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(results).toEqual([
      { draftId: 'draft-a', outcome: 'sent' },
      { draftId: 'draft-b', outcome: 'skipped_cap' },
      { draftId: 'draft-c', outcome: 'skipped_cap' },
    ]);
  });

  it('continues reporting every remaining item as skipped_cap once the cap is hit, rather than stopping the batch silently', async () => {
    getEffectiveDailyCapMock.mockReturnValue(0);
    findManyDraftMock.mockResolvedValue([
      buildDraftRow({ id: 'draft-a', priorityScore: 3 }),
      buildDraftRow({ id: 'draft-b', priorityScore: 2 }),
      buildDraftRow({ id: 'draft-c', priorityScore: 1 }),
    ]);

    const results = await approveDrafts([{ draftId: 'draft-a' }, { draftId: 'draft-b' }, { draftId: 'draft-c' }]);

    expect(results).toHaveLength(3);
    expect(results.every((r) => r.outcome === 'skipped_cap')).toBe(true);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('does not count a do-not-contact skip against the cap even when interleaved with sendable items, and stops sending at exactly the cap', async () => {
    const CAP = 2;
    getEffectiveDailyCapMock.mockReturnValue(CAP);

    findManyDraftMock.mockResolvedValue([
      buildDraftRow({ id: 'draft-a', priorityScore: 4 }),
      buildDraftRow({ id: 'draft-dnc-1', priorityScore: 3, prospect: { doNotContact: true } }),
      buildDraftRow({ id: 'draft-b', priorityScore: 2 }),
      buildDraftRow({ id: 'draft-dnc-2', priorityScore: 1, prospect: { doNotContact: true } }),
      buildDraftRow({ id: 'draft-c', priorityScore: 0 }),
    ]);

    const results = await approveDrafts([
      { draftId: 'draft-a' },
      { draftId: 'draft-dnc-1' },
      { draftId: 'draft-b' },
      { draftId: 'draft-dnc-2' },
      { draftId: 'draft-c' },
    ]);

    expect(results).toEqual([
      { draftId: 'draft-a', outcome: 'sent' },
      { draftId: 'draft-dnc-1', outcome: 'skipped_do_not_contact' },
      { draftId: 'draft-b', outcome: 'sent' },
      { draftId: 'draft-dnc-2', outcome: 'skipped_do_not_contact' },
      { draftId: 'draft-c', outcome: 'skipped_cap' },
    ]);
    expect(sendEmailMock).toHaveBeenCalledTimes(CAP);
  });
});

describe('approveDrafts processing order', () => {
  it('processes the batch in priorityScore-descending order regardless of request order', async () => {
    findManyDraftMock.mockResolvedValue([
      buildDraftRow({ id: 'draft-low', priorityScore: 1, prospect: { contactEmail: 'low@example.com' } }),
      buildDraftRow({ id: 'draft-high', priorityScore: 9, prospect: { contactEmail: 'high@example.com' } }),
      buildDraftRow({ id: 'draft-mid', priorityScore: 5, prospect: { contactEmail: 'mid@example.com' } }),
    ]);

    await approveDrafts([{ draftId: 'draft-low' }, { draftId: 'draft-high' }, { draftId: 'draft-mid' }]);

    expect(sendEmailMock.mock.calls.map((call) => (call[0] as { to: string }).to)).toEqual([
      'high@example.com',
      'mid@example.com',
      'low@example.com',
    ]);
  });

  it('returns outcomes in the same order items were requested in, even though they were processed in a different (priority) order', async () => {
    findManyDraftMock.mockResolvedValue([
      buildDraftRow({ id: 'draft-low', priorityScore: 1 }),
      buildDraftRow({ id: 'draft-high', priorityScore: 9 }),
    ]);

    const results = await approveDrafts([{ draftId: 'draft-low' }, { draftId: 'draft-high' }]);

    expect(results.map((r) => r.draftId)).toEqual(['draft-low', 'draft-high']);
  });
});

describe('approveDrafts unknown drafts', () => {
  it('reports not_found for a requested draftId with no matching Draft row, without affecting other items in the batch', async () => {
    findManyDraftMock.mockResolvedValue([buildDraftRow({ id: 'draft-real' })]);

    const results = await approveDrafts([{ draftId: 'draft-missing' }, { draftId: 'draft-real' }]);

    expect(results).toEqual([
      { draftId: 'draft-missing', outcome: 'not_found' },
      { draftId: 'draft-real', outcome: 'sent' },
    ]);
  });
});

describe('approveDrafts missing contact email', () => {
  it('reports failed without ever calling sendEmail when the prospect has no contact email on file, and rolls back the reserved daily-cap slot since no send happened', async () => {
    findManyDraftMock.mockResolvedValue([buildDraftRow({ id: 'draft-1', prospect: { contactEmail: null } })]);

    const results = await approveDrafts([{ draftId: 'draft-1' }]);

    expect(results).toEqual([
      { draftId: 'draft-1', outcome: 'failed', reason: 'prospect has no contact email on file' },
    ]);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(reserveDailySendSlotMock).toHaveBeenCalledTimes(1);
    expect(rollBackDailySendSlotMock).toHaveBeenCalledTimes(1);
  });
});

describe('approveDrafts send outcome persistence - the core safety boundary', () => {
  it('claims the draft (approved:true) before sending, then rolls the claim back to approved:false when the send fails - never leaving Prospect.status/sentAt set', async () => {
    sendEmailMock.mockResolvedValue({ ok: false, reason: 'resend responded with 422', definitelyNotSent: true });
    findManyDraftMock.mockResolvedValue([buildDraftRow({ id: 'draft-1' })]);

    const results = await approveDrafts([{ draftId: 'draft-1' }]);

    expect(results).toEqual([{ draftId: 'draft-1', outcome: 'failed', reason: 'resend responded with 422' }]);
    // The claim is attempted (that's what makes concurrent double-sends
    // impossible), but since the send failed it must be rolled back so a
    // later legitimate retry can re-approve this draft.
    expect(updateManyDraftMock).toHaveBeenCalledWith({
      where: { id: 'draft-1', approved: false, prospect: { doNotContact: false, NOT: { tags: { has: 'send-unconfirmed' } } } },
      data: { approved: true, lastSendFailure: IN_FLIGHT_MARKER },
    });
    expect(updateDraftMock).toHaveBeenCalledWith({
      where: { id: 'draft-1' },
      data: {
        approved: false,
        lastSendFailure: { reason: 'resend responded with 422', occurredAt: expect.any(String) },
      },
    });
    expect(updateProspectMock).not.toHaveBeenCalled();
    // A failed send never happened, so the reserved daily-cap slot must be
    // given back for a later legitimate retry to use.
    expect(rollBackDailySendSlotMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT roll back the reserved daily-cap slot once a send actually succeeds', async () => {
    findManyDraftMock.mockResolvedValue([buildDraftRow({ id: 'draft-1' })]);

    const results = await approveDrafts([{ draftId: 'draft-1' }]);

    expect(results).toEqual([{ draftId: 'draft-1', outcome: 'sent' }]);
    expect(reserveDailySendSlotMock).toHaveBeenCalledTimes(1);
    expect(rollBackDailySendSlotMock).not.toHaveBeenCalled();
  });

  it('clears a previously recorded lastSendFailure once a later approval of the same draft succeeds', async () => {
    findManyDraftMock.mockResolvedValue([buildDraftRow({ id: 'draft-1' })]);
    sendEmailMock.mockResolvedValueOnce({ ok: false, reason: 'network error', definitelyNotSent: true });

    await approveDrafts([{ draftId: 'draft-1' }]);
    expect(updateDraftMock).toHaveBeenCalledWith({
      where: { id: 'draft-1' },
      data: { approved: false, lastSendFailure: { reason: 'network error', occurredAt: expect.any(String) } },
    });

    updateDraftMock.mockClear();
    sendEmailMock.mockResolvedValueOnce({ ok: true, id: 'resend-message-id' });

    const results = await approveDrafts([{ draftId: 'draft-1' }]);

    expect(results).toEqual([{ draftId: 'draft-1', outcome: 'sent' }]);
    expect(updateDraftMock).toHaveBeenCalledWith({ where: { id: 'draft-1' }, data: { lastSendFailure: Prisma.DbNull } });
  });

  it('sets Draft.approved=true and Prospect.status=sent/sentAt/activeDraftId, appending statusHistory, only after a successful send', async () => {
    findManyDraftMock.mockResolvedValue([
      buildDraftRow({
        id: 'draft-1',
        prospectId: 'prospect-1',
        prospect: { statusHistory: [{ status: 'drafted', timestamp: '2026-01-01T00:00:00.000Z' }] },
      }),
    ]);

    const results = await approveDrafts([{ draftId: 'draft-1' }]);

    expect(results).toEqual([{ draftId: 'draft-1', outcome: 'sent' }]);

    expect(updateManyDraftMock).toHaveBeenCalledWith({
      where: { id: 'draft-1', approved: false, prospect: { doNotContact: false, NOT: { tags: { has: 'send-unconfirmed' } } } },
      data: { approved: true, lastSendFailure: IN_FLIGHT_MARKER },
    });
    // The rollback-with-failure-reason shape must never fire on a successful
    // send - only the "clear any prior failure" shape may.
    expect(updateDraftMock).toHaveBeenCalledWith({ where: { id: 'draft-1' }, data: { lastSendFailure: Prisma.DbNull } });
    expect(updateDraftMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ approved: false }) })
    );

    const prospectUpdateCall = updateProspectMock.mock.calls.find(
      (call) => (call[0] as { data: { status?: string } }).data.status === 'sent'
    )?.[0] as {
      where: { id: string };
      data: { status: string; sentAt: Date; activeDraftId: string; statusHistory: Array<{ status: string }> };
    };

    expect(prospectUpdateCall.where).toEqual({ id: 'prospect-1' });
    expect(prospectUpdateCall.data.status).toBe('sent');
    expect(prospectUpdateCall.data.sentAt).toBeInstanceOf(Date);
    expect(prospectUpdateCall.data.activeDraftId).toBe('draft-1');
    expect(prospectUpdateCall.data.statusHistory).toHaveLength(2);
    expect(prospectUpdateCall.data.statusHistory[0]).toEqual({ status: 'drafted', timestamp: '2026-01-01T00:00:00.000Z' });
    expect(prospectUpdateCall.data.statusHistory[1].status).toBe('sent');
  });

  it('never calls sendEmail for a doNotContact prospect, so no send outcome can ever be recorded for one', async () => {
    findManyDraftMock.mockResolvedValue([buildDraftRow({ id: 'draft-1', prospect: { doNotContact: true } })]);

    await approveDrafts([{ draftId: 'draft-1' }]);

    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(updateProspectMock).not.toHaveBeenCalled();
  });
});

describe('approveDrafts editedBody handling', () => {
  it('applies an editedBody to Draft.body with edited:true, atomically with the approval claim, and sends that edited body', async () => {
    findManyDraftMock.mockResolvedValue([
      buildDraftRow({ id: 'draft-1', body: 'original body', humanizedBody: 'humanized body' }),
    ]);

    await approveDrafts([{ draftId: 'draft-1', editedBody: 'human-edited body' }]);

    expect(updateManyDraftMock).toHaveBeenCalledWith({
      where: { id: 'draft-1', approved: false, prospect: { doNotContact: false, NOT: { tags: { has: 'send-unconfirmed' } } } },
      data: { approved: true, lastSendFailure: IN_FLIGHT_MARKER, body: 'human-edited body', edited: true },
    });
    expect(sendEmailMock).toHaveBeenCalledWith(expect.objectContaining({ body: 'human-edited body' }));
  });

  it('keeps the editedBody applied to Draft.body even when the subsequent send attempt fails - only approved is rolled back', async () => {
    sendEmailMock.mockResolvedValue({ ok: false, reason: 'network error', definitelyNotSent: true });
    findManyDraftMock.mockResolvedValue([buildDraftRow({ id: 'draft-1' })]);

    const results = await approveDrafts([{ draftId: 'draft-1', editedBody: 'edited body' }]);

    expect(results).toEqual([{ draftId: 'draft-1', outcome: 'failed', reason: 'network error' }]);
    expect(updateManyDraftMock).toHaveBeenCalledWith({
      where: { id: 'draft-1', approved: false, prospect: { doNotContact: false, NOT: { tags: { has: 'send-unconfirmed' } } } },
      data: { approved: true, lastSendFailure: IN_FLIGHT_MARKER, body: 'edited body', edited: true },
    });
    // The rollback only resets `approved` (plus recording the failure) - it
    // must not also revert the body edit, or a human's edit would be
    // silently lost on a failed send.
    expect(updateDraftMock).toHaveBeenCalledWith({
      where: { id: 'draft-1' },
      data: { approved: false, lastSendFailure: { reason: 'network error', occurredAt: expect.any(String) } },
    });
    expect(updateDraftMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ body: expect.anything() }) })
    );
  });

  it('sends the humanizedBody when no editedBody was given and a humanizedBody exists', async () => {
    findManyDraftMock.mockResolvedValue([
      buildDraftRow({ id: 'draft-1', body: 'raw body', humanizedBody: 'humanized body' }),
    ]);

    await approveDrafts([{ draftId: 'draft-1' }]);

    expect(sendEmailMock).toHaveBeenCalledWith(expect.objectContaining({ body: 'humanized body' }));
  });

  it('falls back to the raw body when there is no editedBody and no humanizedBody', async () => {
    findManyDraftMock.mockResolvedValue([buildDraftRow({ id: 'draft-1', body: 'raw body', humanizedBody: null })]);

    await approveDrafts([{ draftId: 'draft-1' }]);

    expect(sendEmailMock).toHaveBeenCalledWith(expect.objectContaining({ body: 'raw body' }));
  });
});

describe('approveDrafts already-approved handling (batch snapshot)', () => {
  it('reports skipped_already_approved and never calls sendEmail or attempts the claim for a draft that was already approved before the batch started', async () => {
    findManyDraftMock.mockResolvedValue([buildDraftRow({ id: 'draft-1', approved: true })]);

    const results = await approveDrafts([{ draftId: 'draft-1' }]);

    expect(results).toEqual([{ draftId: 'draft-1', outcome: 'skipped_already_approved' }]);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(updateManyDraftMock).not.toHaveBeenCalled();
  });

  it('does not let an already-approved item consume daily cap headroom or block later legitimate items', async () => {
    getEffectiveDailyCapMock.mockReturnValue(1);
    findManyDraftMock.mockResolvedValue([
      buildDraftRow({ id: 'draft-already', priorityScore: 2, approved: true }),
      buildDraftRow({ id: 'draft-sendable', priorityScore: 1 }),
    ]);

    const results = await approveDrafts([{ draftId: 'draft-already' }, { draftId: 'draft-sendable' }]);

    expect(results).toEqual([
      { draftId: 'draft-already', outcome: 'skipped_already_approved' },
      { draftId: 'draft-sendable', outcome: 'sent' },
    ]);
  });
});

// This is the exploit from the security review: a single request naming
// the same draftId more than once must never be able to trigger more than
// one real send. Request-level de-duplication (approvalBatchRequestSchema)
// is the primary defense and is covered in route.test.ts; these tests prove
// the deeper, defense-in-depth guarantee that even if a duplicate reaches
// approveDrafts directly, the atomic claim makes a second send for the same
// draftId impossible within one batch.
describe('approveDrafts duplicate draftId within one batch (defense in depth)', () => {
  it('sends at most once for a draftId repeated three times in a single request, no matter what reaches approveDrafts', async () => {
    findManyDraftMock.mockResolvedValue([buildDraftRow({ id: 'draft-1' })]);
    // Models what an atomic `UPDATE ... WHERE approved = false` would do in
    // a real database across three attempts against the same row: only the
    // first succeeds (count 1), every later attempt matches zero rows -
    // this is what makes a second real send for this draftId impossible,
    // regardless of what the request layer does or doesn't de-duplicate.
    updateManyDraftMock
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 0 });

    const results = await approveDrafts([{ draftId: 'draft-1' }, { draftId: 'draft-1' }, { draftId: 'draft-1' }]);

    // The core safety guarantee: three identical requested items, one real
    // send at most.
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(updateManyDraftMock).toHaveBeenCalledTimes(3);
    // Outcomes are keyed by draftId, so every requested item resolves to
    // whichever outcome was recorded last for that shared draftId - never
    // a second `sent`.
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.draftId === 'draft-1')).toBe(true);
    expect(results.some((r) => r.outcome === 'sent')).toBe(false);
    expect(results.every((r) => r.outcome === 'skipped_already_approved')).toBe(true);
  });
});

// Simulates two overlapping/concurrent POST /api/queue/approve requests for
// the same single draftId (double-click before the button disables, a
// network retry, two open tabs). Each "request" is its own call to
// approveDrafts with its own findMany snapshot (both showing approved:
// false, since neither has seen the other's write yet) - the only thing
// that can possibly serialize them is the atomic claim's WHERE clause,
// modeled here via a stateful updateMany mock.
describe('approveDrafts concurrent requests for the same draftId (cross-request race)', () => {
  it('only the first of two concurrent approval calls for the same draftId actually sends; the second is reported skipped_already_approved', async () => {
    findManyDraftMock.mockResolvedValue([buildDraftRow({ id: 'draft-1' })]);
    updateManyDraftMock.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });

    const [firstRequestResults, secondRequestResults] = await Promise.all([
      approveDrafts([{ draftId: 'draft-1' }]),
      approveDrafts([{ draftId: 'draft-1' }]),
    ]);

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const outcomes = [firstRequestResults[0].outcome, secondRequestResults[0].outcome].sort();
    expect(outcomes).toEqual(['sent', 'skipped_already_approved']);
  });

  it('allows a legitimate retry to succeed after a prior send attempt failed and rolled the claim back', async () => {
    findManyDraftMock.mockResolvedValue([buildDraftRow({ id: 'draft-1' })]);
    sendEmailMock.mockResolvedValueOnce({ ok: false, reason: 'network error', definitelyNotSent: true });

    const firstAttempt = await approveDrafts([{ draftId: 'draft-1' }]);
    expect(firstAttempt).toEqual([{ draftId: 'draft-1', outcome: 'failed', reason: 'network error' }]);
    // Rolled back - a second, later approval of the same draft is not
    // permanently blocked by the failed first attempt.
    expect(updateDraftMock).toHaveBeenCalledWith({
      where: { id: 'draft-1' },
      data: { approved: false, lastSendFailure: { reason: 'network error', occurredAt: expect.any(String) } },
    });

    const secondAttempt = await approveDrafts([{ draftId: 'draft-1' }]);
    expect(secondAttempt).toEqual([{ draftId: 'draft-1', outcome: 'sent' }]);
  });
});

describe('approveDrafts doNotContact freshness at claim time', () => {
  it('reports skipped_do_not_contact (not skipped_already_approved) when doNotContact flips true between the initial read and the atomic claim', async () => {
    findManyDraftMock.mockResolvedValue([buildDraftRow({ id: 'draft-1' })]);
    updateManyDraftMock.mockResolvedValue({ count: 0 });
    findUniqueDraftMock.mockResolvedValue({ prospect: { doNotContact: true, tags: [] } });

    const results = await approveDrafts([{ draftId: 'draft-1' }]);

    expect(results).toEqual([{ draftId: 'draft-1', outcome: 'skipped_do_not_contact' }]);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('falls back to skipped_already_approved when the claim fails but doNotContact is still false on re-read, and rolls back the reserved daily-cap slot', async () => {
    findManyDraftMock.mockResolvedValue([buildDraftRow({ id: 'draft-1' })]);
    updateManyDraftMock.mockResolvedValue({ count: 0 });
    findUniqueDraftMock.mockResolvedValue({ prospect: { doNotContact: false, tags: [] } });

    const results = await approveDrafts([{ draftId: 'draft-1' }]);

    expect(results).toEqual([{ draftId: 'draft-1', outcome: 'skipped_already_approved' }]);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(rollBackDailySendSlotMock).toHaveBeenCalledTimes(1);
  });
});

describe('approveDrafts ambiguous send failure (never send twice)', () => {
  it('keeps the draft approved and the cap slot, records the unconfirmed state on the draft and prospect, and never rolls back', async () => {
    sendEmailMock.mockResolvedValue({ ok: false, reason: 'resend responded with 503' });
    findManyDraftMock.mockResolvedValue([buildDraftRow({ id: 'draft-1' })]);

    const results = await approveDrafts([{ draftId: 'draft-1' }]);

    expect(results).toEqual([
      { draftId: 'draft-1', outcome: 'failed', reason: 'send outcome unconfirmed, not retried: resend responded with 503' },
    ]);
    expect(rollBackDailySendSlotMock).not.toHaveBeenCalled();
    expect(updateDraftMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ approved: false }) })
    );
    expect(updateDraftMock).toHaveBeenCalledWith({
      where: { id: 'draft-1' },
      data: { lastSendFailure: { reason: 'resend responded with 503', occurredAt: expect.any(String), unconfirmed: true } },
    });
    expect(updateManyProspectMock).toHaveBeenCalledWith({
      where: { id: 'prospect-1', NOT: { tags: { has: 'send-unconfirmed' } } },
      data: { tags: { push: 'send-unconfirmed' } },
    });
    expect(updateProspectMock).not.toHaveBeenCalled();
  });

  it('does not send again on a later approval of the same draft or of a sibling variant once the prospect is tagged', async () => {
    sendEmailMock.mockResolvedValueOnce({ ok: false, reason: 'timeout' });
    findManyDraftMock.mockResolvedValue([buildDraftRow({ id: 'draft-1' })]);
    await approveDrafts([{ draftId: 'draft-1' }]);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);

    // The persisted state the next request will read back from the database.
    findManyDraftMock.mockResolvedValue([
      buildDraftRow({ id: 'draft-1', approved: true, prospect: { tags: ['send-unconfirmed'] } }),
      buildDraftRow({ id: 'draft-2', prospect: { tags: ['send-unconfirmed'] } }),
    ]);
    const results = await approveDrafts([{ draftId: 'draft-1' }, { draftId: 'draft-2' }]);

    expect(results[0]).toEqual({ draftId: 'draft-1', outcome: 'skipped_already_approved' });
    expect(results[1]).toMatchObject({ draftId: 'draft-2', outcome: 'failed' });
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });

  it('refuses a sibling variant whose prospect was tagged between the read and the claim', async () => {
    findManyDraftMock.mockResolvedValue([buildDraftRow({ id: 'draft-2' })]);
    updateManyDraftMock.mockResolvedValue({ count: 0 });
    findUniqueDraftMock.mockResolvedValue({ prospect: { doNotContact: false, tags: ['send-unconfirmed'] } });

    const results = await approveDrafts([{ draftId: 'draft-2' }]);

    expect(results[0]).toMatchObject({ draftId: 'draft-2', outcome: 'failed' });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('still reports the unconfirmed outcome (and never resends) when recording it fails', async () => {
    sendEmailMock.mockResolvedValue({ ok: false, reason: 'timeout' });
    findManyDraftMock.mockResolvedValue([buildDraftRow({ id: 'draft-1' })]);
    updateDraftMock.mockRejectedValue(new Error('db down'));
    updateManyProspectMock.mockRejectedValue(new Error('db down'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const results = await approveDrafts([{ draftId: 'draft-1' }]);

    expect(results[0]).toMatchObject({ outcome: 'failed' });
    expect(rollBackDailySendSlotMock).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

describe('approveDrafts sibling and stale-tab protection', () => {
  it('refuses a stale tab approving another variant after the prospect was already sent, without reserving a cap slot', async () => {
    findManyDraftMock.mockResolvedValue([
      buildDraftRow({
        id: 'draft-2',
        prospect: { status: 'sent', sentAt: minutesAgo(5), drafts: [siblingDraft({ id: 'draft-1', approved: true })] },
      }),
    ]);

    const results = await approveDrafts([{ draftId: 'draft-2' }]);

    expect(results[0]).toMatchObject({ draftId: 'draft-2', outcome: 'failed' });
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(reserveDailySendSlotMock).not.toHaveBeenCalled();
  });

  it('refuses under the row lock when the prospect was sent between the snapshot and the claim, and gives the cap slot back', async () => {
    findManyDraftMock.mockResolvedValue([buildDraftRow({ id: 'draft-2' })]);
    findUniqueClaimProspectMock.mockResolvedValue(
      claimProspect({ status: 'sent', sentAt: minutesAgo(1), drafts: [siblingDraft({ id: 'draft-1', approved: true })] })
    );

    const results = await approveDrafts([{ draftId: 'draft-2' }]);

    expect(results[0]).toMatchObject({ draftId: 'draft-2', outcome: 'failed' });
    expect(updateManyDraftMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(rollBackDailySendSlotMock).toHaveBeenCalledTimes(1);
  });

  it('refuses a second new variant of a re-drafted prospect when the first new variant is already claimed, even though sentAt is set', async () => {
    const earlierSend = minutesAgo(60 * 24);
    findManyDraftMock.mockResolvedValue([buildDraftRow({ id: 'new-2' })]);
    findUniqueClaimProspectMock.mockResolvedValue(
      claimProspect({
        sentAt: earlierSend,
        drafts: [
          // The pre-redraft draft that really went out: stale, must not block.
          siblingDraft({ id: 'old-1', approved: true, generatedAt: new Date(earlierSend.getTime() - MS_PER_MINUTE) }),
          // The new variant another tab just claimed: generated after sentAt.
          siblingDraft({
            id: 'new-1',
            approved: true,
            generatedAt: minutesAgo(30),
            lastSendFailure: { inFlight: true, startedAt: minutesAgo(1).toISOString() },
          }),
          siblingDraft({ id: 'new-2', approved: false, generatedAt: minutesAgo(30) }),
        ],
      })
    );

    const results = await approveDrafts([{ draftId: 'new-2' }]);

    expect(results[0]).toMatchObject({ draftId: 'new-2', outcome: 'failed', reason: expect.stringContaining('being sent right now') });
    expect(updateManyDraftMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('lets the first new variant of a re-drafted prospect send, because the old approved draft predates the earlier send', async () => {
    const earlierSend = minutesAgo(60 * 24);
    findManyDraftMock.mockResolvedValue([
      buildDraftRow({
        id: 'new-1',
        prospect: {
          sentAt: earlierSend,
          drafts: [siblingDraft({ id: 'old-1', approved: true, generatedAt: new Date(earlierSend.getTime() - MS_PER_MINUTE) })],
        },
      }),
    ]);
    findUniqueClaimProspectMock.mockResolvedValue(
      claimProspect({
        sentAt: earlierSend,
        drafts: [siblingDraft({ id: 'old-1', approved: true, generatedAt: new Date(earlierSend.getTime() - MS_PER_MINUTE) })],
      })
    );

    const results = await approveDrafts([{ draftId: 'new-1' }]);

    expect(results[0]).toEqual({ draftId: 'new-1', outcome: 'sent' });
  });

  it('refuses a sibling variant after a delivered resolution marked the prospect sent', async () => {
    const resolvedAt = minutesAgo(2);
    findManyDraftMock.mockResolvedValue([
      buildDraftRow({
        id: 'draft-2',
        prospect: { status: 'sent', sentAt: resolvedAt, drafts: [siblingDraft({ id: 'draft-1', approved: true })] },
      }),
    ]);

    const results = await approveDrafts([{ draftId: 'draft-2' }]);

    expect(results[0]).toMatchObject({ draftId: 'draft-2', outcome: 'failed' });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('refuses a sibling variant when another variant is approved but never confirmed sent, even though the unconfirmed tag was never written', async () => {
    findManyDraftMock.mockResolvedValue([
      buildDraftRow({
        id: 'draft-2',
        prospect: { drafts: [siblingDraft({ id: 'draft-1', approved: true, lastSendFailure: { reason: 'timeout', occurredAt: minutesAgo(30).toISOString(), unconfirmed: true } })] },
      }),
    ]);

    const results = await approveDrafts([{ draftId: 'draft-2' }]);

    expect(results[0]).toMatchObject({ draftId: 'draft-2', outcome: 'failed', reason: expect.stringContaining('unconfirmed') });
    expect(updateManyDraftMock).not.toHaveBeenCalled();
    expect(reserveDailySendSlotMock).not.toHaveBeenCalled();
  });

  it('reports a sibling whose attempt started moments ago as being sent right now, not as unconfirmed', async () => {
    findManyDraftMock.mockResolvedValue([
      buildDraftRow({
        id: 'draft-2',
        prospect: {
          drafts: [siblingDraft({ id: 'draft-1', approved: true, lastSendFailure: { inFlight: true, startedAt: minutesAgo(1).toISOString() } })],
        },
      }),
    ]);

    const results = await approveDrafts([{ draftId: 'draft-2' }]);

    expect(results[0]).toMatchObject({ outcome: 'failed', reason: expect.stringContaining('being sent right now') });
  });

  it('reports a duplicate request for an already-claimed draft as already approved rather than as a locked sibling', async () => {
    findManyDraftMock.mockResolvedValue([buildDraftRow({ id: 'draft-1' })]);
    findUniqueClaimProspectMock.mockResolvedValue(
      claimProspect({
        drafts: [siblingDraft({ id: 'draft-1', approved: true, lastSendFailure: { inFlight: true, startedAt: minutesAgo(1).toISOString() } })],
      })
    );
    findUniqueDraftMock.mockResolvedValue({ prospect: { doNotContact: false, tags: [] } });

    const results = await approveDrafts([{ draftId: 'draft-1' }]);

    expect(results[0]).toEqual({ draftId: 'draft-1', outcome: 'skipped_already_approved' });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('takes the prospect row lock before reading the siblings and before running the claim (call order)', async () => {
    findManyDraftMock.mockResolvedValue([buildDraftRow({ id: 'draft-1' })]);
    const order: string[] = [];
    queryRawMock.mockImplementation(async () => {
      order.push('lock');
      return [];
    });
    findUniqueClaimProspectMock.mockImplementation(async () => {
      order.push('read');
      return claimProspect();
    });
    updateManyDraftMock.mockImplementation(async () => {
      order.push('claim');
      return { count: 1 };
    });

    await approveDrafts([{ draftId: 'draft-1' }]);

    expect(order).toEqual(['lock', 'read', 'claim']);
  });

  it('gives the cap slot back, reports failed and carries on with the rest of the batch when the claim transaction throws', async () => {
    findManyDraftMock.mockResolvedValue([
      buildDraftRow({ id: 'draft-a', prospectId: 'prospect-a', priorityScore: 9 }),
      buildDraftRow({ id: 'draft-b', prospectId: 'prospect-b', priorityScore: 1 }),
    ]);
    transactionMock.mockRejectedValueOnce(new Error('connection reset'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const results = await approveDrafts([{ draftId: 'draft-a' }, { draftId: 'draft-b' }]);

    expect(results[0]).toMatchObject({ draftId: 'draft-a', outcome: 'failed' });
    expect(results[1]).toEqual({ draftId: 'draft-b', outcome: 'sent' });
    expect(rollBackDailySendSlotMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    consoleSpy.mockRestore();
  });

  it('moves the prospect to sent before clearing the in-flight marker, so a failure in between never leaves a drafted prospect with no marker', async () => {
    findManyDraftMock.mockResolvedValue([buildDraftRow({ id: 'draft-1' })]);

    await approveDrafts([{ draftId: 'draft-1' }]);

    const prospectOrder = updateProspectMock.mock.invocationCallOrder[0];
    const markerClearOrder = updateDraftMock.mock.invocationCallOrder[0];
    expect(prospectOrder).toBeLessThan(markerClearOrder);
  });
});
