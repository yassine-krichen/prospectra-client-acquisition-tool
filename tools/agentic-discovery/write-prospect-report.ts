import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { DiscoveryTrack } from './prompt-template';
import type { AgenticProspectLine } from './prospect-line.schema';

// Reports default to the repo's gitignored outreach/ folder because the
// voreon ones hold contact emails. The khalid handoff usually belongs next to
// his client projects: point KHALID_PROSPECTS_DIR (or --out) there instead of
// hardcoding a machine-specific path in the repo.
const DEFAULT_REPORT_DIR = join(process.cwd(), 'outreach');
export const KHALID_DIR_ENV_VAR = 'KHALID_PROSPECTS_DIR';

export interface ProspectReportInput {
  track: DiscoveryTrack;
  category: string;
  geography: string;
  lines: AgenticProspectLine[];
  /** Explicit output directory (the --out flag); wins over the env var. */
  outDir?: string;
}

/** --out, then KHALID_PROSPECTS_DIR (khalid track only), then outreach/. */
export function resolveReportDir(track: DiscoveryTrack, outDir?: string): string {
  if (outDir) return outDir;
  const fromEnv = process.env[KHALID_DIR_ENV_VAR];
  if (track === 'khalid' && fromEnv) return fromEnv;
  return DEFAULT_REPORT_DIR;
}

/** Category is agent/CLI-supplied text: reduce it to [a-z0-9-] so it can
 * never inject path separators or odd characters into the filename. */
export function buildReportFileName(track: DiscoveryTrack, category: string, stamp: string): string {
  return `${track}-${category.replace(/\W+/g, '-').toLowerCase()}-${stamp}.md`;
}

function formatProspect(line: AgenticProspectLine, track: DiscoveryTrack): string {
  const where = [line.address, line.city].filter(Boolean).join(', ') || 'address unknown';
  const parts = [
    `### ${line.companyName}`,
    `- Site: ${line.websiteUrl ?? 'none found'} | Phone: ${line.phone ?? '-'} | ${where}`,
    `- Signal (${line.signalStrength} ${line.signalType}): ${line.signalDescription}`,
    `- Evidence: ${line.evidenceUrl}`,
    `- Pitch: ${line.pitchAngle ?? '-'}`,
  ];
  if (track === 'voreon') {
    const who = [line.contactName, line.contactRole].filter(Boolean).join(', ') || 'no named contact';
    const email = line.contactEmail ? `${line.contactEmail} (${line.emailSource})` : 'NOT FOUND - look manually';
    parts.push(`- Contact: ${who} | ${email} | form: ${line.contactPageUrl ?? '-'}`);
  }
  return parts.join('\n');
}

/** Writes a dated markdown handoff for one run and returns its path. */
export function writeProspectReport({ track, category, geography, lines, outDir }: ProspectReportInput): string {
  const dir = resolveReportDir(track, outDir);
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const path = join(dir, buildReportFileName(track, category, stamp));
  const body = [
    `# ${track} prospects: ${category} / ${geography}`,
    `${lines.length} prospects, ${new Date().toISOString().slice(0, 10)}.`,
    ...lines.map((line) => formatProspect(line, track)),
  ].join('\n\n');
  writeFileSync(path, `${body}\n`);
  return path;
}
