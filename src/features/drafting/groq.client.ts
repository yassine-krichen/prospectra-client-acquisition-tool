import { z } from 'zod';

import { parseDraftOutput } from '@/features/drafting/parse-draft-output';
import type { DraftGenerationResult } from '@/features/drafting/drafting.types';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'openai/gpt-oss-20b';

// Groq's API is OpenAI-chat-completions-compatible. Minimal subset of that
// response shape this client relies on.
const groqResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string().nullable().optional() }).optional(),
      })
    )
    .optional(),
});

/**
 * Generates one subject+body draft via Groq's OpenAI-compatible chat
 * completions API for an already-selected `apiKey` (key selection/rotation
 * across a comma-separated `GROQ_API_KEY` list, and failover to Gemini, are
 * model-rotation.ts's job - this client only knows how to make one call).
 * Never throws: a failed request, non-2xx response, shape mismatch, or
 * output that doesn't parse into the SUBJECT:/BODY: format all degrade to a
 * typed `ok:false` result instead.
 */
export async function generateGroqDraft(prompt: string, apiKey: string): Promise<DraftGenerationResult> {
  let response: Response;
  try {
    response = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
  } catch (error) {
    return { ok: false, reason: `groq request failed (${(error as Error).message})` };
  }

  if (!response.ok) {
    return { ok: false, reason: `groq responded with ${response.status}` };
  }

  const parsed = groqResponseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    return { ok: false, reason: 'groq response did not match the expected shape' };
  }

  const text = parsed.data.choices?.[0]?.message?.content ?? '';
  const draft = parseDraftOutput(text);
  if (!draft) {
    return { ok: false, reason: 'groq response did not follow the SUBJECT:/BODY: format' };
  }

  return { ok: true, subject: draft.subject, body: draft.body };
}
