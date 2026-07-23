export interface ParsedDraftOutput {
  subject: string;
  body: string;
}

/**
 * Parses a model's raw text completion into a subject+body pair, per the
 * `SUBJECT: ...` / `BODY: ...` format requested in prompt-templates.ts.
 * Deliberately tolerant of minor formatting drift (leading/trailing
 * whitespace, the body spanning one escaped-`\n` line or several real
 * lines, extra text before/after) rather than requiring an exact match —
 * models don't always follow instructions to the letter. Returns `null`
 * (rather than throwing) when either field can't be found at all, which
 * both provider clients treat as a generation failure.
 */
export function parseDraftOutput(raw: string): ParsedDraftOutput | null {
  const subjectMatch = raw.match(/subject:\s*(.+)/i);
  const bodyMatch = raw.match(/body:\s*([\s\S]+)/i);
  if (!subjectMatch || !bodyMatch) return null;

  const subject = subjectMatch[1].trim();
  const body = bodyMatch[1].trim().replace(/\\n/g, '\n');
  if (!subject || !body) return null;

  return { subject, body };
}
