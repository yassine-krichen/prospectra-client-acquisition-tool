import 'dotenv/config';

import { prisma } from '@/common/db/client';
import { dedupeProspects, persistProspect } from '@/features/discovery/discovery.service';
import type { DiscoveredProspect, DiscoveryQuery } from '@/features/discovery/discovery.types';
import { pickDailyCategory } from '@/features/discovery/ny-target-categories';

import { runClaudeAgent } from './claude-cli';
import type { AgenticProspectLine } from './prospect-line.schema';
import { mapToDiscoveredProspect } from './map-to-discovered-prospect';
import { agenticProspectLineSchema } from './prospect-line.schema';
import { buildDiscoveryPrompt, type DiscoveryTrack } from './prompt-template';
import { writeProspectReport } from './write-prospect-report';

const DEFAULT_GEOGRAPHY = 'New York, NY';
const DEFAULT_COUNT = 8;

interface InvalidLine {
  raw: string;
  error: string;
}

interface ParsedArgs {
  category: string;
  geography: string;
  count: number;
  preference?: string;
  track?: DiscoveryTrack;
  outDir?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  // A flag as the last arg (or followed by another flag) is an error rather
  // than a silent fall-back to the default: a typo'd run would otherwise
  // quietly use the wrong track/preference.
  const get = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    if (index === -1) return undefined;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${flag} requires a value`);
    }
    return value;
  };

  const category = get('--category') ?? pickDailyCategory(new Date());
  const geography = get('--geography') ?? DEFAULT_GEOGRAPHY;
  const countArg = get('--count');
  if (countArg !== undefined && !/^[1-9]\d*$/.test(countArg)) {
    throw new Error(`--count must be a positive integer, got "${countArg}"`);
  }
  const count = countArg !== undefined ? Number.parseInt(countArg, 10) : DEFAULT_COUNT;
  const preference = get('--preference');
  const trackArg = get('--track');
  if (trackArg !== undefined && trackArg !== 'khalid' && trackArg !== 'voreon') {
    throw new Error(`--track must be "khalid" or "voreon", got "${trackArg}"`);
  }

  return { category, geography, count, preference, track: trackArg, outDir: get('--out') };
}

async function main(): Promise<void> {
  const { category, geography, count, preference, track, outDir } = parseArgs(process.argv.slice(2));
  const query: DiscoveryQuery = { category, geography };

  console.log(`Running agentic discovery for category="${category}" geography="${geography}" count=${count}...`);

  const prompt = buildDiscoveryPrompt({ category, geography, count, preference, track });

  let rawOutput: string;
  try {
    rawOutput = await runClaudeAgent(prompt);
  } catch (error) {
    // Rethrown (not process.exit) so the .finally below still disconnects prisma.
    throw new Error(`claude CLI run failed: ${(error as Error).message}`);
  }

  const lines = rawOutput
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const invalidLines: InvalidLine[] = [];
  const mappedProspects: DiscoveredProspect[] = [];
  const validLines: AgenticProspectLine[] = [];

  for (const line of lines) {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(line);
    } catch (error) {
      invalidLines.push({ raw: line, error: `JSON parse error: ${(error as Error).message}` });
      continue;
    }

    const result = agenticProspectLineSchema.safeParse(parsedJson);
    if (!result.success) {
      invalidLines.push({ raw: line, error: `Schema validation error: ${result.error.message}` });
      continue;
    }

    validLines.push(result.data);
    mappedProspects.push(mapToDiscoveredProspect(result.data));
  }

  const deduped = dedupeProspects(mappedProspects);

  let inserted = 0;
  let updated = 0;
  let skippedDoNotContact = 0;
  for (const prospect of deduped) {
    const outcome = await persistProspect(prospect, query);
    if (outcome === 'inserted') inserted += 1;
    else if (outcome === 'updated') updated += 1;
    else skippedDoNotContact += 1;
  }

  console.log('\n--- Agentic discovery summary ---');
  console.log(`Found by agent (lines): ${lines.length}`);
  console.log(`Valid lines: ${mappedProspects.length}`);
  console.log(`Invalid lines: ${invalidLines.length}`);
  for (const invalid of invalidLines) {
    console.log(`  - ${invalid.error}\n    raw: ${invalid.raw}`);
  }
  console.log(`Deduped within batch: ${deduped.length}`);
  console.log(`Inserted: ${inserted}`);
  console.log(`Updated: ${updated}`);
  console.log(`Skipped (do not contact): ${skippedDoNotContact}`);

  if (track) {
    const reportPath = writeProspectReport({ track, category, geography, lines: validLines, outDir });
    console.log(`Report written: ${reportPath}`);
  }
}

main()
  .catch((error: unknown) => {
    console.error('Agentic discovery run failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    // Always release the DB connection, whether the run or the report write threw.
    await prisma.$disconnect();
  });
