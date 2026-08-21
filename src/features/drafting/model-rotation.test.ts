import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The registry reads keys straight from `env` at call time (no module-level
// rotation-index state to reset - that's the whole point of this redesign),
// so each test just sets the env mock it needs before importing/using the
// module. `vi.resetModules()` still runs between tests for isolation.
const envMock: {
  GEMINI_API_KEY: string | undefined;
  GROQ_API_KEY: string | undefined;
  DEEPSEEK_API_KEY: string | undefined;
} = {
  GEMINI_API_KEY: undefined,
  GROQ_API_KEY: undefined,
  DEEPSEEK_API_KEY: undefined,
};
vi.mock('@/common/config/env', () => ({ env: envMock }));

const generateGeminiDraftMock = vi.fn();
vi.mock('@/features/drafting/gemini.client', () => ({ generateGeminiDraft: generateGeminiDraftMock }));

const generateGroqDraftMock = vi.fn();
vi.mock('@/features/drafting/groq.client', () => ({ generateGroqDraft: generateGroqDraftMock }));

const generateDeepseekDraftMock = vi.fn();
vi.mock('@/features/drafting/deepseek.client', () => ({ generateDeepseekDraft: generateDeepseekDraftMock }));

async function loadRotationWithKeys(
  gemini: string | undefined,
  groq: string | undefined,
  deepseek: string | undefined
): Promise<typeof import('./model-rotation')> {
  envMock.GEMINI_API_KEY = gemini;
  envMock.GROQ_API_KEY = groq;
  envMock.DEEPSEEK_API_KEY = deepseek;
  vi.resetModules();
  return import('./model-rotation');
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('generateDraftWithRotation', () => {
  it('picks the provider Math.random selects among all configured providers and returns its result', async () => {
    const { generateDraftWithRotation } = await loadRotationWithKeys('gemini-key', 'groq-key', 'deepseek-key');
    // 3 configured candidates in registry order [gemini, groq, deepseek];
    // floor(0 * 3) = 0 always selects the first remaining candidate, and
    // floor(0 * keys.length) always selects the first key.
    vi.spyOn(Math, 'random').mockReturnValue(0);
    generateGeminiDraftMock.mockResolvedValue({ ok: true, subject: 'Subj', body: 'Body' });

    const result = await generateDraftWithRotation('prompt');

    expect(result).toEqual({ ok: true, subject: 'Subj', body: 'Body', modelUsed: 'gemini' });
    expect(generateGroqDraftMock).not.toHaveBeenCalled();
    expect(generateDeepseekDraftMock).not.toHaveBeenCalled();
  });

  it('excludes providers with no API key configured from the candidate pool entirely', async () => {
    const { generateDraftWithRotation } = await loadRotationWithKeys(undefined, 'groq-key', undefined);
    vi.spyOn(Math, 'random').mockReturnValue(0);
    generateGroqDraftMock.mockResolvedValue({ ok: true, subject: 'Subj', body: 'Body' });

    const result = await generateDraftWithRotation('prompt');

    expect(result).toEqual({ ok: true, subject: 'Subj', body: 'Body', modelUsed: 'groq' });
    expect(generateGeminiDraftMock).not.toHaveBeenCalled();
    expect(generateDeepseekDraftMock).not.toHaveBeenCalled();
  });

  it('fails over to another configured provider when the randomly-selected one errors', async () => {
    const { generateDraftWithRotation } = await loadRotationWithKeys('gemini-key', 'groq-key', 'deepseek-key');
    // Always picks index 0 of whatever candidates remain: gemini first
    // (fails), then groq (the new index 0 once gemini is dropped).
    vi.spyOn(Math, 'random').mockReturnValue(0);
    generateGeminiDraftMock.mockResolvedValue({ ok: false, reason: 'gemini responded with 500' });
    generateGroqDraftMock.mockResolvedValue({ ok: true, subject: 'Subj', body: 'Body' });

    const result = await generateDraftWithRotation('prompt');

    expect(result).toEqual({ ok: true, subject: 'Subj', body: 'Body', modelUsed: 'groq' });
    expect(generateGeminiDraftMock).toHaveBeenCalled();
    expect(generateGroqDraftMock).toHaveBeenCalled();
    expect(generateDeepseekDraftMock).not.toHaveBeenCalled();
  });

  it('returns a typed failure, without throwing, when no provider has an API key configured', async () => {
    const { generateDraftWithRotation } = await loadRotationWithKeys(undefined, undefined, undefined);

    const result = await generateDraftWithRotation('prompt');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a failure result');
    expect(result.reason).toContain('gemini: not configured');
    expect(result.reason).toContain('groq: not configured');
    expect(result.reason).toContain('deepseek: not configured');
    expect(generateGeminiDraftMock).not.toHaveBeenCalled();
    expect(generateGroqDraftMock).not.toHaveBeenCalled();
    expect(generateDeepseekDraftMock).not.toHaveBeenCalled();
  });

  it('returns a typed failure, without throwing, once every configured provider has been tried and failed', async () => {
    const { generateDraftWithRotation } = await loadRotationWithKeys('gemini-key', 'groq-key', 'deepseek-key');
    vi.spyOn(Math, 'random').mockReturnValue(0);
    generateGeminiDraftMock.mockResolvedValue({ ok: false, reason: 'gemini responded with 500' });
    generateGroqDraftMock.mockResolvedValue({ ok: false, reason: 'groq responded with 500' });
    generateDeepseekDraftMock.mockResolvedValue({ ok: false, reason: 'deepseek responded with 500' });

    const result = await generateDraftWithRotation('prompt');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a failure result');
    expect(result.reason).toContain('gemini: gemini responded with 500');
    expect(result.reason).toContain('groq: groq responded with 500');
    expect(result.reason).toContain('deepseek: deepseek responded with 500');
    expect(generateGeminiDraftMock).toHaveBeenCalled();
    expect(generateGroqDraftMock).toHaveBeenCalled();
    expect(generateDeepseekDraftMock).toHaveBeenCalled();
  });

  it('picks across comma-separated keys for a single provider rather than always reusing the first key', async () => {
    const { generateDraftWithRotation } = await loadRotationWithKeys('key-one,key-two', undefined, undefined);
    generateGeminiDraftMock.mockResolvedValue({ ok: true, subject: 'Subj', body: 'Body' });
    const randomSpy = vi.spyOn(Math, 'random');

    // Only 1 configured provider, so the provider-selection call's value
    // never matters (floor(anything * 1) === 0); only the key-selection
    // call's value picks between the 2 keys.
    randomSpy.mockReturnValueOnce(0).mockReturnValueOnce(0); // provider pick, key pick -> key-one
    await generateDraftWithRotation('prompt');
    randomSpy.mockReturnValueOnce(0).mockReturnValueOnce(0.9); // provider pick, key pick -> key-two
    await generateDraftWithRotation('prompt');

    const [, firstKeyUsed] = generateGeminiDraftMock.mock.calls[0] as [string, string];
    const [, secondKeyUsed] = generateGeminiDraftMock.mock.calls[1] as [string, string];
    expect(firstKeyUsed).toBe('key-one');
    expect(secondKeyUsed).toBe('key-two');
  });

  it('spreads calls across every configured provider and key over enough volume (unmocked Math.random)', async () => {
    const { generateDraftWithRotation } = await loadRotationWithKeys('g1,g2', 'groq-key', 'deepseek-key');
    generateGeminiDraftMock.mockResolvedValue({ ok: true, subject: 'Subj', body: 'Body' });
    generateGroqDraftMock.mockResolvedValue({ ok: true, subject: 'Subj', body: 'Body' });
    generateDeepseekDraftMock.mockResolvedValue({ ok: true, subject: 'Subj', body: 'Body' });

    for (let i = 0; i < 200; i += 1) {
      await generateDraftWithRotation('prompt');
    }

    expect(generateGeminiDraftMock).toHaveBeenCalled();
    expect(generateGroqDraftMock).toHaveBeenCalled();
    expect(generateDeepseekDraftMock).toHaveBeenCalled();

    const geminiKeysUsed = new Set(generateGeminiDraftMock.mock.calls.map((call) => call[1]));
    expect(geminiKeysUsed).toEqual(new Set(['g1', 'g2']));
  });
});
