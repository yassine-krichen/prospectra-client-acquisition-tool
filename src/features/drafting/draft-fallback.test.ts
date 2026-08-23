import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// generateDraftWithFallback (model-rotation.ts) composes:
// - generateDraftWithRotation (the Gemini/Groq pool - DeepSeek was dropped
//   2026-08-23, the one provider with no enforced cost cap) - exercised via
//   the real registry, with each provider client mocked (same convention as
//   model-rotation.test.ts).
// - claude-bridge.client.ts's generateDraft (the tier-2 fallback) and
//   bridge-budget.ts's isBridgeInCooldown - both mocked here, since this
//   suite is only about the fallback orchestration, not the bridge client's
//   own HTTP/parsing behavior (covered by claude-bridge.client.test.ts) or
//   the cooldown record's own persistence (covered by bridge-budget.test.ts).
const envMock: {
  GEMINI_API_KEY: string | undefined;
  GROQ_API_KEY: string | undefined;
} = {
  GEMINI_API_KEY: undefined,
  GROQ_API_KEY: undefined,
};
vi.mock('@/common/config/env', () => ({ env: envMock }));

const generateGeminiDraftMock = vi.fn();
vi.mock('@/features/drafting/gemini.client', () => ({ generateGeminiDraft: generateGeminiDraftMock }));

const generateGroqDraftMock = vi.fn();
vi.mock('@/features/drafting/groq.client', () => ({ generateGroqDraft: generateGroqDraftMock }));

const generateBridgeDraftMock = vi.fn();
vi.mock('@/features/drafting/claude-bridge.client', () => ({ generateDraft: generateBridgeDraftMock }));

const isBridgeInCooldownMock = vi.fn();
vi.mock('@/features/drafting/bridge-budget', () => ({ isBridgeInCooldown: isBridgeInCooldownMock }));

async function loadWithAllProvidersExhausted(): Promise<typeof import('./model-rotation')> {
  envMock.GEMINI_API_KEY = 'gemini-key';
  envMock.GROQ_API_KEY = 'groq-key';
  generateGeminiDraftMock.mockResolvedValue({ ok: false, reason: 'gemini responded with 500' });
  generateGroqDraftMock.mockResolvedValue({ ok: false, reason: 'groq responded with 500' });
  vi.resetModules();
  return import('./model-rotation');
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('generateDraftWithFallback', () => {
  it('returns the primary pool result immediately without touching the bridge when it succeeds', async () => {
    envMock.GEMINI_API_KEY = 'gemini-key';
    envMock.GROQ_API_KEY = undefined;
    generateGeminiDraftMock.mockResolvedValue({ ok: true, subject: 'Subj', body: 'Body' });
    vi.resetModules();
    const { generateDraftWithFallback } = await import('./model-rotation');

    const result = await generateDraftWithFallback('prompt', { isHighPriority: true });

    expect(result).toEqual({ ok: true, subject: 'Subj', body: 'Body', modelUsed: 'gemini' });
    expect(isBridgeInCooldownMock).not.toHaveBeenCalled();
    expect(generateBridgeDraftMock).not.toHaveBeenCalled();
  });

  it('tries the bridge and succeeds when the primary pool is exhausted, priority is high, and the bridge is clear', async () => {
    const { generateDraftWithFallback } = await loadWithAllProvidersExhausted();
    isBridgeInCooldownMock.mockResolvedValue(false);
    generateBridgeDraftMock.mockResolvedValue({ ok: true, subject: 'Bridge Subj', body: 'Bridge Body' });

    const result = await generateDraftWithFallback('prompt', { isHighPriority: true });

    expect(result).toEqual({ ok: true, subject: 'Bridge Subj', body: 'Bridge Body', modelUsed: 'claude-bridge' });
    expect(generateBridgeDraftMock).toHaveBeenCalledWith('prompt');
  });

  it('reports both lanes failure reasons when the bridge fallback attempt also fails', async () => {
    const { generateDraftWithFallback } = await loadWithAllProvidersExhausted();
    isBridgeInCooldownMock.mockResolvedValue(false);
    generateBridgeDraftMock.mockResolvedValue({ ok: false, reason: 'claude-bridge rate limit reached' });

    const result = await generateDraftWithFallback('prompt', { isHighPriority: true });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a failure result');
    expect(result.reason).toContain('gemini: gemini responded with 500');
    expect(result.reason).toContain('claude-bridge fallback also failed: claude-bridge rate limit reached');
  });

  it('never touches the bridge for a low-priority prospect, even when the whole pool is exhausted', async () => {
    const { generateDraftWithFallback } = await loadWithAllProvidersExhausted();

    const result = await generateDraftWithFallback('prompt', { isHighPriority: false });

    expect(result.ok).toBe(false);
    expect(isBridgeInCooldownMock).not.toHaveBeenCalled();
    expect(generateBridgeDraftMock).not.toHaveBeenCalled();
  });

  it('skips the bridge attempt entirely, returning the original failure, when the bridge is already in cooldown', async () => {
    const { generateDraftWithFallback } = await loadWithAllProvidersExhausted();
    isBridgeInCooldownMock.mockResolvedValue(true);

    const result = await generateDraftWithFallback('prompt', { isHighPriority: true });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a failure result');
    expect(result.reason).not.toContain('claude-bridge fallback also failed');
    expect(generateBridgeDraftMock).not.toHaveBeenCalled();
  });
});
