import 'dotenv/config';

import { prisma } from '@/common/db/client';
import { dedupeProspects, persistProspect } from '@/features/discovery/discovery.service';
import type { DiscoveredProspect, DiscoveryQuery } from '@/features/discovery/discovery.types';
import { pickDailyCategory } from '@/features/discovery/ny-target-categories';

import { runClaudeAgent } from './claude-cli';
import { mapToDiscoveredProspect } from './map-to-discovered-prospect';
import { agenticProspectLineSchema } from './prospect-line.schema';
import { buildDiscoveryPrompt } from './prompt-template';

const DEFAULT_GEOGRAPHY = 'New York, NY';
const DEFAULT_COUNT = 8;

interface InvalidLine {
  raw: string;
  error: string;
}

function parseArgs(argv: string[]): { category: string; geography: string; count: number } {
  const get = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index !== -1 ? argv[index + 1] : undefined;
  };

  const category = get('--category') ?? pickDailyCategory(new Date());
  const geography = get('--geography') ?? DEFAULT_GEOGRAPHY;
  const countArg = get('--count');
  const count = countArg ? Number.parseInt(countArg, 10) : DEFAULT_COUNT;

  return { category, geography, count: Number.isFinite(count) && count > 0 ? count : DEFAULT_COUNT };
}

async function main(): Promise<void> {
  const { category, geography, count } = parseArgs(process.argv.slice(2));
  const query: DiscoveryQuery = { category, geography };

  console.log(`Running agentic discovery for category="${category}" geography="${geography}" count=${count}...`);

  const prompt = buildDiscoveryPrompt({ category, geography, count });

  let rawOutput: string;
  try {
    rawOutput = await runClaudeAgent(prompt);
  } catch (error) {
    console.error('claude CLI run failed:', (error as Error).message);
    process.exit(1);
    return;
  }

  const lines = rawOutput
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const invalidLines: InvalidLine[] = [];
  const mappedProspects: DiscoveredProspect[] = [];

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

  await prisma.$disconnect();
}

main().catch(async (error: unknown) => {
  console.error('Agentic discovery run failed:', error);
  await prisma.$disconnect();
  process.exit(1);
});
