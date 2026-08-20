'use client';

import { useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Compass01Icon, Loading03Icon, InformationCircleIcon } from '@hugeicons/core-free-icons';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { toastSourceResults, toastError } from '@/lib/toast';
import { discoveryRunSummarySchema, type DiscoveryRunSummary } from '@/features/discovery/discovery.types';

type Branch = 'a' | 'b' | 'both';

const BRANCH_HELP: Record<Branch, string> = {
  a: 'Local/SMB search. Category is a business type ("plumber", "dentist"), Geography is a city and state ("Austin, TX") - both feed Google Places and Yellow Pages searches directly.',
  b: 'Startup/SaaS search. Category is reused as a loose topic keyword (a Product Hunt topic slug, a GitHub repo topic, a substring match on Crunchbase - Indie Hackers ignores it entirely). Geography is ignored by every source in this branch.',
  both: 'Runs every source above. Branch A sources use Category/Geography as described for "a"; Branch B sources use Category as a keyword and ignore Geography, as described for "b".',
};

const BRANCH_LABELS: Record<Branch, string> = {
  a: 'Branch A - Local/SMB',
  b: 'Branch B - Startup/SaaS',
  both: 'Both branches',
};

const CATEGORY_HELP: Record<Branch, string> = {
  a: 'A business type/keyword, e.g. "plumber", "dentist", "hvac contractor". Fed directly into Google Places and Yellow Pages searches.',
  b: 'A loose topic keyword: a Product Hunt topic slug (e.g. "saas"), a GitHub repo topic tag (e.g. "nextjs"), or a substring match against Crunchbase company names. Indie Hackers ignores this entirely and always scrapes the same pages.',
  both: 'Used differently by every source - see the Category tooltip on Branch A/B individually for exact meaning per source.',
};

const GEOGRAPHY_HELP =
  'A "City, State" string (e.g. "Austin, TX"), used only by Branch A sources (Google Places, Yellow Pages). Every Branch B source ignores this field entirely, even when it\'s filled in.';

const BRANCH_SELECT_HELP =
  'Which discovery sources run: Branch A (local/SMB businesses via Google Places + Yellow Pages), Branch B (startups/SaaS via Product Hunt, Crunchbase, GitHub, Indie Hackers), or both.';

const SOURCE_HELP: Record<string, string> = {
  google_places: 'Google Places Text Search API - local businesses matching Category near Geography. Needs GOOGLE_PLACES_API_KEY.',
  yellowpages: 'Playwright scrape of yellowpages.com search results for Category in Geography. No API key needed.',
  builtwith: 'Enrichment only (not a discovery source) - looks up each found domain\'s tech stack via the BuiltWith API to flag a stale/outdated stack. Needs BUILTWITH_API_KEY.',
  product_hunt: 'Product Hunt GraphQL API - recently launched products under the Category topic. Needs PRODUCT_HUNT_API_TOKEN.',
  crunchbase: 'Crunchbase Search API - recently funded companies (last 90 days) whose name contains Category. Needs CRUNCHBASE_API_KEY.',
  github: 'GitHub REST API - repos tagged with the Category topic, checked for hiring/CI signals. Works unauthenticated at a lower rate limit; GITHUB_TOKEN raises it.',
  indiehackers: 'Playwright scrape of Indie Hackers\' Products and Jobs pages. Ignores Category/Geography entirely - always the same pages. No API key needed.',
};

function FieldHelp({ text }: { text: string }): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" className="text-muted-foreground hover:text-foreground inline-flex" aria-label="What is this field for?">
          <HugeiconsIcon icon={InformationCircleIcon} strokeWidth={2} className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">{text}</TooltipContent>
    </Tooltip>
  );
}

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
  const [summary, setSummary] = useState<DiscoveryRunSummary | null>(null);

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (isRunning) return;
    setIsRunning(true);

    try {
      const result = await triggerDiscovery(category, geography, branch);
      setSummary(result);
      toastSourceResults(
        `Discovery run: ${result.totalFound} found, ${result.inserted} inserted, ${result.updated} updated`,
        result.sources
      );
    } catch {
      toastError('Discovery run failed.', 'The request itself errored - check your connection and try again.');
    } finally {
      setIsRunning(false);
    }
  }

  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-lg font-medium">Discovery</h1>
        <p className="text-muted-foreground text-sm">
          Find new prospects by running one or more discovery sources against a category and geography.
        </p>
      </div>

      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle>Run discovery</CardTitle>
          <CardDescription>{BRANCH_HELP[branch]}</CardDescription>
        </CardHeader>
        <form onSubmit={handleSubmit}>
          <CardContent className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-muted-foreground flex items-center gap-1 text-xs">
                Category
                <FieldHelp text={CATEGORY_HELP[branch]} />
              </label>
              <Input
                className="w-48"
                placeholder={branch === 'a' ? 'e.g. plumber' : 'e.g. saas'}
                value={category}
                onChange={(event) => setCategory(event.target.value)}
                disabled={isRunning}
                required
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-muted-foreground flex items-center gap-1 text-xs">
                Geography {branch !== 'a' && <span className="opacity-60">(ignored for this branch)</span>}
                <FieldHelp text={GEOGRAPHY_HELP} />
              </label>
              <Input
                className="w-48"
                placeholder={branch === 'a' ? 'e.g. Austin, TX' : 'ignored'}
                value={geography}
                onChange={(event) => setGeography(event.target.value)}
                disabled={isRunning}
                required
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-muted-foreground flex items-center gap-1 text-xs">
                Branch
                <FieldHelp text={BRANCH_SELECT_HELP} />
              </label>
              <Select value={branch} onValueChange={(value) => setBranch(value as Branch)} disabled={isRunning}>
                <SelectTrigger className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="a">{BRANCH_LABELS.a}</SelectItem>
                  <SelectItem value="b">{BRANCH_LABELS.b}</SelectItem>
                  <SelectItem value="both">{BRANCH_LABELS.both}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardContent>
          <CardFooter>
            <Button type="submit" disabled={isRunning}>
              {isRunning ? (
                <>
                  <HugeiconsIcon icon={Loading03Icon} strokeWidth={2} className="size-4 animate-spin" />
                  Running discovery…
                </>
              ) : (
                <>
                  <HugeiconsIcon icon={Compass01Icon} strokeWidth={2} className="size-4" />
                  Run discovery
                </>
              )}
            </Button>
          </CardFooter>
        </form>
      </Card>

      {summary ? (
        <Card className="max-w-4xl">
          <CardHeader>
            <CardTitle>Last run</CardTitle>
            <CardDescription>
              {summary.totalFound} found · {summary.inserted} inserted · {summary.updated} updated ·{' '}
              {summary.skippedDoNotContact} skipped (do-not-contact)
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {summary.sources.map((source) => (
              <div key={source.source} className="flex items-start justify-between gap-4 text-sm">
                <span className="flex shrink-0 items-center gap-1 font-medium">
                  {source.source}
                  {SOURCE_HELP[source.source] ? <FieldHelp text={SOURCE_HELP[source.source]} /> : null}
                </span>
                {source.ran ? (
                  <Badge variant={source.count > 0 ? 'default' : 'secondary'} className="shrink-0">
                    {source.count} found
                  </Badge>
                ) : (
                  <span className="text-muted-foreground text-right text-xs">{source.reason ?? 'skipped'}</span>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
