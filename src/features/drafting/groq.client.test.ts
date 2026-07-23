import { afterEach, describe, expect, it, vi } from 'vitest';

import { generateGroqDraft } from './groq.client';

const PROMPT = 'write me a cold email';
const API_KEY = 'test-groq-key';

function mockFetchJson(body: unknown, options: { ok?: boolean; status?: number } = {}): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: options.ok ?? true,
    status: options.status ?? 200,
    json: () => Promise.resolve(body),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function groqSuccessBody(content: string): unknown {
  return { choices: [{ message: { content } }] };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('generateGroqDraft', () => {
  it('calls the Groq chat completions endpoint with a bearer-token Authorization header', async () => {
    const fetchMock = mockFetchJson(groqSuccessBody('SUBJECT: Hi\nBODY: A short valid body.'));

    await generateGroqDraft(PROMPT, API_KEY);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${API_KEY}`);
  });

  it('returns the parsed subject and body on a well-formed successful response', async () => {
    mockFetchJson(groqSuccessBody('SUBJECT: Quick idea\nBODY: Worth a quick chat?'));

    const result = await generateGroqDraft(PROMPT, API_KEY);

    expect(result).toEqual({ ok: true, subject: 'Quick idea', body: 'Worth a quick chat?' });
  });

  it('fails closed with a typed result, without throwing, on a non-2xx response', async () => {
    mockFetchJson({}, { ok: false, status: 429 });

    const result = await generateGroqDraft(PROMPT, API_KEY);

    expect(result).toEqual({ ok: false, reason: 'groq responded with 429' });
  });

  it('fails closed via zod rejection when the response shape is unrecognizable, rather than crashing', async () => {
    mockFetchJson({ choices: 'not-an-array' });

    const result = await generateGroqDraft(PROMPT, API_KEY);

    expect(result).toEqual({ ok: false, reason: 'groq response did not match the expected shape' });
  });

  it('fails closed when message content is null, since a real completion always has string content', async () => {
    mockFetchJson({ choices: [{ message: { content: null } }] });

    const result = await generateGroqDraft(PROMPT, API_KEY);

    expect(result).toEqual({ ok: false, reason: 'groq response did not follow the SUBJECT:/BODY: format' });
  });

  it('fails closed when the response has no content that parses into SUBJECT:/BODY: format', async () => {
    mockFetchJson(groqSuccessBody('I cannot help with that request.'));

    const result = await generateGroqDraft(PROMPT, API_KEY);

    expect(result).toEqual({ ok: false, reason: 'groq response did not follow the SUBJECT:/BODY: format' });
  });

  it('fails closed instead of throwing when the fetch call itself throws (network failure)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const result = await generateGroqDraft(PROMPT, API_KEY);

    expect(result).toEqual({ ok: false, reason: 'groq request failed (ECONNREFUSED)' });
  });

  it('fails closed instead of throwing when the response body is not valid JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.reject(new Error('Unexpected token')),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await generateGroqDraft(PROMPT, API_KEY);

    expect(result.ok).toBe(false);
  });
});
