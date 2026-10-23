import { beforeEach, describe, expect, it, vi } from 'vitest';

// Orchestration test: domain-verification-gate.ts and daily-send-counter.ts
// each have their own dedicated suites, so both are mocked here - only
// queue-listing.ts's own querying and pickDisplayDraft priority-selection
// logic is under test. pickDisplayDraft itself isn't exported, so its
// priority tiers are exercised indirectly through listApprovalQueue's
// returned `defaultDraftId` field per item.
const { findManyMock } = vi.hoisted(() => ({ findManyMock: vi.fn() }));
vi.mock('@/common/db/client', () => ({ prisma: { prospect: { findMany: findManyMock } } }));

const getEffectiveDailyCapMock = vi.fn();
const isDomainVerifiedMock = vi.fn();
vi.mock('@/features/sending/domain-verification-gate', () => ({
  getEffectiveDailyCap: getEffectiveDailyCapMock,
  isDomainVerified: isDomainVerifiedMock,
}));

const getTodaysSendCountMock = vi.fn();
vi.mock('@/features/sending/daily-send-counter', () => ({ getTodaysSendCount: getTodaysSendCountMock }));

const { listApprovalQueue } = await import('./queue-listing');

interface DraftOverrides {
  id: string;
  variant: number;
  humanizedBody?: string | null;
  lastSendFailure?: unknown;
  approved?: boolean;
  generatedAt?: Date;
}

function buildDraft(overrides: DraftOverrides) {
  return {
    id: overrides.id,
    variant: overrides.variant,
    framework: null,
    subject: 'Subject',
    body: 'Body',
    humanizedBody: overrides.humanizedBody ?? null,
    edited: false,
    approved: overrides.approved ?? false,
    generatedAt: overrides.generatedAt ?? new Date(Date.now() - 60 * 60 * 1000),
    lastSendFailure: overrides.lastSendFailure ?? null,
  };
}

interface ProspectOverrides {
  id?: string;
  activeDraftId?: string | null;
  drafts?: ReturnType<typeof buildDraft>[];
  priorityScore?: number;
  tags?: string[];
  sentAt?: Date | null;
}

function buildProspect(overrides: ProspectOverrides = {}) {
  return {
    id: overrides.id ?? 'prospect-1',
    companyName: 'Acme Inc',
    contactName: 'Jane Doe',
    contactEmail: 'jane@acme.com',
    doNotContact: false,
    priorityScore: overrides.priorityScore ?? 1,
    activeDraftId: overrides.activeDraftId ?? null,
    tags: overrides.tags ?? [],
    sentAt: overrides.sentAt === undefined ? null : overrides.sentAt,
    drafts: overrides.drafts ?? [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getEffectiveDailyCapMock.mockReturnValue(3);
  isDomainVerifiedMock.mockReturnValue(false);
  getTodaysSendCountMock.mockResolvedValue(0);
});

describe('listApprovalQueue draft selection priority', () => {
  it('picks the activeDraftId draft even when a different variant has a humanizedBody', async () => {
    findManyMock.mockResolvedValue([
      buildProspect({
        activeDraftId: 'draft-2',
        drafts: [
          buildDraft({ id: 'draft-1', variant: 1, humanizedBody: 'humanized text' }),
          buildDraft({ id: 'draft-2', variant: 2, humanizedBody: null }),
        ],
      }),
    ]);

    const { items } = await listApprovalQueue();

    expect(items[0].defaultDraftId).toBe('draft-2');
  });

  it('falls back to whichever variant has a humanizedBody when activeDraftId is unset', async () => {
    findManyMock.mockResolvedValue([
      buildProspect({
        activeDraftId: null,
        drafts: [
          buildDraft({ id: 'draft-1', variant: 1, humanizedBody: null }),
          buildDraft({ id: 'draft-2', variant: 2, humanizedBody: 'humanized text' }),
        ],
      }),
    ]);

    const { items } = await listApprovalQueue();

    expect(items[0].defaultDraftId).toBe('draft-2');
  });

  it('falls back to variant 1 when no draft has a humanizedBody and activeDraftId is unset', async () => {
    findManyMock.mockResolvedValue([
      buildProspect({
        activeDraftId: null,
        drafts: [
          buildDraft({ id: 'draft-2', variant: 2 }),
          buildDraft({ id: 'draft-1', variant: 1 }),
        ],
      }),
    ]);

    const { items } = await listApprovalQueue();

    expect(items[0].defaultDraftId).toBe('draft-1');
  });

  it('falls back to the lowest-numbered variant when there is no variant 1 and none is humanized', async () => {
    findManyMock.mockResolvedValue([
      buildProspect({
        activeDraftId: null,
        drafts: [
          buildDraft({ id: 'draft-3', variant: 3 }),
          buildDraft({ id: 'draft-2', variant: 2 }),
        ],
      }),
    ]);

    const { items } = await listApprovalQueue();

    expect(items[0].defaultDraftId).toBe('draft-2');
  });

  it('falls through to the next tier when activeDraftId does not match any of this prospect\'s own drafts', async () => {
    findManyMock.mockResolvedValue([
      buildProspect({
        activeDraftId: 'stale-id-from-a-different-prospect',
        drafts: [buildDraft({ id: 'draft-1', variant: 1, humanizedBody: 'humanized text' })],
      }),
    ]);

    const { items } = await listApprovalQueue();

    expect(items[0].defaultDraftId).toBe('draft-1');
  });

  it('yields an empty drafts array and a null defaultDraftId when a drafted-status prospect has zero draft rows', async () => {
    findManyMock.mockResolvedValue([buildProspect({ drafts: [] })]);

    const { items } = await listApprovalQueue();

    expect(items[0].drafts).toEqual([]);
    expect(items[0].defaultDraftId).toBeNull();
  });
});

describe('listApprovalQueue drafts array', () => {
  it('surfaces every draft variant for a prospect, sorted by variant ascending', async () => {
    findManyMock.mockResolvedValue([
      buildProspect({
        drafts: [
          buildDraft({ id: 'draft-3', variant: 3 }),
          buildDraft({ id: 'draft-1', variant: 1 }),
          buildDraft({ id: 'draft-2', variant: 2 }),
        ],
      }),
    ]);

    const { items } = await listApprovalQueue();

    expect(items[0].drafts.map((draft) => draft.id)).toEqual(['draft-1', 'draft-2', 'draft-3']);
  });
});

describe('listApprovalQueue hasSendFailure', () => {
  it('reports hasSendFailure true when the draft has a non-null lastSendFailure', async () => {
    findManyMock.mockResolvedValue([
      buildProspect({
        drafts: [buildDraft({ id: 'draft-1', variant: 1, lastSendFailure: { reason: 'oops', occurredAt: 'now' } })],
      }),
    ]);

    const { items } = await listApprovalQueue();

    expect(items[0].drafts[0].hasSendFailure).toBe(true);
  });

  it('reports hasSendFailure false when the draft has no lastSendFailure on file', async () => {
    findManyMock.mockResolvedValue([buildProspect({ drafts: [buildDraft({ id: 'draft-1', variant: 1 })] })]);

    const { items } = await listApprovalQueue();

    expect(items[0].drafts[0].hasSendFailure).toBe(false);
  });
});

describe('listApprovalQueue querying', () => {
  it('queries only drafted-status prospects ordered by priorityScore descending', async () => {
    findManyMock.mockResolvedValue([]);

    await listApprovalQueue();

    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: 'drafted' }, orderBy: { priorityScore: 'desc' } })
    );
  });
});

describe('listApprovalQueue capStatus', () => {
  it('surfaces domainVerified, effectiveDailyCap, and sentToday from their single sources of truth', async () => {
    findManyMock.mockResolvedValue([]);
    isDomainVerifiedMock.mockReturnValue(true);
    getEffectiveDailyCapMock.mockReturnValue(25);
    getTodaysSendCountMock.mockResolvedValue(7);

    const { capStatus } = await listApprovalQueue();

    expect(capStatus).toEqual({ domainVerified: true, effectiveDailyCap: 25, sentToday: 7 });
  });
});

describe('listApprovalQueue unconfirmed sends', () => {
  it('flags a prospect tagged send-unconfirmed and a draft whose failure is unconfirmed, but not a definite failure', async () => {
    findManyMock.mockResolvedValue([
      buildProspect({
        tags: ['send-unconfirmed'],
        drafts: [
          buildDraft({ id: 'draft-1', variant: 1, lastSendFailure: { reason: 'timeout', occurredAt: 'x', unconfirmed: true } }),
          buildDraft({ id: 'draft-2', variant: 2, lastSendFailure: { reason: '422', occurredAt: 'x' } }),
          buildDraft({ id: 'draft-3', variant: 3 }),
        ],
      }),
    ]);

    const { items } = await listApprovalQueue();

    expect(items[0].sendUnconfirmed).toBe(true);
    expect(items[0].drafts.map((draft) => draft.sendUnconfirmed)).toEqual([true, false, false]);
    expect(items[0].drafts.map((draft) => draft.hasSendFailure)).toEqual([true, true, false]);
  });

  it('shows the locked state for a prospect with an approved draft and no tag, since the tag write may have failed', async () => {
    findManyMock.mockResolvedValue([
      buildProspect({
        tags: [],
        drafts: [buildDraft({ id: 'draft-1', variant: 1, approved: true }), buildDraft({ id: 'draft-2', variant: 2 })],
      }),
    ]);

    const { items } = await listApprovalQueue();

    expect(items[0].sendUnconfirmed).toBe(true);
    expect(items[0].sendInFlight).toBe(false);
  });

  it('shows a send claimed moments ago as sending, not as unconfirmed, so it cannot be resolved yet', async () => {
    findManyMock.mockResolvedValue([
      buildProspect({
        tags: [],
        drafts: [
          buildDraft({
            id: 'draft-1',
            variant: 1,
            approved: true,
            lastSendFailure: { inFlight: true, startedAt: new Date(Date.now() - 30 * 1000).toISOString() },
          }),
          buildDraft({ id: 'draft-2', variant: 2 }),
        ],
      }),
    ]);

    const { items } = await listApprovalQueue();

    expect(items[0].sendInFlight).toBe(true);
    expect(items[0].sendUnconfirmed).toBe(false);
    expect(items[0].drafts.map((draft) => draft.hasSendFailure)).toEqual([false, false]);
  });

  it('does not lock a re-drafted prospect that already has a recorded send', async () => {
    findManyMock.mockResolvedValue([
      buildProspect({
        tags: [],
        sentAt: new Date('2026-01-01T00:00:00.000Z'),
        drafts: [
          buildDraft({ id: 'draft-1', variant: 1, approved: true, generatedAt: new Date('2025-12-31T00:00:00.000Z') }),
          buildDraft({ id: 'draft-2', variant: 2 }),
        ],
      }),
    ]);

    const { items } = await listApprovalQueue();

    expect(items[0].sendUnconfirmed).toBe(false);
  });
});
