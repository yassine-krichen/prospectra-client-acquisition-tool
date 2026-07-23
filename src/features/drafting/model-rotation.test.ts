import { beforeEach, describe, expect, it, vi } from 'vitest';

// Rotation state (key indices, which provider is tried first) is mutable
// module-level state by design (see model-rotation.ts's own doc comment), so
// each test that cares about a clean starting point re-imports the module
// after `vi.resetModules()` with the env it needs already configured.
const envMock: { GEMINI_API_KEY: string | undefined; GROQ_API_KEY: string | undefined } = {
  GEMINI_API_KEY: undefined,
  GROQ_API_KEY: undefined,
};
vi.mock('@/common/config/env', () => ({ env: envMock }));

const generateGeminiDraftMock = vi.fn();
vi.mock('@/features/drafting/gemini.client', () => ({ generateGeminiDraft: generateGeminiDraftMock }));

const generateGroqDraftMock = vi.fn();
vi.mock('@/features/drafting/groq.client', () => ({ generateGroqDraft: generateGroqDraftMock }));

async function loadRotationWithKeys(
  gemini: string | undefined,
  groq: string | undefined
): Promise<typeof import('./model-rotation')> {
  envMock.GEMINI_API_KEY = gemini;
  envMock.GROQ_API_KEY = groq;
  vi.resetModules();
  return import('./model-rotation');
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('generateDraftWithRotation', () => {
  it('returns the gemini result and never calls groq when gemini succeeds on the first attempt', async () => {
    const { generateDraftWithRotation } = await loadRotationWithKeys('gemini-key', 'groq-key');
    generateGeminiDraftMock.mockResolvedValue({ ok: true, subject: 'Subj', body: 'Body' });

    const result = await generateDraftWithRotation('prompt');

    expect(result).toEqual({ ok: true, subject: 'Subj', body: 'Body', modelUsed: 'gemini' });
    expect(generateGroqDraftMock).not.toHaveBeenCalled();
  });

  it('falls over to groq when gemini has no API key configured at all', async () => {
    const { generateDraftWithRotation } = await loadRotationWithKeys(undefined, 'groq-key');
    generateGroqDraftMock.mockResolvedValue({ ok: true, subject: 'Subj', body: 'Body' });

    const result = await generateDraftWithRotation('prompt');

    expect(result).toEqual({ ok: true, subject: 'Subj', body: 'Body', modelUsed: 'groq' });
    expect(generateGeminiDraftMock).not.toHaveBeenCalled();
  });

  it('falls over to groq when gemini is configured but its call reports failure', async () => {
    const { generateDraftWithRotation } = await loadRotationWithKeys('gemini-key', 'groq-key');
    generateGeminiDraftMock.mockResolvedValue({ ok: false, reason: 'gemini responded with 500' });
    generateGroqDraftMock.mockResolvedValue({ ok: true, subject: 'Subj', body: 'Body' });

    const result = await generateDraftWithRotation('prompt');

    expect(result).toEqual({ ok: true, subject: 'Subj', body: 'Body', modelUsed: 'groq' });
    expect(generateGeminiDraftMock).toHaveBeenCalled();
    expect(generateGroqDraftMock).toHaveBeenCalled();
  });

  it('returns a typed failure, without throwing, when neither provider has an API key configured', async () => {
    const { generateDraftWithRotation } = await loadRotationWithKeys(undefined, undefined);

    const result = await generateDraftWithRotation('prompt');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a failure result');
    expect(result.reason).toContain('gemini: not configured');
    expect(result.reason).toContain('groq: not configured');
    expect(generateGeminiDraftMock).not.toHaveBeenCalled();
    expect(generateGroqDraftMock).not.toHaveBeenCalled();
  });

  it('returns a typed failure, without throwing, when both providers are configured but both calls fail', async () => {
    const { generateDraftWithRotation } = await loadRotationWithKeys('gemini-key', 'groq-key');
    generateGeminiDraftMock.mockResolvedValue({ ok: false, reason: 'gemini responded with 500' });
    generateGroqDraftMock.mockResolvedValue({ ok: false, reason: 'groq responded with 500' });

    const result = await generateDraftWithRotation('prompt');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a failure result');
    expect(result.reason).toContain('gemini: gemini responded with 500');
    expect(result.reason).toContain('groq: groq responded with 500');
  });

  it('rotates across comma-separated keys for a single provider rather than always reusing the first key', async () => {
    const { generateDraftWithRotation } = await loadRotationWithKeys('key-one,key-two', undefined);
    generateGeminiDraftMock.mockResolvedValue({ ok: true, subject: 'Subj', body: 'Body' });

    await generateDraftWithRotation('prompt');
    await generateDraftWithRotation('prompt');

    const [, firstKeyUsed] = generateGeminiDraftMock.mock.calls[0] as [string, string];
    const [, secondKeyUsed] = generateGeminiDraftMock.mock.calls[1] as [string, string];
    expect(firstKeyUsed).toBe('key-one');
    expect(secondKeyUsed).toBe('key-two');
  });

  it('rotates which provider is tried first across successive calls, spreading load across both providers', async () => {
    const { generateDraftWithRotation } = await loadRotationWithKeys('gemini-key', 'groq-key');
    generateGeminiDraftMock.mockResolvedValue({ ok: true, subject: 'Subj', body: 'Body' });
    generateGroqDraftMock.mockResolvedValue({ ok: true, subject: 'Subj', body: 'Body' });

    const first = await generateDraftWithRotation('prompt');
    const second = await generateDraftWithRotation('prompt');

    expect(first.ok && first.modelUsed).toBe('gemini');
    expect(second.ok && second.modelUsed).toBe('groq');
  });
});
