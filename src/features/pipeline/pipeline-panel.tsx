'use client';

import { useState } from 'react';
import { z } from 'zod';
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import { Edit02Icon, MailSend01Icon, RepeatIcon, Loading03Icon } from '@hugeicons/core-free-icons';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/ui/card';
import { toastSuccess, toastError } from '@/lib/toast';

// Local, minimal response schemas - just enough to tally outcomes for
// display. Deliberately not importing the scheduler/service result types
// (drafting.service.ts, followup-scheduler.ts, retention-scheduler.ts are
// server-only and must never reach this `'use client'` file).
const draftBatchResponseSchema = z.object({
  drafted: z.array(z.object({ prospectId: z.string(), outcome: z.object({ ok: z.boolean() }) })),
  humanized: z.object({ attempted: z.number().int(), results: z.array(z.object({ outcome: z.string() })) }),
});

const outcomeResultSchema = z.object({ outcome: z.string() });
const outcomeListResponseSchema = z.object({ results: z.array(outcomeResultSchema) });

type RunStatus = 'idle' | 'running' | 'succeeded' | 'failed';

interface SectionState {
  status: RunStatus;
  summary: string | null;
}

const INITIAL_STATE: SectionState = { status: 'idle', summary: null };

const STATUS_BADGE: Record<RunStatus, { label: string; variant: 'outline' | 'secondary' | 'default' | 'destructive' }> = {
  idle: { label: 'Idle', variant: 'outline' },
  running: { label: 'Running', variant: 'secondary' },
  succeeded: { label: 'Succeeded', variant: 'default' },
  failed: { label: 'Failed', variant: 'destructive' },
};

function tally(outcomes: string[]): string {
  const counts = new Map<string, number>();
  for (const outcome of outcomes) counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
  if (counts.size === 0) return 'Nothing to process.';
  return Array.from(counts.entries())
    .map(([outcome, count]) => `${outcome}: ${count}`)
    .join(', ');
}

function PipelineSection({
  icon,
  title,
  description,
  buttonLabel,
  onRun,
}: {
  icon: IconSvgElement;
  title: string;
  description: string;
  buttonLabel: string;
  onRun: () => Promise<string>;
}): React.JSX.Element {
  const [state, setState] = useState<SectionState>(INITIAL_STATE);
  const badge = STATUS_BADGE[state.status];

  async function handleClick(): Promise<void> {
    setState({ status: 'running', summary: null });
    try {
      const summary = await onRun();
      setState({ status: 'succeeded', summary });
      toastSuccess(title, summary);
    } catch {
      setState({ status: 'failed', summary: null });
      toastError(`${title} failed`, 'The request errored - check your connection and try again.');
    }
  }

  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <HugeiconsIcon icon={icon} strokeWidth={2} className="text-muted-foreground size-4" />
            <CardTitle>{title}</CardTitle>
          </div>
          <Badge variant={badge.variant}>{badge.label}</Badge>
        </div>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {state.summary ? <p className="text-muted-foreground text-sm">{state.summary}</p> : null}
      </CardContent>
      <CardFooter>
        <Button size="sm" disabled={state.status === 'running'} onClick={handleClick}>
          {state.status === 'running' ? (
            <>
              <HugeiconsIcon icon={Loading03Icon} strokeWidth={2} className="size-3.5 animate-spin" />
              Running…
            </>
          ) : (
            buttonLabel
          )}
        </Button>
      </CardFooter>
    </Card>
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
      <div className="flex flex-col gap-1">
        <h1 className="text-lg font-medium">Pipeline</h1>
        <p className="text-muted-foreground text-sm">
          Manually trigger the same batch operations a scheduler would run automatically. Each runs independently - safe to
          run any of these at any time, they only ever act on prospects/jobs that are actually due.
        </p>
      </div>

      <PipelineSection
        icon={Edit02Icon}
        title="Draft batch"
        description='Drafts outreach copy for a batch of prospects whose status is "enriched" but not yet drafted (3 framework variants each), then runs the humanizer pass over any drafts still missing a humanized body.'
        buttonLabel="Run draft batch"
        onRun={runDraftBatch}
      />
      <PipelineSection
        icon={MailSend01Icon}
        title="Follow-ups"
        description="Sends the next scheduled follow-up email to prospects that are due for one (4-day cadence, one follow-up), or marks a prospect dead once that follow-up has gone unanswered."
        buttonLabel="Run follow-ups"
        onRun={runFollowups}
      />
      <PipelineSection
        icon={RepeatIcon}
        title="Retention"
        description="Runs a batch of due retention touches for active, recurring Jobs (won clients on an ongoing service) - the post-sale equivalent of follow-ups."
        buttonLabel="Run retention"
        onRun={runRetention}
      />
    </div>
  );
}
