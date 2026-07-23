import { afterEach, describe, expect, it, vi } from 'vitest';

import { generateGeminiDraft } from './gemini.client';

const PROMPT = 'write me a cold email';
const API_KEY = 'test-gemini-key';

function mockFetchJson(body: unknown, options: { ok?: boolean; status?: number } = {}): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: options.ok ?? true,
    status: options.status ?? 200,
    json: () => Promise.resolve(body),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function geminiSuccessBody(text: string): unknown {
  return { candidates: [{ content: { parts: [{ text }] } }] };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('generateGeminiDraft', () => {
  it('calls the Gemini generateContent endpoint with the key as a query param', async () => {
    const fetchMock = mockFetchJson(geminiSuccessBody('SUBJECT: Hi\nBODY: A short valid body.'));

    await generateGeminiDraft(PROMPT, API_KEY);

    const [url] = fetchMock.mock.calls[0] as [URL];
    expect(url.toString()).toContain('generateContent');
    expect(url.searchParams.get('key')).toBe(API_KEY);
  });

  it('returns the parsed subject and body on a well-formed successful response', async () => {
    mockFetchJson(geminiSuccessBody('SUBJECT: Quick idea\nBODY: Worth a quick chat?'));

    const result = await generateGeminiDraft(PROMPT, API_KEY);

    expect(result).toEqual({ ok: true, subject: 'Quick idea', body: 'Worth a quick chat?' });
  });

  it('joins multiple text parts before parsing, when Gemini splits the completion across several parts', async () => {
    mockFetchJson({
      candidates: [{ content: { parts: [{ text: 'SUBJECT: Hi\n' }, { text: 'BODY: split across parts' }] } }],
    });

    const result = await generateGeminiDraft(PROMPT, API_KEY);

    expect(result).toEqual({ ok: true, subject: 'Hi', body: 'split across parts' });
  });

  it('fails closed with a typed result, without throwing, on a non-2xx response', async () => {
    mockFetchJson({}, { ok: false, status: 429 });

    const result = await generateGeminiDraft(PROMPT, API_KEY);

    expect(result).toEqual({ ok: false, reason: 'gemini responded with 429' });
  });

  it('fails closed via zod rejection when the response shape is unrecognizable, rather than crashing', async () => {
    // `candidates` is fully optional in the schema, so a shape with no
    // `candidates` key at all would still parse (and just produce empty
    // text) — use a shape where `candidates` exists but violates the schema
    // instead, to actually exercise the rejection path.
    mockFetchJson({ candidates: 'not-an-array' });

    const result = await generateGeminiDraft(PROMPT, API_KEY);

    expect(result).toEqual({ ok: false, reason: 'gemini response did not match the expected shape' });
  });

  it('fails closed when the response has no text content that parses into SUBJECT:/BODY: format', async () => {
    mockFetchJson(geminiSuccessBody('I cannot help with that request.'));

    const result = await generateGeminiDraft(PROMPT, API_KEY);

    expect(result).toEqual({ ok: false, reason: 'gemini response did not follow the SUBJECT:/BODY: format' });
  });

  it('fails closed instead of throwing when the fetch call itself throws (network failure)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const result = await generateGeminiDraft(PROMPT, API_KEY);

    expect(result).toEqual({ ok: false, reason: 'gemini request failed (ECONNREFUSED)' });
  });

  it('fails closed instead of throwing when the response body is not valid JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.reject(new Error('Unexpected token')),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await generateGeminiDraft(PROMPT, API_KEY);

    expect(result.ok).toBe(false);
  });
});
