import { beforeEach, describe, expect, it, vi } from 'vitest';

// convertProspectToClient is the sole entry point allowed to flip a Prospect
// to `won` and create its Client - same "one atomic claim, conditioned on
// exactly the state just read" pattern as send-queue.service.ts/
// followup-scheduler.ts. Prisma is mocked (this is an orchestration test,
// not a real-DB test), including `$transaction`, which is modeled as simply
// invoking the given callback with a mocked `tx` client - matching how the
// real Prisma client behaves for an interactive transaction.
const { findUniqueProspectMock, updateManyProspectMock, findUniqueClientMock, createClientMock } = vi.hoisted(() => ({
  findUniqueProspectMock: vi.fn(),
  updateManyProspectMock: vi.fn(),
  findUniqueClientMock: vi.fn(),
  createClientMock: vi.fn(),
}));

vi.mock('@/common/db/client', () => ({
  prisma: {
    $transaction: (callback: (tx: unknown) => unknown) =>
      callback({
        prospect: { findUnique: findUniqueProspectMock, updateMany: updateManyProspectMock },
        client: { findUnique: findUniqueClientMock, create: createClientMock },
      }),
  },
}));

const { convertProspectToClient } = await import('./convert-to-client.service');

interface ProspectRowOverrides {
  id?: string;
  status?: string;
  doNotContact?: boolean;
  statusHistory?: unknown;
}

function buildProspectRow(overrides: ProspectRowOverrides = {}) {
  return {
    id: overrides.id ?? 'prospect-1',
    companyName: 'Acme Inc',
    domain: 'acme.com',
    contactName: 'Jane Doe',
    contactTitle: 'CEO',
    contactEmail: 'jane@acme.com',
    industry: 'saas',
    companySize: 'size_11_50',
    doNotContact: overrides.doNotContact ?? false,
    status: overrides.status ?? 'replied',
    statusHistory: overrides.statusHistory ?? [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  findUniqueProspectMock.mockResolvedValue(buildProspectRow());
  updateManyProspectMock.mockResolvedValue({ count: 1 });
  findUniqueClientMock.mockResolvedValue(null);
  createClientMock.mockResolvedValue({ id: 'client-1' });
});

describe('convertProspectToClient not found', () => {
  it('returns not_found when no prospect exists with the given id', async () => {
    findUniqueProspectMock.mockResolvedValue(null);

    const result = await convertProspectToClient('missing-id');

    expect(result).toEqual({ outcome: 'not_found' });
    expect(createClientMock).not.toHaveBeenCalled();
  });
});

describe('convertProspectToClient happy path', () => {
  it('creates exactly one Client and returns converted with its id', async () => {
    const result = await convertProspectToClient('prospect-1');

    expect(result).toEqual({ outcome: 'converted', clientId: 'client-1' });
    expect(createClientMock).toHaveBeenCalledTimes(1);
    expect(createClientMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        prospectId: 'prospect-1',
        companyName: 'Acme Inc',
        domain: 'acme.com',
        contactName: 'Jane Doe',
        contactTitle: 'CEO',
        contactEmail: 'jane@acme.com',
        industry: 'saas',
        companySize: 'size_11_50',
      }),
      select: { id: true },
    });
  });

  it('claims the prospect as won before creating the Client', async () => {
    await convertProspectToClient('prospect-1');

    expect(updateManyProspectMock).toHaveBeenCalledWith({
      where: { id: 'prospect-1', status: { not: 'won' }, doNotContact: false },
      data: { status: 'won', statusHistory: [{ status: 'won', timestamp: expect.any(String) }] },
    });
  });

  it('allows a dead prospect (doNotContact false) to convert', async () => {
    findUniqueProspectMock.mockResolvedValue(buildProspectRow({ status: 'dead' }));

    const result = await convertProspectToClient('prospect-1');

    expect(result).toEqual({ outcome: 'converted', clientId: 'client-1' });
  });
});

describe('convertProspectToClient double-conversion idempotency', () => {
  it('returns already_converted with the existing Client id and never creates a second Client', async () => {
    findUniqueClientMock.mockResolvedValue({ id: 'client-existing' });

    const result = await convertProspectToClient('prospect-1');

    expect(result).toEqual({ outcome: 'already_converted', clientId: 'client-existing' });
    expect(updateManyProspectMock).not.toHaveBeenCalled();
    expect(createClientMock).not.toHaveBeenCalled();
  });
});

describe('convertProspectToClient concurrent-call race', () => {
  it('reports already_converted for the loser of a concurrent race once the winner has created its Client', async () => {
    updateManyProspectMock.mockResolvedValue({ count: 0 });
    findUniqueClientMock.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'client-winner' });

    const result = await convertProspectToClient('prospect-1');

    expect(result).toEqual({ outcome: 'already_converted', clientId: 'client-winner' });
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it('reports not_found if the claim is lost and no Client can be found (prospect vanished mid-race)', async () => {
    updateManyProspectMock.mockResolvedValue({ count: 0 });
    findUniqueClientMock.mockResolvedValue(null);

    const result = await convertProspectToClient('prospect-1');

    expect(result).toEqual({ outcome: 'not_found' });
    expect(createClientMock).not.toHaveBeenCalled();
  });
});

describe('convertProspectToClient doNotContact enforcement', () => {
  it('blocks conversion and never attempts the claim when doNotContact is true', async () => {
    findUniqueProspectMock.mockResolvedValue(buildProspectRow({ doNotContact: true }));

    const result = await convertProspectToClient('prospect-1');

    expect(result).toEqual({ outcome: 'blocked_do_not_contact' });
    expect(updateManyProspectMock).not.toHaveBeenCalled();
    expect(createClientMock).not.toHaveBeenCalled();
  });
});
