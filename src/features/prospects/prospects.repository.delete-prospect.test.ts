import { beforeEach, describe, expect, it, vi } from 'vitest';

// deleteProspect is the sole entry point allowed to permanently remove a
// Prospect row - same "one atomic claim, conditioned on exactly the state
// just read" pattern as convertProspectToClient's doNotContact guard (see
// convert-to-client.service.test.ts). Prisma is mocked at the client level
// (not the repository itself, and not the route) so the real `findUnique`
// short-circuit and the real `deleteMany` where-clause both actually run -
// a route-level mock of `deleteProspect` (as the existing
// app/api/prospects/[id]/route.test.ts and
// app/api/prospects/bulk/delete/route.test.ts files use) would never
// exercise this guard logic at all.
const { findUniqueProspectMock, deleteManyProspectMock } = vi.hoisted(() => ({
  findUniqueProspectMock: vi.fn(),
  deleteManyProspectMock: vi.fn(),
}));

vi.mock('@/common/db/client', () => ({
  prisma: {
    prospect: { findUnique: findUniqueProspectMock, deleteMany: deleteManyProspectMock },
  },
}));

const { deleteProspect } = await import('./prospects.repository');

beforeEach(() => {
  vi.clearAllMocks();
  findUniqueProspectMock.mockResolvedValue({ doNotContact: false });
  deleteManyProspectMock.mockResolvedValue({ count: 1 });
});

describe('deleteProspect happy path', () => {
  it('deletes a prospect with doNotContact false and returns deleted with its id', async () => {
    const result = await deleteProspect('prospect-1');

    expect(result).toEqual({ outcome: 'deleted', id: 'prospect-1' });
    expect(deleteManyProspectMock).toHaveBeenCalledWith({
      where: { id: 'prospect-1', doNotContact: false },
    });
  });
});

describe('deleteProspect doNotContact enforcement', () => {
  it('blocks deletion and never calls deleteMany when doNotContact is true', async () => {
    findUniqueProspectMock.mockResolvedValue({ doNotContact: true });

    const result = await deleteProspect('prospect-1');

    expect(result).toEqual({ outcome: 'blocked_do_not_contact' });
    expect(deleteManyProspectMock).not.toHaveBeenCalled();
  });
});

describe('deleteProspect not found', () => {
  it('returns not_found and never calls deleteMany when no prospect exists with the given id', async () => {
    findUniqueProspectMock.mockResolvedValue(null);

    const result = await deleteProspect('missing-id');

    expect(result).toEqual({ outcome: 'not_found' });
    expect(deleteManyProspectMock).not.toHaveBeenCalled();
  });
});

describe('deleteProspect concurrent doNotContact race', () => {
  it('returns not_found, not deleted, when doNotContact flips to true between the check and the delete', async () => {
    // The initial findUnique check passes (doNotContact still false at read
    // time), but by the time deleteMany runs, the row's doNotContact flag
    // has flipped to true in the real DB - so deleteMany's own
    // `doNotContact: false` where-clause condition matches zero rows. This
    // is exactly the atomicity guarantee deleteProspect's doc comment
    // claims: the row must never be reported deleted (or actually deleted)
    // once doNotContact is true, even if the check-then-act read raced it.
    findUniqueProspectMock.mockResolvedValue({ doNotContact: false });
    deleteManyProspectMock.mockResolvedValue({ count: 0 });

    const result = await deleteProspect('prospect-1');

    expect(result).toEqual({ outcome: 'not_found' });
    expect(deleteManyProspectMock).toHaveBeenCalledWith({
      where: { id: 'prospect-1', doNotContact: false },
    });
  });
});
