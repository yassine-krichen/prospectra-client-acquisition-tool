import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { agenticProspectLineSchema } from './prospect-line.schema';
import {
  buildReportFileName,
  KHALID_DIR_ENV_VAR,
  resolveReportDir,
  writeProspectReport,
} from './write-prospect-report';

const originalEnv = process.env[KHALID_DIR_ENV_VAR];

beforeEach(() => {
  delete process.env[KHALID_DIR_ENV_VAR];
});

afterEach(() => {
  if (originalEnv === undefined) delete process.env[KHALID_DIR_ENV_VAR];
  else process.env[KHALID_DIR_ENV_VAR] = originalEnv;
});

describe('resolveReportDir', () => {
  it('defaults both tracks to the repo-local outreach/ folder when nothing is configured', () => {
    expect(resolveReportDir('khalid')).toBe(join(process.cwd(), 'outreach'));
    expect(resolveReportDir('voreon')).toBe(join(process.cwd(), 'outreach'));
  });

  it('uses KHALID_PROSPECTS_DIR for the khalid track only', () => {
    process.env[KHALID_DIR_ENV_VAR] = '/tmp/khalid-prospects';

    expect(resolveReportDir('khalid')).toBe('/tmp/khalid-prospects');
    expect(resolveReportDir('voreon')).toBe(join(process.cwd(), 'outreach'));
  });

  it('lets an explicit --out directory win over the env var', () => {
    process.env[KHALID_DIR_ENV_VAR] = '/tmp/khalid-prospects';

    expect(resolveReportDir('khalid', '/tmp/explicit')).toBe('/tmp/explicit');
  });
});

describe('buildReportFileName', () => {
  it('strips path separators and punctuation from the category so it cannot escape the report directory', () => {
    const name = buildReportFileName('voreon', '../../Law Firms & "Co"', '2026-10-20-09-00');

    expect(name).toBe('voreon--law-firms-co--2026-10-20-09-00.md');
    expect(name).not.toMatch(/[\/]/);
  });
});

describe('writeProspectReport', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'prospect-report-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes the report into the requested directory, including contact info for the voreon track', () => {
    const line = agenticProspectLineSchema.parse({
      companyName: 'Acme Dental',
      domain: 'acme.example',
      websiteUrl: 'https://acme.example',
      industry: 'local_service',
      companySize: '11-50',
      city: 'Brooklyn',
      country: 'US',
      phone: null,
      address: null,
      signalType: 'outdated_site',
      signalStrength: 'strong',
      signalDescription: 'Site last updated in 2014',
      evidenceUrl: 'https://acme.example/about',
      evidenceSummary: 'Footer says 2014',
      secondarySignal: null,
      contactEmail: 'jane@acme.example',
      emailSource: 'published',
    });

    const path = writeProspectReport({ track: 'voreon', category: 'dental', geography: 'NY', lines: [line], outDir: dir });

    expect(path.startsWith(dir)).toBe(true);
    const content = readFileSync(path, 'utf8');
    expect(content).toContain('### Acme Dental');
    expect(content).toContain('jane@acme.example (published)');
  });
});
