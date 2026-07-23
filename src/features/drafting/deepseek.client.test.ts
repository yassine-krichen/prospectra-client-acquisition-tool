import { afterEach, describe, expect, it, vi } from 'vitest';

import { generateDeepseekDraft } from './deepseek.client';

const PROMPT = 'write me a cold email';
const API_KEY = 'test-deepseek-key';

function mockFetchJson(body: unknown, options: { ok?: boolean; status?: number } = {}): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: options.ok ?? true,
    status: options.status ?? 200,
    json: () => Promise.resolve(body),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function deepseekSuccessBody(content: string): unknown {
  return { choices: [{ message: { content } }] };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('generateDeepseekDraft', () => {
  it('calls the DeepSeek chat completions endpoint with a bearer-token Authorization header', async () => {
    const fetchMock = mockFetchJson(deepseekSuccessBody('SUBJECT: Hi\nBODY: A short valid body.'));

    await generateDeepseekDraft(PROMPT, API_KEY);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${API_KEY}`);
  });

  it('returns the parsed subject and body on a well-formed successful response', async () => {
    mockFetchJson(deepseekSuccessBody('SUBJECT: Quick idea\nBODY: Worth a quick chat?'));

    const result = await generateDeepseekDraft(PROMPT, API_KEY);

    expect(result).toEqual({ ok: true, subject: 'Quick idea', body: 'Worth a quick chat?' });
  });

  it('fails closed with a typed result, without throwing, on a non-2xx response', async () => {
    mockFetchJson({}, { ok: false, status: 429 });

    const result = await generateDeepseekDraft(PROMPT, API_KEY);

    expect(result).toEqual({ ok: false, reason: 'deepseek responded with 429' });
  });

  it('fails closed via zod rejection when the response shape is unrecognizable, rather than crashing', async () => {
    mockFetchJson({ choices: 'not-an-array' });

    const result = await generateDeepseekDraft(PROMPT, API_KEY);

    expect(result).toEqual({ ok: false, reason: 'deepseek response did not match the expected shape' });
  });

  it('fails closed when message content is null, since a real completion always has string content', async () => {
    mockFetchJson({ choices: [{ message: { content: null } }] });

    const result = await generateDeepseekDraft(PROMPT, API_KEY);

    expect(result).toEqual({ ok: false, reason: 'deepseek response did not follow the SUBJECT:/BODY: format' });
  });

  it('fails closed when the response has no content that parses into SUBJECT:/BODY: format', async () => {
    mockFetchJson(deepseekSuccessBody('I cannot help with that request.'));

    const result = await generateDeepseekDraft(PROMPT, API_KEY);

    expect(result).toEqual({ ok: false, reason: 'deepseek response did not follow the SUBJECT:/BODY: format' });
  });

  it('fails closed instead of throwing when the fetch call itself throws (network failure)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const result = await generateDeepseekDraft(PROMPT, API_KEY);

    expect(result).toEqual({ ok: false, reason: 'deepseek request failed (ECONNREFUSED)' });
  });

  it('fails closed instead of throwing when the response body is not valid JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.reject(new Error('Unexpected token')),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await generateDeepseekDraft(PROMPT, API_KEY);

    expect(result.ok).toBe(false);
  });
});
