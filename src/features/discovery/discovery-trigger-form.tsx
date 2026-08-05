'use client';

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { discoveryRunSummarySchema, type DiscoveryRunSummary } from '@/features/discovery/discovery.types';

type Branch = 'a' | 'b' | 'both';

async function triggerDiscovery(category: string, geography: string, branch: Branch): Promise<DiscoveryRunSummary> {
  const response = await fetch('/api/pipeline/discover', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ category, geography, branch }),
  });

  if (!response.ok) {
    throw new Error(`Discovery run failed (status ${response.status}).`);
  }

  const body: unknown = await response.json();
  return discoveryRunSummarySchema.parse(body);
}

export function DiscoveryTriggerForm(): React.JSX.Element {
  const [category, setCategory] = useState('');
  const [geography, setGeography] = useState('');
  const [branch, setBranch] = useState<Branch>('a');
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<DiscoveryRunSummary | null>(null);

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setIsRunning(true);
    setError(null);
    setSummary(null);

    try {
      const result = await triggerDiscovery(category, geography, branch);
      setSummary(result);
    } catch {
      setError('Discovery run failed.');
    } finally {
      setIsRunning(false);
    }
  }

  return (
    <div className="flex flex-col gap-4 p-6">
      <h1 className="text-lg font-medium">Discovery</h1>

      <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">Category</label>
          <Input
            className="w-48"
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            required
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">Geography</label>
          <Input
            className="w-48"
            value={geography}
            onChange={(event) => setGeography(event.target.value)}
            required
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">Branch</label>
          <Select value={branch} onValueChange={(value) => setBranch(value as Branch)}>
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="a">a</SelectItem>
              <SelectItem value="b">b</SelectItem>
              <SelectItem value="both">both</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button type="submit" disabled={isRunning}>
          {isRunning ? 'Running…' : 'Run discovery'}
        </Button>
      </form>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {summary ? (
        <div className="flex flex-col gap-2 rounded-md border border-border p-4 text-sm">
          <p>
            Total found: {summary.totalFound} · Inserted: {summary.inserted} · Updated: {summary.updated} · Skipped
            (do-not-contact): {summary.skippedDoNotContact}
          </p>
          <ul className="flex flex-col gap-1">
            {summary.sources.map((source) => (
              <li key={source.source}>
                <span className="font-medium">{source.source}</span> — {source.ran ? `ran, count ${source.count}` : 'skipped'}
                {source.reason ? ` (${source.reason})` : ''}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
