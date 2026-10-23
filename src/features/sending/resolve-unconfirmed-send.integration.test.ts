import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { assertDestructiveTestsAllowed } from '@/common/testing/require-destructive-test-guard';
import { prisma } from '@/common/testing/test-db-client';
import type { SendEmailResult } from '@/features/sending/sending.types';

// Redirects every layer of the code under test (not just this file's direct
// calls) to the isolated test database - see require-destructive-test-guard.ts.
vi.mock('@/common/db/client', async () => {
  const { prisma } = await import('@/common/testing/test-db-client');
  return { prisma };
});

const sendEmailMock = vi.fn();
vi.mock('@/features/sending/resend.client', () => ({ sendEmail: sendEmailMock }));

const { approveDrafts } = await import('./send-queue.service');
const { resolveUnconfirmedSend } = await import('./resolve-unconfirmed-send.service');

// Real-Postgres check of the full unconfirmed-send loop, which the mocked
// service tests can only model: an ambiguous send locks the prospect, a
// "not delivered" resolution unlocks it, and the next approval sends exactly
// once. Real because it depends on the transactional row lock and on Postgres
// evaluating the claim's sibling condition.
beforeAll(() => {
  assertDestructiveTestsAllowed('resolve-unconfirmed-send.integration.test.ts');
});

beforeEach(async () => {
  vi.clearAllMocks();
  await prisma.prospect.deleteMany();
  await prisma.dailySendCounter.deleteMany();
});

afterAll(async () => {
  await prisma.prospect.deleteMany();
  await prisma.dailySendCounter.deleteMany();
  await prisma.$disconnect();
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function seedDraftedProspect(): Promise<{ prospectId: string; draftIds: [string, string] }> {
  const domain = `${randomUUID()}.example.com`;
  const prospect = await prisma.prospect.create({
    data: {
      companyName: `Test Co ${randomUUID()}`,
      domain,
      websiteUrl: `https://${domain}`,
      industry: 'local_service',
      location: { city: 'Austin', country: 'US', lat: null, lng: null },
      companySize: 'unknown',
      contactEmail: 'contact@example.com',
      emailConfidence: 0,
      source: 'google_places',
      sourceUrl: 'https://example.com/source',
      discoveredAt: new Date('2026-01-01T00:00:00.000Z'),
      signal: { type: 'no_https', description: 'test fixture', evidence: null, strength: 'medium' },
      projectFit: 'unclear',
      estimatedBudget: 'unknown',
      priorityScore: 1,
      status: 'drafted',
    },
  });

  const [first, second] = await Promise.all(
    [1, 2].map((variant) =>
      prisma.draft.create({
        data: { prospectId: prospect.id, variant, subject: `Subject ${variant}`, body: `Body ${variant}`, modelUsed: 'gemini' },
      })
    )
  );
  if (!first || !second) throw new Error('failed to seed drafts');
  return { prospectId: prospect.id, draftIds: [first.id, second.id] };
}

describe('unconfirmed send, then resolve, then approve (real database)', () => {
  it('lets the prospect be sent exactly once after an ambiguous send is resolved as not delivered', async () => {
    const { prospectId, draftIds } = await seedDraftedProspect();
    const [firstDraftId, secondDraftId] = draftIds;

    sendEmailMock.mockResolvedValueOnce({ ok: false, reason: 'timeout' });
    const ambiguous = await approveDrafts([{ draftId: firstDraftId }]);
    expect(ambiguous[0]).toMatchObject({ outcome: 'failed' });

    // Locked: a sibling variant is refused and nothing more is sent.
    const refused = await approveDrafts([{ draftId: secondDraftId }]);
    expect(refused[0]).toMatchObject({ outcome: 'failed' });
    expect(sendEmailMock).toHaveBeenCalledTimes(1);

    const resolved = await resolveUnconfirmedSend(prospectId, 'not_delivered');
    expect(resolved).toEqual({ outcome: 'resolved' });

    const unlocked = await prisma.prospect.findUniqueOrThrow({
      where: { id: prospectId },
      select: { status: true, tags: true, sentAt: true, drafts: { select: { approved: true, lastSendFailure: true } } },
    });
    expect(unlocked.status).toBe('drafted');
    expect(unlocked.tags).toEqual([]);
    expect(unlocked.sentAt).toBeNull();
    expect(unlocked.drafts.every((draft) => !draft.approved && draft.lastSendFailure === null)).toBe(true);

    sendEmailMock.mockResolvedValueOnce({ ok: true, id: 'resend-message-id' });
    const sent = await approveDrafts([{ draftId: firstDraftId }]);
    expect(sent[0]).toEqual({ draftId: firstDraftId, outcome: 'sent' });
    expect(sendEmailMock).toHaveBeenCalledTimes(2);

    const after = await prisma.prospect.findUniqueOrThrow({ where: { id: prospectId }, select: { status: true } });
    expect(after.status).toBe('sent');

    // Approving the same draft again must not send a third time.
    const again = await approveDrafts([{ draftId: firstDraftId }]);
    expect(again[0]).toEqual({ draftId: firstDraftId, outcome: 'skipped_already_approved' });
    expect(sendEmailMock).toHaveBeenCalledTimes(2);
  });

  it('refuses a sibling variant while the first is mid-send, and refuses to resolve it, with the first send held open', async () => {
    const { prospectId, draftIds } = await seedDraftedProspect();
    const [firstDraftId, secondDraftId] = draftIds;

    // Hold the first send open on a promise we control, so the second approval
    // runs entirely while the first claim is committed and its send is in flight.
    const gate = deferred<SendEmailResult>();
    const firstSendStarted = deferred<void>();
    sendEmailMock.mockImplementationOnce(() => {
      firstSendStarted.resolve();
      return gate.promise;
    });

    const first = approveDrafts([{ draftId: firstDraftId }]);
    await firstSendStarted.promise;

    const second = await approveDrafts([{ draftId: secondDraftId }]);
    expect(second[0]).toMatchObject({ draftId: secondDraftId, outcome: 'failed', reason: expect.stringContaining('being sent right now') });
    expect(sendEmailMock).toHaveBeenCalledTimes(1);

    // A send that is still running cannot be answered yet.
    expect(await resolveUnconfirmedSend(prospectId, 'not_delivered')).toEqual({ outcome: 'send_in_progress' });

    gate.resolve({ ok: true, id: 'resend-message-id' });
    expect((await first)[0]).toEqual({ draftId: firstDraftId, outcome: 'sent' });
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });

  it('sends exactly one variant when two variants are approved at the same moment', async () => {
    const { draftIds } = await seedDraftedProspect();
    const [firstDraftId, secondDraftId] = draftIds;
    sendEmailMock.mockResolvedValue({ ok: true, id: 'resend-message-id' });

    // Whichever transaction takes the prospect row lock first wins; the other
    // must see its committed claim (or the completed send) and refuse.
    const results = await Promise.all([
      approveDrafts([{ draftId: firstDraftId }]),
      approveDrafts([{ draftId: secondDraftId }]),
    ]);

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(results.flat().filter((result) => result.outcome === 'sent')).toHaveLength(1);
  });

  it('refuses a stale tab approving another variant after the prospect was already sent', async () => {
    const { prospectId, draftIds } = await seedDraftedProspect();
    const [firstDraftId, secondDraftId] = draftIds;
    sendEmailMock.mockResolvedValue({ ok: true, id: 'resend-message-id' });

    const sent = await approveDrafts([{ draftId: firstDraftId }]);
    expect(sent[0]).toEqual({ draftId: firstDraftId, outcome: 'sent' });

    const stale = await approveDrafts([{ draftId: secondDraftId }]);

    expect(stale[0]).toMatchObject({ draftId: secondDraftId, outcome: 'failed' });
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const prospect = await prisma.prospect.findUniqueOrThrow({ where: { id: prospectId }, select: { status: true } });
    expect(prospect.status).toBe('sent');
  });
});
