import { beforeEach, describe, expect, it, vi } from 'vitest';

// This is the reply-vs-follow-up race's other half: `processInboundReply`'s
// atomic `updateMany` (WHERE status IN REPLYABLE_STATUSES) is what makes a
// reply always win over an in-flight follow-up claim, and what makes a
// duplicate/late-arriving webhook event a no-op rather than a re-trigger.
// Prisma is mocked (this is an orchestration test, not a DB test) —
// `followup-scheduler.test.ts` covers the scheduler's half of the same race.
const { findFirstMock, updateManyMock } = vi.hoisted(() => ({
  findFirstMock: vi.fn(),
  updateManyMock: vi.fn(),
}));

vi.mock('@/common/db/client', () => ({
  prisma: { prospect: { findFirst: findFirstMock, updateMany: updateManyMock } },
}));

const { processInboundReply } = await import('./reply-detection.service');

function buildProspectRow(overrides: Partial<{ id: string; status: string; statusHistory: unknown }> = {}) {
  return {
    id: overrides.id ?? 'prospect-1',
    status: overrides.status ?? 'sent',
    statusHistory: overrides.statusHistory ?? [{ status: 'sent', timestamp: '2026-01-01T00:00:00.000Z' }],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  findFirstMock.mockResolvedValue(null);
  updateManyMock.mockResolvedValue({ count: 1 });
});

describe('processInboundReply payload validation', () => {
  it('returns invalid_payload without touching the database when fromEmail is not a valid email', async () => {
    const result = await processInboundReply({ fromEmail: 'not-an-email', subject: null, text: null });

    expect(result).toEqual({ outcome: 'invalid_payload', reason: expect.any(String) });
    expect(findFirstMock).not.toHaveBeenCalled();
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it('returns invalid_payload without throwing when the payload is missing required fields entirely', async () => {
    await expect(processInboundReply({})).resolves.toEqual({
      outcome: 'invalid_payload',
      reason: expect.any(String),
    });
  });

  it('returns invalid_payload without throwing for a completely malformed payload (null)', async () => {
    await expect(processInboundReply(null)).resolves.toEqual({
      outcome: 'invalid_payload',
      reason: expect.any(String),
    });
  });
});

describe('processInboundReply no matching prospect', () => {
  it('returns no_match and never calls updateMany when no prospect has this contactEmail', async () => {
    findFirstMock.mockResolvedValue(null);

    const result = await processInboundReply({ fromEmail: 'stranger@example.com', subject: null, text: 'hi' });

    expect(result).toEqual({ outcome: 'no_match' });
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it('matches by exact contactEmail via findFirst rather than creating a new prospect', async () => {
    findFirstMock.mockResolvedValue(null);

    await processInboundReply({ fromEmail: 'someone@example.com', subject: null, text: null });

    expect(findFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { contactEmail: 'someone@example.com' } })
    );
  });
});

describe('processInboundReply matched prospect — status transition', () => {
  it('transitions a matched prospect to replied and sets repliedAt on a neutral reply', async () => {
    findFirstMock.mockResolvedValue(buildProspectRow({ id: 'prospect-1', status: 'sent' }));

    const result = await processInboundReply({
      fromEmail: 'contact@example.com',
      subject: 'Re: your outreach',
      text: 'Thanks for reaching out, I will think about it.',
    });

    expect(result).toEqual({ outcome: 'matched', prospectId: 'prospect-1', sentiment: 'neutral' });
    expect(updateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'prospect-1', status: { in: ['sent', 'followup_1', 'followup_2', 'followup_3'] } },
        data: expect.objectContaining({
          status: 'replied',
          repliedAt: expect.any(Date),
          replySentiment: 'neutral',
        }),
      })
    );
  });

  it('appends to statusHistory rather than discarding prior entries', async () => {
    findFirstMock.mockResolvedValue(
      buildProspectRow({ statusHistory: [{ status: 'sent', timestamp: '2026-01-01T00:00:00.000Z' }] })
    );

    await processInboundReply({ fromEmail: 'contact@example.com', subject: null, text: 'ok' });

    const call = updateManyMock.mock.calls[0][0] as { data: { statusHistory: Array<{ status: string }> } };
    expect(call.data.statusHistory).toHaveLength(2);
    expect(call.data.statusHistory[0]).toEqual({ status: 'sent', timestamp: '2026-01-01T00:00:00.000Z' });
    expect(call.data.statusHistory[1].status).toBe('replied');
  });

  it.each(['unsubscribe', 'stop emailing', 'not interested', 'no thanks', "don't contact"])(
    'sets doNotContact:true and unsubscribedAt when the reply contains the negative keyword %j',
    async (keyword) => {
      findFirstMock.mockResolvedValue(buildProspectRow());

      const result = await processInboundReply({ fromEmail: 'contact@example.com', subject: null, text: `Please ${keyword}` });

      expect(result).toEqual({ outcome: 'matched', prospectId: 'prospect-1', sentiment: 'negative' });
      expect(updateManyMock).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'replied',
            replySentiment: 'negative',
            doNotContact: true,
            unsubscribedAt: expect.any(Date),
          }),
        })
      );
    }
  );

  it('treats a reply containing both an opt-out phrase and a pleasantry as negative (negative takes priority)', async () => {
    findFirstMock.mockResolvedValue(buildProspectRow());

    const result = await processInboundReply({
      fromEmail: 'contact@example.com',
      subject: null,
      text: "Thanks so much for reaching out, sounds great, but please remove me from your list.",
    });

    expect(result.outcome).toBe('matched');
    if (result.outcome !== 'matched') return;
    expect(result.sentiment).toBe('negative');
  });

  it.each(["let's chat", 'sounds good', 'book a call', 'yes please'])(
    'keeps doNotContact false and reports positive sentiment for a reply containing %j',
    async (keyword) => {
      findFirstMock.mockResolvedValue(buildProspectRow());

      const result = await processInboundReply({ fromEmail: 'contact@example.com', subject: null, text: keyword });

      expect(result).toEqual({ outcome: 'matched', prospectId: 'prospect-1', sentiment: 'positive' });
      const call = updateManyMock.mock.calls[0][0] as { data: Record<string, unknown> };
      expect(call.data.doNotContact).toBeUndefined();
      expect(call.data.unsubscribedAt).toBeUndefined();
    }
  );

  it('reports neutral sentiment and keeps doNotContact false for a reply with no matching keyword', async () => {
    findFirstMock.mockResolvedValue(buildProspectRow());

    const result = await processInboundReply({
      fromEmail: 'contact@example.com',
      subject: null,
      text: 'What is the timeline for this?',
    });

    expect(result).toEqual({ outcome: 'matched', prospectId: 'prospect-1', sentiment: 'neutral' });
    const call = updateManyMock.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(call.data.doNotContact).toBeUndefined();
  });

  it('combines subject and text when detecting sentiment, catching a negative keyword that only appears in the subject', async () => {
    findFirstMock.mockResolvedValue(buildProspectRow());

    const result = await processInboundReply({
      fromEmail: 'contact@example.com',
      subject: 'Unsubscribe please',
      text: 'thanks',
    });

    expect(result).toEqual({ outcome: 'matched', prospectId: 'prospect-1', sentiment: 'negative' });
  });

  it('treats a null subject and null text as an empty string rather than throwing', async () => {
    findFirstMock.mockResolvedValue(buildProspectRow());

    await expect(
      processInboundReply({ fromEmail: 'contact@example.com', subject: null, text: null })
    ).resolves.toEqual({ outcome: 'matched', prospectId: 'prospect-1', sentiment: 'neutral' });
  });
});

// This is the reply side of the reply-vs-follow-up race: the atomic
// updateMany's WHERE clause (status IN REPLYABLE_STATUSES) is the only thing
// that decides whether this reply is applied — there's no earlier "is this
// prospect still in flight" read-then-write gap for a concurrent follow-up
// send to land in between.
describe('processInboundReply idempotency / already-terminal prospects', () => {
  it('reports already_terminal and does not re-apply side effects for a prospect already replied', async () => {
    findFirstMock.mockResolvedValue(buildProspectRow({ status: 'replied' }));
    updateManyMock.mockResolvedValue({ count: 0 });

    const result = await processInboundReply({ fromEmail: 'contact@example.com', subject: null, text: 'unsubscribe' });

    expect(result).toEqual({ outcome: 'already_terminal', prospectId: 'prospect-1' });
  });

  it('still attempts the atomic claim with the in-flight status filter even for a prospect read as already replied, never assuming the outcome from the initial read alone', async () => {
    findFirstMock.mockResolvedValue(buildProspectRow({ status: 'replied' }));
    updateManyMock.mockResolvedValue({ count: 0 });

    await processInboundReply({ fromEmail: 'contact@example.com', subject: null, text: 'hi' });

    expect(updateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'prospect-1', status: { in: ['sent', 'followup_1', 'followup_2', 'followup_3'] } } })
    );
  });

  it('reports already_terminal for a prospect that is dead, without ever reopening it to replied', async () => {
    findFirstMock.mockResolvedValue(buildProspectRow({ status: 'dead' }));
    updateManyMock.mockResolvedValue({ count: 0 });

    const result = await processInboundReply({ fromEmail: 'contact@example.com', subject: null, text: 'hello again' });

    expect(result).toEqual({ outcome: 'already_terminal', prospectId: 'prospect-1' });
  });

  it('a second inbound event for the same already-replied prospect is a no-op: it does not report matched twice', async () => {
    // First event: prospect is still `sent`, reply lands normally.
    findFirstMock.mockResolvedValueOnce(buildProspectRow({ status: 'sent' }));
    updateManyMock.mockResolvedValueOnce({ count: 1 });
    const first = await processInboundReply({ fromEmail: 'contact@example.com', subject: null, text: 'ok' });
    expect(first).toEqual({ outcome: 'matched', prospectId: 'prospect-1', sentiment: 'neutral' });

    // Second, duplicate delivery of essentially the same webhook event: the
    // prospect is now (correctly) read back as `replied`, so the atomic claim
    // against REPLYABLE_STATUSES matches nothing.
    findFirstMock.mockResolvedValueOnce(buildProspectRow({ status: 'replied' }));
    updateManyMock.mockResolvedValueOnce({ count: 0 });
    const second = await processInboundReply({ fromEmail: 'contact@example.com', subject: null, text: 'ok' });

    expect(second).toEqual({ outcome: 'already_terminal', prospectId: 'prospect-1' });
  });
});
