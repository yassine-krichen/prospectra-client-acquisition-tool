import { describe, expect, it, vi } from 'vitest';

const draftBatchMock = vi.fn();
const humanizeBatchMock = vi.fn();
vi.mock('@/features/drafting/drafting.service', () => ({
  draftBatch: draftBatchMock,
  humanizeBatch: humanizeBatchMock,
}));

const { POST } = await import('./route');

describe('POST /api/pipeline/draft-batch', () => {
  it('runs draftBatch then humanizeBatch and returns 200 with both summaries', async () => {
    draftBatchMock.mockResolvedValue([
      { prospectId: 'prospect-1', outcome: { ok: true, drafts: [], humanize: { attempted: false } } },
    ]);
    humanizeBatchMock.mockResolvedValue({ attempted: 0, results: [] });

    const response = await POST();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(draftBatchMock).toHaveBeenCalled();
    expect(humanizeBatchMock).toHaveBeenCalled();
    expect(body).toEqual({
      drafted: [{ prospectId: 'prospect-1', outcome: { ok: true, drafts: [], humanize: { attempted: false } } }],
      humanized: { attempted: 0, results: [] },
    });
  });

  it('returns 200 with empty results when there are no prospects left to draft', async () => {
    draftBatchMock.mockResolvedValue([]);
    humanizeBatchMock.mockResolvedValue({ attempted: 0, results: [] });

    const response = await POST();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ drafted: [], humanized: { attempted: 0, results: [] } });
  });
});
