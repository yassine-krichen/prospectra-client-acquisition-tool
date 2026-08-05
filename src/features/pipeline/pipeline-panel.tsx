'use client';

import { useState } from 'react';
import { z } from 'zod';

import { Button } from '@/components/ui/button';

// Local, minimal response schemas — just enough to tally outcomes for
// display. Deliberately not importing the scheduler/service result types
// (drafting.service.ts, followup-scheduler.ts, retention-scheduler.ts are
// server-only and must never reach this `'use client'` file).
const draftBatchResponseSchema = z.object({
  drafted: z.array(z.object({ prospectId: z.string(), outcome: z.object({ ok: z.boolean() }) })),
  humanized: z.object({ attempted: z.number().int(), results: z.array(z.object({ outcome: z.string() })) }),
});

const outcomeResultSchema = z.object({ outcome: z.string() });
const outcomeListResponseSchema = z.object({ results: z.array(outcomeResultSchema) });

interface SectionState {
  isRunning: boolean;
  error: string | null;
  summary: string | null;
}

const INITIAL_STATE: SectionState = { isRunning: false, error: null, summary: null };

function tally(outcomes: string[]): string {
  const counts = new Map<string, number>();
  for (const outcome of outcomes) counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
  if (counts.size === 0) return 'Nothing to process.';
  return Array.from(counts.entries())
    .map(([outcome, count]) => `${outcome}: ${count}`)
    .join(', ');
}

function PipelineSection({
  title,
  description,
  buttonLabel,
  onRun,
}: {
  title: string;
  description: string;
  buttonLabel: string;
  onRun: () => Promise<string>;
}): React.JSX.Element {
  const [state, setState] = useState<SectionState>(INITIAL_STATE);

  async function handleClick(): Promise<void> {
    setState({ isRunning: true, error: null, summary: null });
    try {
      const summary = await onRun();
      setState({ isRunning: false, error: null, summary });
    } catch {
      setState({ isRunning: false, error: 'Request failed.', summary: null });
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-4">
      <h2 className="text-sm font-medium">{title}</h2>
      <p className="text-xs text-muted-foreground">{description}</p>
      <Button size="sm" className="w-fit" disabled={state.isRunning} onClick={handleClick}>
        {state.isRunning ? 'Running…' : buttonLabel}
      </Button>
      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      {state.summary ? <p className="text-sm text-muted-foreground">{state.summary}</p> : null}
    </div>
  );
}

async function runDraftBatch(): Promise<string> {
  const response = await fetch('/api/pipeline/draft-batch', { method: 'POST' });
  if (!response.ok) throw new Error(`Draft batch failed (status ${response.status}).`);

  const body: unknown = await response.json();
  const result = draftBatchResponseSchema.parse(body);
  const draftOutcomes = tally(result.drafted.map((item) => (item.outcome.ok ? 'drafted' : 'flagged')));
  const humanizeOutcomes = tally(result.humanized.results.map((item) => item.outcome));
  return `Draft batch (${result.drafted.length}): ${draftOutcomes}. Humanize batch (${result.humanized.attempted}): ${humanizeOutcomes}.`;
}

async function runFollowups(): Promise<string> {
  const response = await fetch('/api/pipeline/followups', { method: 'POST' });
  if (!response.ok) throw new Error(`Follow-up run failed (status ${response.status}).`);

  const body: unknown = await response.json();
  const result = outcomeListResponseSchema.parse(body);
  return `Processed ${result.results.length}: ${tally(result.results.map((item) => item.outcome))}`;
}

async function runRetention(): Promise<string> {
  const response = await fetch('/api/pipeline/retention', { method: 'POST' });
  if (!response.ok) throw new Error(`Retention run failed (status ${response.status}).`);

  const body: unknown = await response.json();
  const result = outcomeListResponseSchema.parse(body);
  return `Processed ${result.results.length}: ${tally(result.results.map((item) => item.outcome))}`;
}

export function PipelinePanel(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-4 p-6">
      <h1 className="text-lg font-medium">Pipeline</h1>
      <PipelineSection
        title="Draft batch"
        description="Drafts a batch of enriched prospects, then runs the humanizer pass over any drafts still missing a humanized body."
        buttonLabel="Run draft batch"
        onRun={runDraftBatch}
      />
      <PipelineSection
        title="Follow-ups"
        description="Sends the next due follow-up touch (or marks dead) for a batch of prospects."
        buttonLabel="Run follow-ups"
        onRun={runFollowups}
      />
      <PipelineSection
        title="Retention"
        description="Runs a batch of due retention touches for active recurring Jobs."
        buttonLabel="Run retention"
        onRun={runRetention}
      />
    </div>
  );
}
