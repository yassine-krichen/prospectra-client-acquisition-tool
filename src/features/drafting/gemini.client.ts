import { z } from 'zod';

import { parseDraftOutput } from '@/features/drafting/parse-draft-output';
import type { DraftGenerationResult } from '@/features/drafting/drafting.types';

const GEMINI_MODEL = 'gemini-3.6-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// Minimal subset of Gemini's generateContent response shape this client
// relies on. See https://ai.google.dev/api/generate-content for the full
// shape.
const geminiResponseSchema = z.object({
  candidates: z
    .array(
      z.object({
        content: z
          .object({
            parts: z.array(z.object({ text: z.string().optional() })).optional(),
          })
          .optional(),
      })
    )
    .optional(),
});

/**
 * Generates one subject+body draft via Google's Gemini API for an
 * already-selected `apiKey` (key selection/rotation across a
 * comma-separated `GEMINI_API_KEY` list, and failover to Groq, are
 * model-rotation.ts's job - this client only knows how to make one call).
 * Never throws: a failed request, non-2xx response, shape mismatch, or
 * output that doesn't parse into the SUBJECT:/BODY: format all degrade to a
 * typed `ok:false` result instead.
 */
export async function generateGeminiDraft(prompt: string, apiKey: string): Promise<DraftGenerationResult> {
  const url = new URL(GEMINI_URL);
  url.searchParams.set('key', apiKey);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    });
  } catch (error) {
    return { ok: false, reason: `gemini request failed (${(error as Error).message})` };
  }

  if (!response.ok) {
    return { ok: false, reason: `gemini responded with ${response.status}` };
  }

  const parsed = geminiResponseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    return { ok: false, reason: 'gemini response did not match the expected shape' };
  }

  const text = (parsed.data.candidates?.[0]?.content?.parts ?? []).map((part) => part.text ?? '').join('');
  const draft = parseDraftOutput(text);
  if (!draft) {
    return { ok: false, reason: 'gemini response did not follow the SUBJECT:/BODY: format' };
  }

  return { ok: true, subject: draft.subject, body: draft.body };
}
