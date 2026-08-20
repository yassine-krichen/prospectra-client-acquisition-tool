import { beforeEach, describe, expect, it, vi } from 'vitest';

// createJob is the one production write path for recording a sold service
// against a Client - see its doc comment. Prisma is mocked (orchestration
// test, not a real-DB test), same convention as convert-to-client.service.test.ts.
const { findUniqueClientMock, createJobMock } = vi.hoisted(() => ({
  findUniqueClientMock: vi.fn(),
  createJobMock: vi.fn(),
}));

vi.mock('@/common/db/client', () => ({
  prisma: { client: { findUnique: findUniqueClientMock }, job: { create: createJobMock } },
}));

const { createJob } = await import('./create-job.service');

beforeEach(() => {
  vi.clearAllMocks();
  findUniqueClientMock.mockResolvedValue({ id: 'client-1' });
  createJobMock.mockResolvedValue({ id: 'job-1' });
});

describe('createJob client existence', () => {
  it('returns client_not_found without calling job.create when no Client exists with this id', async () => {
    findUniqueClientMock.mockResolvedValue(null);

    const result = await createJob('missing-client', { service: 'landing_page', agreedPriceCents: 100_000 });

    expect(result).toEqual({ outcome: 'client_not_found' });
    expect(createJobMock).not.toHaveBeenCalled();
  });
});

describe('createJob cadence derivation', () => {
  it.each([
    ['landing_page', 'one_off'],
    ['full_stack_app', 'one_off'],
    ['linkedin_media_management', 'recurring'],
    ['infra_hosting_retainer', 'recurring'],
  ])('derives cadence %s -> %s from the service, never accepting it as a caller-supplied field', async (service, expectedCadence) => {
    await createJob('client-1', { service: service as never, agreedPriceCents: 50_000 });

    expect(createJobMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ service, cadence: expectedCadence }) })
    );
  });
});

describe('createJob retainerDiscount validation', () => {
  it('rejects retainerDiscount on a non-infra_hosting_retainer service as invalid_input, without calling job.create', async () => {
    const result = await createJob('client-1', {
      service: 'landing_page',
      agreedPriceCents: 100_000,
      retainerDiscount: 'free',
    });

    expect(result).toEqual({ outcome: 'invalid_input', reason: expect.any(String) });
    expect(createJobMock).not.toHaveBeenCalled();
  });

  it('accepts retainerDiscount on infra_hosting_retainer and stamps retainerDiscountEndsAt in the future', async () => {
    const result = await createJob('client-1', {
      service: 'infra_hosting_retainer',
      agreedPriceCents: 10_000,
      retainerDiscount: 'half_price',
    });

    expect(result).toEqual({ outcome: 'created', jobId: 'job-1' });
    const call = createJobMock.mock.calls[0][0] as { data: { retainerDiscount: string; retainerDiscountEndsAt: Date } };
    expect(call.data.retainerDiscount).toBe('half_price');
    expect(call.data.retainerDiscountEndsAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('leaves retainerDiscount/retainerDiscountEndsAt null when not supplied', async () => {
    await createJob('client-1', { service: 'infra_hosting_retainer', agreedPriceCents: 10_000 });

    const call = createJobMock.mock.calls[0][0] as { data: { retainerDiscount: unknown; retainerDiscountEndsAt: unknown } };
    expect(call.data.retainerDiscount).toBeNull();
    expect(call.data.retainerDiscountEndsAt).toBeNull();
  });
});

describe('createJob happy path', () => {
  it('creates a Job with status active, the given agreedPriceCents, and a seeded statusHistory', async () => {
    const result = await createJob('client-1', { service: 'full_stack_app', agreedPriceCents: 500_000, notes: 'via referral' });

    expect(result).toEqual({ outcome: 'created', jobId: 'job-1' });
    expect(createJobMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          clientId: 'client-1',
          service: 'full_stack_app',
          status: 'active',
          agreedPriceCents: 500_000,
          notes: 'via referral',
          statusHistory: [{ status: 'active', timestamp: expect.any(String) }],
        }),
      })
    );
  });

  it('defaults notes to null when not supplied', async () => {
    await createJob('client-1', { service: 'landing_page', agreedPriceCents: 100_000 });

    const call = createJobMock.mock.calls[0][0] as { data: { notes: unknown } };
    expect(call.data.notes).toBeNull();
  });
});
