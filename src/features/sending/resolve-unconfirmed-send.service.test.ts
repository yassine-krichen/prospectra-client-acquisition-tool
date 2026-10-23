import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Prisma } from '@/lib/generated/prisma/client';

// Orchestration test for resolving an unconfirmed send. `$transaction` is
// modeled as invoking the callback with a mocked tx; `txState.aborted` records
// that the callback threw, which is what makes the real client roll back.
const { findUniqueMock, updateManyProspectMock, updateDraftMock, updateManyDraftMock, queryRawMock, txState } = vi.hoisted(() => ({
  findUniqueMock: vi.fn(),
  updateManyProspectMock: vi.fn(),
  updateDraftMock: vi.fn(),
  updateManyDraftMock: vi.fn(),
  queryRawMock: vi.fn(),
  txState: { aborted: false },
}));

vi.mock('@/common/db/client', () => ({
  prisma: {
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
      try {
        return await callback({
          $queryRaw: queryRawMock,
          prospect: { findUnique: findUniqueMock, updateMany: updateManyProspectMock },
          draft: { update: updateDraftMock, updateMany: updateManyDraftMock },
        });
      } catch (error) {
        txState.aborted = true;
        throw error;
      }
    },
  },
}));

// The cap counter must never be touched by a resolve (see the not-delivered
// comment in the service); mocking it lets a test assert exactly that.
const { rollBackDailySendSlotMock } = vi.hoisted(() => ({ rollBackDailySendSlotMock: vi.fn() }));
vi.mock('@/features/sending/daily-send-counter', () => ({
  reserveDailySendSlot: vi.fn(),
  rollBackDailySendSlot: rollBackDailySendSlotMock,
}));

const { resolveUnconfirmedSend } = await import('./resolve-unconfirmed-send.service');

const OCCURRED_AT = '2026-03-01T10:00:00.000Z';

interface ProspectOverrides {
  status?: string;
  sentAt?: Date | null;
  tags?: string[];
  statusHistory?: unknown;
  followupCount?: number;
  drafts?: Array<{ id: string; approved: boolean; generatedAt: Date; lastSendFailure: unknown }>;
}

function buildProspect(overrides: ProspectOverrides = {}) {
  return {
    id: 'prospect-1',
    status: overrides.status ?? 'drafted',
    sentAt: overrides.sentAt === undefined ? null : overrides.sentAt,
    tags: overrides.tags ?? [],
    statusHistory: overrides.statusHistory ?? [{ status: 'drafted', timestamp: '2026-01-01T00:00:00.000Z' }],
    followupCount: overrides.followupCount ?? 0,
    drafts: overrides.drafts ?? [],
  };
}

const GENERATED_AT = new Date('2026-02-01T00:00:00.000Z');

const UNCONFIRMED_DRAFT = {
  id: 'draft-2',
  approved: true,
  generatedAt: GENERATED_AT,
  lastSendFailure: { reason: 'timeout', occurredAt: OCCURRED_AT, unconfirmed: true },
};
const SIBLING_DRAFT = { id: 'draft-1', approved: false, generatedAt: GENERATED_AT, lastSendFailure: null };

function firstTouchProspect(extra: ProspectOverrides = {}) {
  return buildProspect({ tags: ['send-unconfirmed'], drafts: [SIBLING_DRAFT, UNCONFIRMED_DRAFT], ...extra });
}

beforeEach(() => {
  vi.clearAllMocks();
  txState.aborted = false;
  queryRawMock.mockResolvedValue([]);
  findUniqueMock.mockResolvedValue(null);
  updateManyProspectMock.mockResolvedValue({ count: 1 });
  updateDraftMock.mockResolvedValue({});
  updateManyDraftMock.mockResolvedValue({ count: 1 });
});

describe('resolveUnconfirmedSend first touch', () => {
  it('returns not_found for an unknown prospect', async () => {
    const result = await resolveUnconfirmedSend('missing', 'delivered');

    expect(result).toEqual({ outcome: 'not_found' });
  });

  it('marks the prospect sent at the original failure time, clears the tag, sets activeDraftId and clears lastSendFailure when it was delivered', async () => {
    findUniqueMock.mockResolvedValue(firstTouchProspect({ tags: ['send-unconfirmed', 'keep-me'] }));

    const result = await resolveUnconfirmedSend('prospect-1', 'delivered');

    expect(result).toEqual({ outcome: 'resolved' });
    expect(updateManyProspectMock).toHaveBeenCalledWith({
      where: { id: 'prospect-1', status: 'drafted', sentAt: null },
      data: {
        status: 'sent',
        sentAt: new Date(OCCURRED_AT),
        activeDraftId: 'draft-2',
        statusHistory: [
          { status: 'drafted', timestamp: '2026-01-01T00:00:00.000Z' },
          { status: 'sent', timestamp: OCCURRED_AT },
        ],
        tags: { set: ['keep-me'] },
      },
    });
    expect(updateDraftMock).toHaveBeenCalledWith({
      where: { id: 'draft-2' },
      data: { lastSendFailure: Prisma.DbNull },
    });
  });

  it('falls back to now for sentAt when the failure carries no usable time', async () => {
    findUniqueMock.mockResolvedValue(
      firstTouchProspect({ drafts: [{ id: 'draft-2', approved: true, generatedAt: GENERATED_AT, lastSendFailure: null }] })
    );
    const before = Date.now();

    await resolveUnconfirmedSend('prospect-1', 'delivered');

    const sentAt = updateManyProspectMock.mock.calls[0]?.[0].data.sentAt as Date;
    expect(sentAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('unapproves the draft, keeps the status drafted and clears the tag when it was not delivered', async () => {
    findUniqueMock.mockResolvedValue(firstTouchProspect());

    const result = await resolveUnconfirmedSend('prospect-1', 'not_delivered');

    expect(result).toEqual({ outcome: 'resolved' });
    const prospectData = updateManyProspectMock.mock.calls[0]?.[0].data;
    expect(prospectData).toEqual({ tags: { set: [] } });
    expect(updateManyDraftMock).toHaveBeenCalledWith({
      where: { id: { in: ['draft-2'] } },
      data: { approved: false, lastSendFailure: Prisma.DbNull },
    });
  });

  it('does not roll back the daily cap slot when it was not delivered', async () => {
    findUniqueMock.mockResolvedValue(firstTouchProspect());

    await resolveUnconfirmedSend('prospect-1', 'not_delivered');

    expect(rollBackDailySendSlotMock).not.toHaveBeenCalled();
  });

  it('is a no-op when resolved a second time', async () => {
    findUniqueMock.mockResolvedValueOnce(firstTouchProspect());
    await resolveUnconfirmedSend('prospect-1', 'not_delivered');
    vi.clearAllMocks();

    // The state the second request reads back: tag gone, nothing approved.
    findUniqueMock.mockResolvedValue(buildProspect({ drafts: [SIBLING_DRAFT, { ...UNCONFIRMED_DRAFT, approved: false }] }));
    const result = await resolveUnconfirmedSend('prospect-1', 'not_delivered');

    expect(result).toEqual({ outcome: 'nothing_to_resolve' });
    expect(updateManyProspectMock).not.toHaveBeenCalled();
    expect(updateManyDraftMock).not.toHaveBeenCalled();
  });

  it('aborts the whole transaction without touching any draft when the guarded prospect update matches zero rows', async () => {
    findUniqueMock.mockResolvedValue(firstTouchProspect());
    updateManyProspectMock.mockResolvedValue({ count: 0 });

    const result = await resolveUnconfirmedSend('prospect-1', 'delivered');

    expect(result).toEqual({ outcome: 'nothing_to_resolve' });
    expect(txState.aborted).toBe(true);
    expect(updateDraftMock).not.toHaveBeenCalled();
    expect(updateManyDraftMock).not.toHaveBeenCalled();
  });

  it('resolves a prospect locked only by an approved draft, with no tag', async () => {
    findUniqueMock.mockResolvedValue(buildProspect({ tags: [], drafts: [SIBLING_DRAFT, UNCONFIRMED_DRAFT] }));

    const result = await resolveUnconfirmedSend('prospect-1', 'not_delivered');

    expect(result).toEqual({ outcome: 'resolved' });
    expect(updateManyDraftMock).toHaveBeenCalledTimes(1);
  });

  it('refuses to resolve while the send is still in flight, and writes nothing', async () => {
    const running = {
      id: 'draft-2',
      approved: true,
      generatedAt: GENERATED_AT,
      lastSendFailure: { inFlight: true, startedAt: new Date(Date.now() - 30 * 1000).toISOString() },
    };
    findUniqueMock.mockResolvedValue(buildProspect({ tags: [], drafts: [SIBLING_DRAFT, running] }));

    const result = await resolveUnconfirmedSend('prospect-1', 'not_delivered');

    expect(result).toEqual({ outcome: 'send_in_progress' });
    expect(updateManyProspectMock).not.toHaveBeenCalled();
    expect(updateManyDraftMock).not.toHaveBeenCalled();
  });

  it('resolves an abandoned in-flight attempt once it is older than the in-flight window, using its start time as sentAt when delivered', async () => {
    const startedAt = new Date(Date.now() - 60 * 60 * 1000);
    const abandoned = {
      id: 'draft-2',
      approved: true,
      generatedAt: GENERATED_AT,
      lastSendFailure: { inFlight: true, startedAt: startedAt.toISOString() },
    };
    findUniqueMock.mockResolvedValue(buildProspect({ tags: [], drafts: [SIBLING_DRAFT, abandoned] }));

    const result = await resolveUnconfirmedSend('prospect-1', 'delivered');

    expect(result).toEqual({ outcome: 'resolved' });
    expect(updateManyProspectMock.mock.calls[0]?.[0].data.sentAt).toEqual(startedAt);
  });

  it('takes the prospect row lock before reading it', async () => {
    const order: string[] = [];
    queryRawMock.mockImplementation(async () => {
      order.push('lock');
      return [];
    });
    findUniqueMock.mockImplementation(async () => {
      order.push('read');
      return firstTouchProspect();
    });

    await resolveUnconfirmedSend('prospect-1', 'delivered');

    expect(order).toEqual(['lock', 'read']);
  });

  it('only unapproves the live claim, leaving an older approved draft from before a re-draft alone', async () => {
    const sentAt = new Date('2026-01-10T00:00:00.000Z');
    const oldSent = { id: 'old-1', approved: true, generatedAt: new Date('2026-01-09T00:00:00.000Z'), lastSendFailure: null };
    const newClaim = { ...UNCONFIRMED_DRAFT, id: 'new-1', generatedAt: new Date('2026-01-20T00:00:00.000Z') };
    findUniqueMock.mockResolvedValue(
      buildProspect({ tags: ['send-unconfirmed'], sentAt, drafts: [oldSent, newClaim] })
    );

    const result = await resolveUnconfirmedSend('prospect-1', 'not_delivered');

    expect(result).toEqual({ outcome: 'resolved' });
    expect(updateManyDraftMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['new-1'] } } })
    );
  });

  it('clears a stale send-unconfirmed tag as tag_cleared_only when the prospect has already moved past drafted', async () => {
    findUniqueMock.mockResolvedValue(buildProspect({ status: 'replied', tags: ['send-unconfirmed'], drafts: [UNCONFIRMED_DRAFT] }));

    const result = await resolveUnconfirmedSend('prospect-1', 'not_delivered');

    expect(result).toEqual({ outcome: 'tag_cleared_only' });
    expect(updateManyProspectMock).toHaveBeenCalledWith({
      where: { id: 'prospect-1', tags: { has: 'send-unconfirmed' } },
      data: { tags: { set: [] } },
    });
    expect(updateManyDraftMock).not.toHaveBeenCalled();
  });

  it('still resolves the follow-up tag in the same call when the first-touch tag was only stale', async () => {
    findUniqueMock.mockResolvedValue(
      buildProspect({
        status: 'followup_1',
        followupCount: 1,
        tags: ['send-unconfirmed', 'followup-send-unconfirmed'],
        statusHistory: [
          { status: 'sent', timestamp: '2026-02-01T00:00:00.000Z' },
          { status: 'followup_1', timestamp: '2026-02-05T00:00:00.000Z' },
        ],
      })
    );

    const result = await resolveUnconfirmedSend('prospect-1', 'not_delivered');

    expect(result).toEqual({ outcome: 'resolved' });
    expect(updateManyProspectMock).toHaveBeenCalledTimes(2);
    expect(updateManyProspectMock.mock.calls[1]?.[0].data).toMatchObject({ status: 'sent', tags: { set: [] } });
  });

  it('resolves the first-touch tag first when both tags are present', async () => {
    findUniqueMock.mockResolvedValue(firstTouchProspect({ tags: ['send-unconfirmed', 'followup-send-unconfirmed'] }));

    await resolveUnconfirmedSend('prospect-1', 'delivered');

    expect(updateManyProspectMock.mock.calls[0]?.[0].data).toMatchObject({
      status: 'sent',
      tags: { set: ['followup-send-unconfirmed'] },
    });
  });
});

describe('resolveUnconfirmedSend follow-up', () => {
  const followupProspect = (extra: ProspectOverrides = {}) =>
    buildProspect({
      status: 'followup_1',
      sentAt: new Date('2026-02-01T00:00:00.000Z'),
      tags: ['followup-send-unconfirmed'],
      followupCount: 1,
      statusHistory: [
        { status: 'sent', timestamp: '2026-02-01T00:00:00.000Z' },
        { status: 'followup_1', timestamp: '2026-02-05T00:00:00.000Z' },
      ],
      ...extra,
    });

  it('keeps the status followup_1 and only clears the tag when the follow-up was delivered', async () => {
    findUniqueMock.mockResolvedValue(followupProspect());

    const result = await resolveUnconfirmedSend('prospect-1', 'delivered');

    expect(result).toEqual({ outcome: 'resolved' });
    expect(updateManyProspectMock).toHaveBeenCalledWith({
      where: { id: 'prospect-1', tags: { has: 'followup-send-unconfirmed' } },
      data: { tags: { set: [] } },
    });
  });

  it('reverts to sent with fixed counters and history when the follow-up was not delivered', async () => {
    findUniqueMock.mockResolvedValue(followupProspect());

    const result = await resolveUnconfirmedSend('prospect-1', 'not_delivered');

    expect(result).toEqual({ outcome: 'resolved' });
    expect(updateManyProspectMock).toHaveBeenCalledWith({
      where: {
        id: 'prospect-1',
        status: 'followup_1',
        followupCount: 1,
        tags: { has: 'followup-send-unconfirmed' },
      },
      data: {
        status: 'sent',
        lastFollowupAt: null,
        followupCount: 0,
        statusHistory: [{ status: 'sent', timestamp: '2026-02-01T00:00:00.000Z' }],
        tags: { set: [] },
      },
    });
  });

  it.each(['replied', 'dead'])(
    'only clears the tag, without reverting, when a not-delivered follow-up prospect has since become %s',
    async (status) => {
      findUniqueMock.mockResolvedValue(followupProspect({ status }));

      const result = await resolveUnconfirmedSend('prospect-1', 'not_delivered');

      expect(result).toEqual({ outcome: 'tag_cleared_only' });
      expect(updateManyProspectMock).toHaveBeenCalledWith({
        where: { id: 'prospect-1', tags: { has: 'followup-send-unconfirmed' } },
        data: { tags: { set: [] } },
      });
    }
  );
});
