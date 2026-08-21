import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';

const { GET } = await import('./route');

function catalogRequest(companySize?: string): NextRequest {
  const url = companySize
    ? `http://localhost/api/pricing/catalog?companySize=${encodeURIComponent(companySize)}`
    : 'http://localhost/api/pricing/catalog';
  return new NextRequest(url);
}

describe('GET /api/pricing/catalog', () => {
  it('returns 200 with each tiered service price range and cadence plus the flat infra_hosting_retainer range for a 1-10 company', async () => {
    const response = await GET(catalogRequest('1-10'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      services: [
        { service: 'landing_page', cadence: 'one_off', catalogEntry: { minCents: 80_000, maxCents: 150_000 } },
        { service: 'full_stack_app', cadence: 'one_off', catalogEntry: { minCents: 300_000, maxCents: 800_000 } },
        {
          service: 'linkedin_media_management',
          cadence: 'recurring',
          catalogEntry: { minCents: 30_000, maxCents: 50_000 },
        },
      ],
      infraHostingRetainerRange: { minCents: 5_000, maxCents: 15_000 },
    });
  });

  it('returns "manual_quote" for every tiered service when companySize is 201+', async () => {
    const response = await GET(catalogRequest('201+'));
    const body = await response.json();

    expect(response.status).toBe(200);
    for (const entry of body.services) {
      expect(entry.catalogEntry).toBe('manual_quote');
    }
  });

  it('returns "manual_quote" for every tiered service when companySize is unknown', async () => {
    const response = await GET(catalogRequest('unknown'));
    const body = await response.json();

    expect(response.status).toBe(200);
    for (const entry of body.services) {
      expect(entry.catalogEntry).toBe('manual_quote');
    }
  });

  it('returns 400 when companySize is missing from the query params', async () => {
    const response = await GET(catalogRequest());

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'companySize is required.' });
  });

  it('returns 400 when companySize is not one of the valid enum values', async () => {
    const response = await GET(catalogRequest('gigantic'));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'companySize is required.' });
  });
});
