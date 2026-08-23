'use client';

import { useEffect, useState } from 'react';
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import {
  Compass01Icon,
  Loading03Icon,
  InformationCircleIcon,
  MapsLocation01Icon,
  ContactBookIcon,
  Rocket01Icon,
  DollarCircleIcon,
  GithubIcon,
  Idea01Icon,
  SourceCodeIcon,
  Alert02Icon,
  Building03Icon,
} from '@hugeicons/core-free-icons';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { toastSourceResults, toastError } from '@/lib/toast';
import {
  discoveryRunSummarySchema,
  discoveryRunHistorySchema,
  type DiscoveryRunSummary,
  type DiscoveryRunHistoryEntry,
} from '@/features/discovery/discovery.types';
import { DISCOVERY_SOURCES, type DiscoverySourceMeta } from '@/features/discovery/discovery-source-registry';
import { PRIORITY_MARKETS } from '@/features/discovery/priority-markets';
// `import type` only - erased at compile time, so this never actually pulls
// `system-health.service.ts` (and its `@/common/config/env` import) into the
// client bundle. Same pattern already used by system-health-trigger.tsx.
import type { SystemHealth } from '@/features/system/system-health.service';

type Branch = 'a' | 'b' | 'both';

// Maps a registry source key to its `ConfiguredServices` field, or `null`
// when the source needs no key at all (always "configured").
const CONFIGURED_SERVICES_KEY: Record<string, keyof SystemHealth['configuredServices'] | null> = {
  google_places: 'googlePlaces',
  yellowpages: null,
  product_hunt: 'productHunt',
  crunchbase: 'crunchbase',
  github: 'github',
  indiehackers: null,
  builtwith: 'builtwith',
  overpass: null,
  companies_house: 'companiesHouse',
  texas_comptroller: 'texasComptroller',
};

// Purely for at-a-glance scanning of the source checklist - not decorative,
// each icon is a quick visual anchor for what the source actually is.
const SOURCE_ICONS: Record<string, IconSvgElement> = {
  google_places: MapsLocation01Icon,
  yellowpages: ContactBookIcon,
  product_hunt: Rocket01Icon,
  crunchbase: DollarCircleIcon,
  github: GithubIcon,
  indiehackers: Idea01Icon,
  builtwith: SourceCodeIcon,
  overpass: MapsLocation01Icon,
  companies_house: Building03Icon,
  texas_comptroller: Building03Icon,
};

function isSourceConfigured(source: DiscoverySourceMeta, configuredServices: SystemHealth['configuredServices'] | null): boolean {
  const field = CONFIGURED_SERVICES_KEY[source.key];
  if (field === null) return true;
  if (configuredServices === null) return false;
  return configuredServices[field];
}

// Confirmed defaults (see the discovery-source-registry buildout plan): paid
// sources always start unchecked (manual opt-in every run, regardless of
// configuration), free sources start checked only when configured, anything
// unconfigured starts unchecked.
// Branch-independent sources (`branch: null` - BuiltWith, GitHub) are always
// shown alongside whichever branch's own sources are visible, since they're
// always-available enrichment steps rather than belonging to either branch.
function visibleSourcesForBranch(branch: Branch): DiscoverySourceMeta[] {
  return DISCOVERY_SOURCES.filter((source) => source.branch === null || branch === 'both' || source.branch === branch);
}

function defaultEnabledSources(
  sources: DiscoverySourceMeta[],
  configuredServices: SystemHealth['configuredServices'] | null
): Set<string> {
  const enabled = new Set<string>();
  for (const source of sources) {
    if (source.paid) continue;
    if (isSourceConfigured(source, configuredServices)) enabled.add(source.key);
  }
  return enabled;
}

const BRANCH_HELP: Record<Branch, string> = {
  a: 'Local/SMB search. Category is a business type ("plumber", "dentist"), Geography is a city and state ("Austin, TX") - both feed Google Places and Yellow Pages searches directly.',
  b: 'Startup/SaaS search. Category is reused as a loose topic keyword (a Product Hunt topic slug, a substring match on Crunchbase - Indie Hackers ignores it entirely). Geography is ignored by every source in this branch. GitHub isn\'t part of either branch - it\'s an enrichment step that runs afterward against SaaS-industry prospects already found.',
  both: 'Runs every source above. Branch A sources use Category/Geography as described for "a"; Branch B sources use Category as a keyword and ignore Geography, as described for "b".',
};

const BRANCH_LABELS: Record<Branch, string> = {
  a: 'Branch A - Local/SMB',
  b: 'Branch B - Startup/SaaS',
  both: 'Both branches',
};

const CATEGORY_HELP: Record<Branch, string> = {
  a: 'A business type/keyword, e.g. "plumber", "dentist", "hvac contractor". Fed directly into Google Places and Yellow Pages searches.',
  b: 'A loose topic keyword: a Product Hunt topic slug (e.g. "saas"), or a substring match against Crunchbase company names. Indie Hackers ignores this entirely and always scrapes the same pages.',
  both: 'Used differently by every source - see the Category tooltip on Branch A/B individually for exact meaning per source.',
};

// Branch A suggestions mirror the exact keywords `CATEGORY_TAG_MAP` in
// overpass.source.ts already maps to real OSM tags (one representative
// keyword per tag group, e.g. "mechanic" for the car_repair group) - keeps
// the suggestions honest about what this app's own sources actually
// understand, rather than an unrelated wishlist. Not imported directly
// (that file isn't guaranteed env-free transitively, and this is a
// 'use client' file - see the CLAUDE.md note on that hazard), just kept in
// sync by hand.
// Branch B has no existing curated taxonomy to reuse (Product Hunt/Crunchbase
// treat Category as a loose keyword, not a structured category) - this is a
// small hand-picked list of common startup/SaaS category keywords.
const CATEGORY_SUGGESTIONS_A = ['plumber', 'mechanic', 'electrician', 'restaurant', 'cafe', 'dentist', 'hair salon', 'bakery', 'gym'];
const CATEGORY_SUGGESTIONS_B = ['saas', 'fintech', 'devtools', 'ai', 'marketplace', 'productivity', 'ecommerce', 'analytics'];

const CATEGORY_SUGGESTIONS: Record<Branch, string[]> = {
  a: CATEGORY_SUGGESTIONS_A,
  b: CATEGORY_SUGGESTIONS_B,
  both: Array.from(new Set([...CATEGORY_SUGGESTIONS_A, ...CATEGORY_SUGGESTIONS_B])),
};

const GEOGRAPHY_HELP =
  'A "City, State" string (e.g. "Austin, TX"), used only by Branch A sources (Google Places, Yellow Pages). Every Branch B source ignores this field entirely, even when it\'s filled in.';

const BRANCH_SELECT_HELP =
  'Which discovery sources run: Branch A (local/SMB businesses via Google Places + Yellow Pages), Branch B (startups/SaaS via Product Hunt, Crunchbase, Indie Hackers), or both. BuiltWith/GitHub enrichment run afterward regardless of branch.';

const SOURCE_HELP: Record<string, string> = {
  google_places: 'Google Places Text Search API - local businesses matching Category near Geography. Needs GOOGLE_PLACES_API_KEY.',
  yellowpages: 'Playwright scrape of yellowpages.com search results for Category in Geography. No API key needed.',
  builtwith: 'Enrichment only (not a discovery source) - looks up each found domain\'s tech stack via the BuiltWith API to flag a stale/outdated stack. Needs BUILTWITH_API_KEY.',
  product_hunt: 'Product Hunt GraphQL API - recently launched products under the Category topic. Needs PRODUCT_HUNT_API_TOKEN.',
  crunchbase: 'Crunchbase Search API - recently funded companies (last 90 days) whose name contains Category. Needs CRUNCHBASE_API_KEY.',
  github:
    'Enrichment only (not a discovery source), scoped to SaaS-industry prospects - looks up each found company\'s GitHub org/user account and checks its repos for hiring/CI signals. Works unauthenticated at a lower rate limit; GITHUB_TOKEN raises it.',
  indiehackers: 'Playwright scrape of Indie Hackers\' Products and Jobs pages. Ignores Category/Geography entirely - always the same pages. No API key needed.',
  overpass:
    'OpenStreetMap via the Overpass API - geocodes Geography via Nominatim, then queries OSM points of interest matching Category. Free, no API key needed. Data completeness varies by region; many results will have a name only.',
  companies_house:
    'UK Companies House public company search - Category is the search term, filtered to active companies whose address loosely matches Geography. Free, needs COMPANIES_HOUSE_API_KEY.',
  texas_comptroller:
    'Texas Comptroller franchise tax registry - searches by Category, filters to active SOS registrations whose mailing address loosely matches Geography. Free, needs TEXAS_COMPTROLLER_API_KEY.',
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

interface SourceRowProps {
  source: DiscoverySourceMeta;
  checked: boolean;
  configured: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
}

// A single source's checklist row: checkbox, icon, name, a Paid/Free badge,
// and a Configured/Not configured badge. Unconfigured sources are
// force-unchecked and disabled regardless of paid/free (see
// `defaultEnabledSources`), and read as visually muted here, not just via the
// badge text - a row someone can't actually enable shouldn't look identical
// to one they can.
function SourceRow({ source, checked, configured, disabled, onCheckedChange }: SourceRowProps): React.JSX.Element {
  const icon = SOURCE_ICONS[source.key];

  return (
    <label
      className={`flex items-center gap-3 px-3 py-2 text-sm transition-colors ${
        configured ? 'hover:bg-muted/40 cursor-pointer' : 'cursor-not-allowed opacity-50'
      }`}
    >
      <Checkbox
        checked={configured && checked}
        disabled={disabled || !configured}
        onCheckedChange={(value) => onCheckedChange(value === true)}
      />
      {icon ? <HugeiconsIcon icon={icon} strokeWidth={2} className="text-muted-foreground size-4 shrink-0" /> : null}
      <span className="min-w-0 flex-1 truncate">{source.displayName}</span>
      {source.knownIssue ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="text-amber-500 inline-flex shrink-0" aria-label="Known issue with this source">
              <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} className="size-3.5" />
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-64">{source.knownIssue}</TooltipContent>
        </Tooltip>
      ) : null}
      <span className="flex shrink-0 items-center gap-2">
        <Badge variant={source.paid ? 'outline' : 'secondary'} className="w-12 justify-center">
          {source.paid ? 'Paid' : 'Free'}
        </Badge>
        <Badge variant={configured ? 'default' : 'outline'} className="w-28 justify-center">
          {configured ? 'Configured' : 'Not configured'}
        </Badge>
      </span>
    </label>
  );
}

const RELATIVE_TIME_UNITS: Array<{ label: string; seconds: number }> = [
  { label: 'year', seconds: 60 * 60 * 24 * 365 },
  { label: 'month', seconds: 60 * 60 * 24 * 30 },
  { label: 'day', seconds: 60 * 60 * 24 },
  { label: 'hour', seconds: 60 * 60 },
  { label: 'minute', seconds: 60 },
];

// No date-formatting dependency exists elsewhere in the codebase, so this is
// a small hand-rolled relative-time string rather than pulling one in for a
// single display case.
function formatRelativeTime(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'just now';

  for (const unit of RELATIVE_TIME_UNITS) {
    const count = Math.floor(seconds / unit.seconds);
    if (count >= 1) return `${count} ${unit.label}${count === 1 ? '' : 's'} ago`;
  }
  return 'just now';
}

async function fetchDiscoveryHistory(): Promise<DiscoveryRunHistoryEntry[]> {
  const response = await fetch('/api/discovery/runs');
  if (!response.ok) {
    throw new Error(`Failed to load discovery history (status ${response.status}).`);
  }
  const body: unknown = await response.json();
  return discoveryRunHistorySchema.parse(body);
}

async function triggerDiscovery(
  category: string,
  geography: string,
  branch: Branch,
  sources: string[]
): Promise<DiscoveryRunSummary> {
  const response = await fetch('/api/pipeline/discover', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ category, geography, branch, sources }),
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
  const [history, setHistory] = useState<DiscoveryRunHistoryEntry[]>([]);
  const [historyRefreshIndex, setHistoryRefreshIndex] = useState(0);
  const [configuredServices, setConfiguredServices] = useState<SystemHealth['configuredServices'] | null>(null);
  const [enabledSources, setEnabledSources] = useState<Set<string>>(() =>
    defaultEnabledSources(visibleSourcesForBranch('a'), null)
  );
  // Tracks the (branch, configuredServices) pair the current `enabledSources`
  // selection was computed for, so a change to either can be detected and
  // reacted to during render (the React-recommended "adjust state when a
  // prop changes" pattern - https://react.dev/learn/you-might-not-need-an-effect)
  // rather than via a `useEffect` that calls `setState` synchronously.
  const [enabledSourcesComputedFor, setEnabledSourcesComputedFor] = useState<{
    branch: Branch;
    configuredServices: SystemHealth['configuredServices'] | null;
  }>({ branch: 'a', configuredServices: null });

  useEffect(() => {
    let cancelled = false;

    // History is a convenience aid, not load-bearing - a failed fetch here
    // shouldn't block or toast-spam the discovery form itself, so failures
    // are swallowed rather than surfaced.
    fetchDiscoveryHistory()
      .then((result) => {
        if (!cancelled) setHistory(result);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [historyRefreshIndex]);

  useEffect(() => {
    let cancelled = false;

    // Same fire-and-forget pattern as the history fetch above: used only to
    // enable/disable and pre-check source checkboxes, not load-bearing
    // enough to block the form or toast on failure.
    fetch('/api/system/health')
      .then((res) => (res.ok ? (res.json() as Promise<SystemHealth>) : Promise.reject(new Error(String(res.status)))))
      .then((data) => {
        if (!cancelled) setConfiguredServices(data.configuredServices);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, []);

  // Recompute the default checked-sources set whenever the visible source
  // set changes (branch switch, or configuredServices arriving after the
  // initial render) - the checklist always reflects the confirmed defaults
  // for whatever's currently shown rather than persisting a stale selection.
  if (enabledSourcesComputedFor.branch !== branch || enabledSourcesComputedFor.configuredServices !== configuredServices) {
    setEnabledSourcesComputedFor({ branch, configuredServices });
    setEnabledSources(defaultEnabledSources(visibleSourcesForBranch(branch), configuredServices));
  }

  function toggleSource(key: string, checked: boolean): void {
    setEnabledSources((prev) => {
      const next = new Set(prev);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  const duplicateOfCurrentInput = history.find(
    (run) => run.category === category && run.geography === geography && run.branch === branch
  );

  const branchSources = DISCOVERY_SOURCES.filter((source) => source.branch !== null && (branch === 'both' || source.branch === branch));
  // Branch-independent enrichment sources (BuiltWith, GitHub) - rendered
  // after the branch's own sources regardless of which branch is selected.
  const branchIndependentSources = DISCOVERY_SOURCES.filter((source) => source.branch === null);

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (isRunning) return;
    setIsRunning(true);

    try {
      const result = await triggerDiscovery(category, geography, branch, Array.from(enabledSources));
      setSummary(result);
      toastSourceResults(
        `Discovery run: ${result.totalFound} found, ${result.inserted} inserted, ${result.updated} updated`,
        result.sources
      );
      setHistoryRefreshIndex((prev) => prev + 1);
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

      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <div className="flex flex-col gap-4 lg:max-w-2xl">
          <Card>
            <CardHeader>
              <CardTitle>Run discovery</CardTitle>
              <CardDescription>{BRANCH_HELP[branch]}</CardDescription>
            </CardHeader>
            <form onSubmit={handleSubmit}>
              <CardContent className="flex flex-wrap items-end gap-3 pb-(--card-spacing)">
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
                    list="category-suggestions"
                  />
                  {/* Native OS-level autocomplete suggestions - purely additive,
                      doesn't block or validate typed input. See CATEGORY_SUGGESTIONS
                      above for why a shadcn Combobox wasn't used here instead. */}
                  <datalist id="category-suggestions">
                    {CATEGORY_SUGGESTIONS[branch].map((suggestion) => (
                      <option key={suggestion} value={suggestion} />
                    ))}
                  </datalist>
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
                    list="geography-suggestions"
                  />
                  {/* Same native-datalist pattern as Category above - not
                      branch-keyed, since PRIORITY_MARKETS is the same list
                      regardless of branch (Branch B ignores Geography entirely). */}
                  <datalist id="geography-suggestions">
                    {PRIORITY_MARKETS.map((market) => (
                      <option key={market} value={market} />
                    ))}
                  </datalist>
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
              <CardContent className="flex flex-col gap-3 pt-0 pb-(--card-spacing)">
                <div className="flex flex-col gap-2">
                  <span className="text-muted-foreground text-xs">Discovery sources</span>
                  <div className="divide-border rounded-md border divide-y">
                    {branchSources.map((source) => (
                      <SourceRow
                        key={source.key}
                        source={source}
                        checked={enabledSources.has(source.key)}
                        configured={isSourceConfigured(source, configuredServices)}
                        disabled={isRunning}
                        onCheckedChange={(checked) => toggleSource(source.key, checked)}
                      />
                    ))}
                  </div>
                </div>
                {branchIndependentSources.length > 0 ? (
                  <div className="flex flex-col gap-2">
                    <span className="text-muted-foreground flex items-center gap-1 text-xs">
                      Enrichment
                      <FieldHelp text="Runs after discovery, adding evidence to prospects a discovery source already found - never discovers a business on its own." />
                    </span>
                    <div className="divide-border rounded-md border divide-y">
                      {branchIndependentSources.map((source) => (
                        <SourceRow
                          key={source.key}
                          source={source}
                          checked={enabledSources.has(source.key)}
                          configured={isSourceConfigured(source, configuredServices)}
                          disabled={isRunning}
                          onCheckedChange={(checked) => toggleSource(source.key, checked)}
                        />
                      ))}
                    </div>
                  </div>
                ) : null}
              </CardContent>
              <CardFooter className="flex flex-col items-start gap-3">
                {duplicateOfCurrentInput ? (
                  <p className="text-muted-foreground flex items-center gap-1 text-xs">
                    <HugeiconsIcon icon={InformationCircleIcon} strokeWidth={2} className="size-3.5 shrink-0" />
                    Searched {formatRelativeTime(new Date(duplicateOfCurrentInput.createdAt))} — {duplicateOfCurrentInput.totalFound}{' '}
                    found.
                  </p>
                ) : null}
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
            <Card>
              <CardHeader>
                <CardTitle>Last run</CardTitle>
                <CardDescription>
                  {summary.totalFound} found · {summary.inserted} inserted · {summary.updated} updated ·{' '}
                  {summary.skippedDoNotContact} skipped (do-not-contact) · {summary.discardedThinProspects} discarded (no
                  actionable info)
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

        <Card className="lg:flex-1">
          <CardHeader>
            <CardTitle>History</CardTitle>
            <CardDescription>Past discovery runs, most recent first.</CardDescription>
          </CardHeader>
          <CardContent className="flex max-h-[28rem] flex-col gap-2 overflow-y-auto">
            {history.length === 0 ? (
              <p className="text-muted-foreground text-sm">No discovery runs yet.</p>
            ) : (
              history.map((run) => (
                <div key={run.id} className="flex items-center justify-between gap-4 text-sm">
                  <span className="flex min-w-0 shrink items-center gap-2">
                    <span className="truncate font-medium">{run.category}</span>
                    <span className="text-muted-foreground truncate">{run.geography}</span>
                    <Badge variant="outline" className="shrink-0">
                      {BRANCH_LABELS[run.branch]}
                    </Badge>
                  </span>
                  <span className="text-muted-foreground flex shrink-0 items-center gap-3 text-xs">
                    <span>{run.totalFound} found</span>
                    <span>{formatRelativeTime(new Date(run.createdAt))}</span>
                  </span>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
