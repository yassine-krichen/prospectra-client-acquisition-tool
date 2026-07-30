import { beforeEach, describe, expect, it, vi } from 'vitest';

// Orchestration test: the rules engine itself is fully covered by
// service-matching-rules.test.ts, so this only exercises
// applyServiceMatching's read/validate/persist wiring. Prisma is mocked,
// same vi.hoisted pattern as convert-to-client.service.test.ts.
const { findUniqueMock, updateMock } = vi.hoisted(() => ({
  findUniqueMock: vi.fn(),
  updateMock: vi.fn(),
}));

vi.mock('@/common/db/client', () => ({
  prisma: { prospect: { findUnique: findUniqueMock, update: updateMock } },
}));

const { applyServiceMatching } = await import('./matching.service');

interface ProspectRowOverrides {
  signal?: unknown;
  companySize?: string;
  industry?: string;
}

function buildProspectRow(overrides: ProspectRowOverrides = {}) {
  return {
    id: 'prospect-1',
    signal: overrides.signal ?? { type: 'no_website', description: 'no site', evidence: null, strength: 'strong' },
    companySize: overrides.companySize ?? 'size_1_10',
    industry: overrides.industry ?? 'local_service',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  findUniqueMock.mockResolvedValue(buildProspectRow());
  updateMock.mockResolvedValue(undefined);
});

describe('applyServiceMatching', () => {
  it('returns not_found and never writes when no prospect exists with the given id', async () => {
    findUniqueMock.mockResolvedValue(null);

    const result = await applyServiceMatching('missing-id');

    expect(result).toEqual({ outcome: 'not_found', prospectId: 'missing-id' });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('returns invalid_signal and never writes when the stored signal fails validation', async () => {
    findUniqueMock.mockResolvedValue(buildProspectRow({ signal: { type: 'not_a_real_signal_type' } }));

    const result = await applyServiceMatching('prospect-1');

    expect(result.outcome).toBe('invalid_signal');
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('persists suggestedServices/projectFit/estimatedBudget derived from the rules engine', async () => {
    const result = await applyServiceMatching('prospect-1');

    expect(result.outcome).toBe('applied');
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: 'prospect-1' },
      data: {
        suggestedServices: expect.any(Array),
        projectFit: 'landing_page',
        estimatedBudget: 'low',
      },
    });
  });

  it('maps the Prisma companySize enum value back to the domain shape before running the rules engine', async () => {
    findUniqueMock.mockResolvedValue(
      buildProspectRow({
        companySize: 'size_11_50',
        signal: { type: 'outdated_site', description: 'stale stack', evidence: null, strength: 'medium' },
      })
    );

    const result = await applyServiceMatching('prospect-1');

    expect(result.outcome).toBe('applied');
    if (result.outcome !== 'applied') return;
    const primary = result.suggestedServices.find((suggestion) => suggestion.role === 'primary');
    expect(primary?.service).toBe('full_stack_app');
  });

  it('returns the same suggestedServices array it persisted', async () => {
    const result = await applyServiceMatching('prospect-1');

    expect(result.outcome).toBe('applied');
    if (result.outcome !== 'applied') return;
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ suggestedServices: result.suggestedServices }) })
    );
  });
});
