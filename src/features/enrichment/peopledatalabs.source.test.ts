import { afterEach, describe, expect, it, vi } from 'vitest';

// `vi.hoisted` guarantees `envMock` is initialized before `vi.mock`'s factory
// (itself hoisted above this file's imports) ever runs.
const envMock = vi.hoisted(() => ({ PEOPLE_DATA_LABS_API_KEY: 'test-pdl-key' as string | undefined }));
vi.mock('@/common/config/env', () => ({ env: envMock }));

import { runPeopleDataLabsEnrichment } from './peopledatalabs.source';

const input = { domain: 'acme.com', companyName: 'Acme Inc', contactName: null as string | null };

function mockFetchJson(body: unknown, options: { ok?: boolean; status?: number } = {}): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: options.ok ?? true,
    status: options.status ?? 200,
    json: () => Promise.resolve(body),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('runPeopleDataLabsEnrichment', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    envMock.PEOPLE_DATA_LABS_API_KEY = 'test-pdl-key';
  });

  it('reports source unavailable and never calls fetch when PEOPLE_DATA_LABS_API_KEY is not configured', async () => {
    envMock.PEOPLE_DATA_LABS_API_KEY = undefined;
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await runPeopleDataLabsEnrichment(input);

    expect(result).toEqual({ ok: false, reason: 'source unavailable: PEOPLE_DATA_LABS_API_KEY not configured' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('marks emailVerified true and scales likelihood to a 0-100 confidence when the match likelihood is at or above the high-confidence threshold (8)', async () => {
    mockFetchJson({
      status: 200,
      likelihood: 9,
      data: { full_name: 'Jane Doe', job_title: 'CEO', work_email: 'jane@acme.com', linkedin_url: 'https://linkedin.com/in/janedoe' },
    });

    const result = await runPeopleDataLabsEnrichment(input);

    expect(result).toEqual({
      ok: true,
      contact: {
        contactName: 'Jane Doe',
        contactTitle: 'CEO',
        contactEmail: 'jane@acme.com',
        emailVerified: true,
        emailConfidence: 90,
        linkedinUrl: 'https://linkedin.com/in/janedoe',
      },
    });
  });

  it('marks emailVerified false when the match likelihood is below the high-confidence threshold (8)', async () => {
    mockFetchJson({
      status: 200,
      likelihood: 7,
      data: { full_name: 'Jane Doe', job_title: null, work_email: 'jane@acme.com', linkedin_url: null },
    });

    const result = await runPeopleDataLabsEnrichment(input);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(result.contact.emailVerified).toBe(false);
    expect(result.contact.emailConfidence).toBe(70);
  });

  it('rejects a match whose likelihood would scale to a confidence at or below the pattern-guess floor (15)', async () => {
    mockFetchJson({
      status: 200,
      likelihood: 1,
      data: { full_name: 'Jane Doe', work_email: 'jane@acme.com' },
    });

    const result = await runPeopleDataLabsEnrichment(input);

    expect(result).toEqual({
      ok: false,
      reason: 'source unavailable: PDL match likelihood (1) is too low to trust',
    });
  });

  it('accepts a match right at the minimum acceptable likelihood (2)', async () => {
    mockFetchJson({
      status: 200,
      likelihood: 2,
      data: { full_name: 'Jane Doe', work_email: 'jane@acme.com' },
    });

    const result = await runPeopleDataLabsEnrichment(input);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(result.contact.emailConfidence).toBe(20);
  });

  it('falls back to the input contactName when PDL returns no full_name of its own', async () => {
    mockFetchJson({ status: 200, likelihood: 9, data: { work_email: 'jane@acme.com' } });

    const result = await runPeopleDataLabsEnrichment({ ...input, contactName: 'Jane Doe' });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(result.contact.contactName).toBe('Jane Doe');
  });

  it('fails closed and reports unavailable when PDL finds no work email for this contact', async () => {
    mockFetchJson({ status: 200, likelihood: 9, data: { full_name: 'Jane Doe', work_email: null } });

    const result = await runPeopleDataLabsEnrichment(input);

    expect(result).toEqual({ ok: false, reason: 'source unavailable: PDL found no work email for this contact' });
  });

  it('fails closed and reports unavailable when the network request throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const result = await runPeopleDataLabsEnrichment(input);

    expect(result).toEqual({
      ok: false,
      reason: 'source unavailable: PDL request failed (ECONNREFUSED)',
    });
  });

  it('fails closed and reports unavailable when PDL responds with a non-2xx status (e.g. 404 no match)', async () => {
    mockFetchJson({}, { ok: false, status: 404 });

    const result = await runPeopleDataLabsEnrichment(input);

    expect(result).toEqual({ ok: false, reason: 'source unavailable: PDL responded with 404' });
  });

  it('fails closed via zod rejection, not a crash, when the response shape is unrecognizable', async () => {
    mockFetchJson({ status: 'not-a-number' });

    const result = await runPeopleDataLabsEnrichment(input);

    expect(result).toEqual({
      ok: false,
      reason: 'source unavailable: PDL response did not match the expected shape',
    });
  });
});
