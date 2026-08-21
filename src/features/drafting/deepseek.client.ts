import { z } from 'zod';

import { parseDraftOutput } from '@/features/drafting/parse-draft-output';
import type { DraftGenerationResult } from '@/features/drafting/drafting.types';

// DeepSeek's API is OpenAI-chat-completions-compatible, served from
// api.deepseek.com (not an /v1/ path, per DeepSeek's own docs - unlike
// Groq/OpenAI's URL convention). `deepseek-chat` is DeepSeek's general-
// purpose chat model, the free-tier-appropriate default (as opposed to
// `deepseek-reasoner`, which is unnecessary for short cold-email drafts).
const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const DEEPSEEK_MODEL = 'deepseek-chat';

// Minimal subset of the OpenAI-compatible chat completions response shape
// this client relies on - identical shape to Groq's.
const deepseekResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string().nullable().optional() }).optional(),
      })
    )
    .optional(),
});

/**
 * Generates one subject+body draft via DeepSeek's OpenAI-compatible chat
 * completions API for an already-selected `apiKey` (key selection/rotation
 * across a comma-separated `DEEPSEEK_API_KEY` list, and failover to other
 * providers, are model-rotation.ts's job - this client only knows how to
 * make one call). Never throws: a failed request, non-2xx response, shape
 * mismatch, or output that doesn't parse into the SUBJECT:/BODY: format all
 * degrade to a typed `ok:false` result instead.
 */
export async function generateDeepseekDraft(prompt: string, apiKey: string): Promise<DraftGenerationResult> {
  let response: Response;
  try {
    response = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
  } catch (error) {
    return { ok: false, reason: `deepseek request failed (${(error as Error).message})` };
  }

  if (!response.ok) {
    return { ok: false, reason: `deepseek responded with ${response.status}` };
  }

  const parsed = deepseekResponseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    return { ok: false, reason: 'deepseek response did not match the expected shape' };
  }

  const text = parsed.data.choices?.[0]?.message?.content ?? '';
  const draft = parseDraftOutput(text);
  if (!draft) {
    return { ok: false, reason: 'deepseek response did not follow the SUBJECT:/BODY: format' };
  }

  return { ok: true, subject: draft.subject, body: draft.body };
}
