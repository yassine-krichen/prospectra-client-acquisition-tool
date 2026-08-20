import { beforeEach, describe, expect, it, vi } from 'vitest';

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
const { findManyDraftMock, updateDraftMock, updateManyDraftMock, findUniqueDraftMock, updateProspectMock } =
  vi.hoisted(() => ({
    findManyDraftMock: vi.fn(),
    updateDraftMock: vi.fn(),
    updateManyDraftMock: vi.fn(),
    findUniqueDraftMock: vi.fn(),
    updateProspectMock: vi.fn(),
  }));

vi.mock('@/common/db/client', () => ({
  prisma: {
    draft: {
      findMany: findManyDraftMock,
      update: updateDraftMock,
      updateMany: updateManyDraftMock,
      findUnique: findUniqueDraftMock,
    },
    prospect: { update: updateProspectMock },
  },
}));

const getEffectiveDailyCapMock = vi.fn();
vi.mock('@/features/sending/domain-verification-gate', () => ({
  getEffectiveDailyCap: getEffectiveDailyCapMock,
}));

const getTodaysSendCountMock = vi.fn();
vi.mock('@/features/sending/daily-send-counter', () => ({ getTodaysSendCount: getTodaysSendCountMock }));

const sendEmailMock = vi.fn();
vi.mock('@/features/sending/resend.client', () => ({ sendEmail: sendEmailMock }));

const { approveDrafts } = await import('./send-queue.service');

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
  updateProspectMock.mockResolvedValue({});
  getEffectiveDailyCapMock.mockReturnValue(10);
  getTodaysSendCountMock.mockResolvedValue(0);
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
    getTodaysSendCountMock.mockResolvedValue(0);
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
  it('re-reads the daily send count before every individual send: a batch of 3 with 1 slot of cap headroom sends exactly 1 and skips the rest as skipped_cap', async () => {
    const CAP = 3;
    let sentSoFar = CAP - 1; // 2 already sent today, 1 slot of headroom left
    getEffectiveDailyCapMock.mockReturnValue(CAP);
    getTodaysSendCountMock.mockImplementation(async () => sentSoFar);
    sendEmailMock.mockImplementation(async () => {
      sentSoFar += 1; // reflects the send that just "happened"
      return { ok: true, id: 'resend-message-id' };
    });

    findManyDraftMock.mockResolvedValue([
      buildDraftRow({ id: 'draft-a', priorityScore: 3 }),
      buildDraftRow({ id: 'draft-b', priorityScore: 2 }),
      buildDraftRow({ id: 'draft-c', priorityScore: 1 }),
    ]);

    const results = await approveDrafts([{ draftId: 'draft-a' }, { draftId: 'draft-b' }, { draftId: 'draft-c' }]);

    // A "computed once at batch start" regression would see sentSoFar=2 < 3
    // for every iteration (since it would never re-read the count after a
    // send) and would send all 3 instead of 1 - this assertion on the exact
    // call count is what would catch that regression.
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(results).toEqual([
      { draftId: 'draft-a', outcome: 'sent' },
      { draftId: 'draft-b', outcome: 'skipped_cap' },
      { draftId: 'draft-c', outcome: 'skipped_cap' },
    ]);
  });

  it('continues reporting every remaining item as skipped_cap once the cap is hit, rather than stopping the batch silently', async () => {
    getEffectiveDailyCapMock.mockReturnValue(0);
    getTodaysSendCountMock.mockResolvedValue(0);
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
    let sentSoFar = 0;
    getEffectiveDailyCapMock.mockReturnValue(CAP);
    getTodaysSendCountMock.mockImplementation(async () => sentSoFar);
    sendEmailMock.mockImplementation(async () => {
      sentSoFar += 1;
      return { ok: true, id: 'resend-message-id' };
    });

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
  it('reports failed without ever calling sendEmail when the prospect has no contact email on file', async () => {
    findManyDraftMock.mockResolvedValue([buildDraftRow({ id: 'draft-1', prospect: { contactEmail: null } })]);

    const results = await approveDrafts([{ draftId: 'draft-1' }]);

    expect(results).toEqual([
      { draftId: 'draft-1', outcome: 'failed', reason: 'prospect has no contact email on file' },
    ]);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});

describe('approveDrafts send outcome persistence - the core safety boundary', () => {
  it('claims the draft (approved:true) before sending, then rolls the claim back to approved:false when the send fails - never leaving Prospect.status/sentAt set', async () => {
    sendEmailMock.mockResolvedValue({ ok: false, reason: 'resend responded with 422' });
    findManyDraftMock.mockResolvedValue([buildDraftRow({ id: 'draft-1' })]);

    const results = await approveDrafts([{ draftId: 'draft-1' }]);

    expect(results).toEqual([{ draftId: 'draft-1', outcome: 'failed', reason: 'resend responded with 422' }]);
    // The claim is attempted (that's what makes concurrent double-sends
    // impossible), but since the send failed it must be rolled back so a
    // later legitimate retry can re-approve this draft.
    expect(updateManyDraftMock).toHaveBeenCalledWith({
      where: { id: 'draft-1', approved: false, prospect: { doNotContact: false } },
      data: { approved: true },
    });
    expect(updateDraftMock).toHaveBeenCalledWith({ where: { id: 'draft-1' }, data: { approved: false } });
    expect(updateProspectMock).not.toHaveBeenCalled();
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
      where: { id: 'draft-1', approved: false, prospect: { doNotContact: false } },
      data: { approved: true },
    });
    // The rollback path (draft.update) must never fire on a successful send.
    expect(updateDraftMock).not.toHaveBeenCalled();

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
      where: { id: 'draft-1', approved: false, prospect: { doNotContact: false } },
      data: { approved: true, body: 'human-edited body', edited: true },
    });
    expect(sendEmailMock).toHaveBeenCalledWith(expect.objectContaining({ body: 'human-edited body' }));
  });

  it('keeps the editedBody applied to Draft.body even when the subsequent send attempt fails - only approved is rolled back', async () => {
    sendEmailMock.mockResolvedValue({ ok: false, reason: 'network error' });
    findManyDraftMock.mockResolvedValue([buildDraftRow({ id: 'draft-1' })]);

    const results = await approveDrafts([{ draftId: 'draft-1', editedBody: 'edited body' }]);

    expect(results).toEqual([{ draftId: 'draft-1', outcome: 'failed', reason: 'network error' }]);
    expect(updateManyDraftMock).toHaveBeenCalledWith({
      where: { id: 'draft-1', approved: false, prospect: { doNotContact: false } },
      data: { approved: true, body: 'edited body', edited: true },
    });
    // The rollback only resets `approved` - it must not also revert the
    // body edit, or a human's edit would be silently lost on a failed send.
    expect(updateDraftMock).toHaveBeenCalledWith({ where: { id: 'draft-1' }, data: { approved: false } });
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
    getTodaysSendCountMock.mockResolvedValue(0);
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
    sendEmailMock.mockResolvedValueOnce({ ok: false, reason: 'network error' });

    const firstAttempt = await approveDrafts([{ draftId: 'draft-1' }]);
    expect(firstAttempt).toEqual([{ draftId: 'draft-1', outcome: 'failed', reason: 'network error' }]);
    // Rolled back - a second, later approval of the same draft is not
    // permanently blocked by the failed first attempt.
    expect(updateDraftMock).toHaveBeenCalledWith({ where: { id: 'draft-1' }, data: { approved: false } });

    const secondAttempt = await approveDrafts([{ draftId: 'draft-1' }]);
    expect(secondAttempt).toEqual([{ draftId: 'draft-1', outcome: 'sent' }]);
  });
});

describe('approveDrafts doNotContact freshness at claim time', () => {
  it('reports skipped_do_not_contact (not skipped_already_approved) when doNotContact flips true between the initial read and the atomic claim', async () => {
    findManyDraftMock.mockResolvedValue([buildDraftRow({ id: 'draft-1' })]);
    updateManyDraftMock.mockResolvedValue({ count: 0 });
    findUniqueDraftMock.mockResolvedValue({ prospect: { doNotContact: true } });

    const results = await approveDrafts([{ draftId: 'draft-1' }]);

    expect(results).toEqual([{ draftId: 'draft-1', outcome: 'skipped_do_not_contact' }]);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('falls back to skipped_already_approved when the claim fails but doNotContact is still false on re-read', async () => {
    findManyDraftMock.mockResolvedValue([buildDraftRow({ id: 'draft-1' })]);
    updateManyDraftMock.mockResolvedValue({ count: 0 });
    findUniqueDraftMock.mockResolvedValue({ prospect: { doNotContact: false } });

    const results = await approveDrafts([{ draftId: 'draft-1' }]);

    expect(results).toEqual([{ draftId: 'draft-1', outcome: 'skipped_already_approved' }]);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});
