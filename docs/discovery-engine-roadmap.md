# Discovery engine roadmap

Branch: `feat/discovery-engine-v2`. Written 2026-08-21 so this survives a context clear - read
this first if you're picking up this branch cold.

## Why this branch exists

Discovery is the most important stage of the pipeline - nothing downstream (enrichment, drafting,
sending) matters if discovery doesn't reliably surface real, commercially-actionable businesses.
After a session spent just getting the *existing* 7 sources to actually work (see git history:
retry-with-backoff, stale-selector fixes, decommissioned-token issues), the owner had an extended
design conversation (with GPT, pasted into this branch's originating chat) about what a genuinely
strong free discovery engine looks like, not just a patched-up version of the current one.

The full vision below is large - a real multi-source prospecting engine with entity resolution,
buying-signal scoring, and geographic search. That is NOT all being built in this branch. This doc
exists specifically so the ambitious version doesn't get lost, while the branch itself stays
scoped to a deliberately smaller, shippable slice.

## The full vision (reference - not all being built now)

A mature version of this system looks like four layers:

```
DISCOVERY → IDENTITY/DEDUP → ENRICHMENT → OPPORTUNITY SCORING
```

With discovery sources deliberately overlapping (multiple sources finding the same business
increases recall and confidence, rather than being wasted redundant work), reconciled by a
canonical-company dedup layer using weighted signals (same domain, same phone, same address,
same coordinates, same registration number → confidence score → merge threshold).

**Source tiers** (S = core discovery, A = enrichment/niche discovery, B = specialized signal):

| Source | Tier | Role |
|---|---|---|
| Google Maps/Places | S | Business discovery (already have, billing currently off) |
| OpenStreetMap/Overpass | S | Free geographic discovery |
| Government business registries (per-country) | S | Real companies + creation dates + status |
| Search engines (as signal source, not just discovery) | S | Broad discovery + intent signals ("hiring", "new location") |
| Job boards | S | Strong buying-intent signal (a company hiring a React dev is spending money on software NOW) |
| Yellow Pages | A | SMB coverage (already have) |
| Product Hunt | A | Startup/launch discovery (already have) |
| Indie Hackers | A | Founder/build-in-public signals (already have) |
| Company website (first-party crawl) | S | Enrichment - own tech-stack/SEO/UX detection before any paid API |
| BuiltWith | A | Secondary tech-stack cross-check, not primary detector (already architected this way) |
| GitHub | B | Technical evidence for an *already-identified* company, never primary discovery |
| App stores, review sites, DNS/CT, accelerators, tenders | B | Specialized signals, later |

**Buying-signal engine**: recently founded, recently funded, hiring developers, new location, new
product launch, no website / bad website / no booking system, poor SEO - each maps to a
`+score` and a recommended service, feeding a lead-scoring model (business fit + buying intent +
pain severity + company value + contactability + geography + evidence confidence).

**Geographic layer**: Leaflet + OpenStreetMap + PostGIS-backed map, filterable by industry/score/
source, click-through to a full prospect profile with evidence trail.

**Target markets**: not "businesses worldwide" - explicitly prioritize US states and European
countries with high purchasing power and tech-services demand (US: CA, NY, TX, FL, WA, MA, NJ,
IL, VA, CO, GA, NC; Europe: UK, DE, FR, NL, CH, IE, SE, NO, DK, BE, AT, FI). Country/region becomes
part of the scoring model eventually, not just a free-text search field.

**Browser/crawler architecture**: three-tier escalation, cheapest first -
`HTTP fetch → browser renderer (JS-required sites) → Patchright-style real-Chrome automation
(sites that specifically fight back)` - rather than throwing full browser automation at every
site regardless of whether it's needed.

## What this branch actually builds ("doable now")

Scoped down from the above to what's realistically buildable free-of-cost, without new
infrastructure (no PostGIS, no per-country registry connectors, no job-board scraping, no
search-engine scraping), and without repeating the "build everything at once" mistake:

1. ~~**Benchmark Patchright vs. the current hand-rolled Playwright stealth setup.**~~ **DONE,
   2026-08-21 - not adopted.** A maintained Node.js port exists (`patchright` on npm, drop-in
   replacement, same maintainer as the Python original) and was actually benchmarked against the
   current setup on yellowpages.com (n=5) and a neutral fingerprint site, bot.sannysoft.com (n=20).
   Result: no improvement either target - Patchright's own docs are explicit that its stealth
   advantage requires **headed** mode ("much easier to detect when headless"), and this app runs
   headless on a server with no display. Decision: keep the current manual UA/Client-Hints/
   `navigator.webdriver` setup, don't add the dependency. If server-side headed automation (e.g.
   via a virtual display/Xvfb) ever becomes worth the complexity, this is worth re-benchmarking
   then - not before, since the constraint that killed it here (no display) wouldn't have changed.
2. **Add OpenStreetMap/Overpass as a new Branch A discovery source.** Genuinely free, structured
   API (no scraping, no anti-bot fight), real geographic POI discovery. Public Overpass instances
   are usable for this workload without needing a paid key or self-hosted instance yet.
3. **Re-architect GitHub from a discovery source to enrichment-only.** It should never independently
   produce a prospect (a random `github.com/user/toy-project` isn't a business) - it should only
   add technical evidence (active org, real commits, company domain match) to a company already
   found by a real discovery source. This mirrors how BuiltWith is already correctly scoped
   (enrichment-only, confirmed this session) - GitHub gets the same treatment.
4. **Add a first-party lightweight tech-stack detector** (HTTP fetch + HTML/header inspection for
   common CMS/framework/analytics signatures - WordPress, Shopify, Wix, Webflow, Next.js, common
   analytics/pixel tags) that runs before BuiltWith, so tech-stack signal doesn't depend entirely
   on BuiltWith's API/rate limit. BuiltWith becomes a secondary cross-check on top of this, not the
   primary source.
5. **Upgrade dedup beyond domain-only matching.** Today's `dedupeByDomain` in
   `discovery.service.ts` only merges by exact domain. Once OSM is a second Branch A source
   alongside Yellow Pages, real overlap will happen (the same business found twice with no shared
   domain, e.g. no website). Add phone-number and normalized-address as secondary match keys - a
   light multi-field version of the concept, not the full weighted-confidence-score entity
   resolution engine described above.

## Status: all 5 "doable now" items shipped (2026-08-21)

Dedup/persistence fix, Overpass source, tech-stack detector, GitHub re-architected as enrichment,
and the Patchright benchmark (measured, not adopted - see item 1 above) are all committed on this
branch. See commits `08c68f5`..`18f0aff`.

## Status: priority-score v2 shipped (2026-08-21)

A second planning pass assessed every item in "explicitly deferred" below for real effort/risk/
payoff (not just re-stating the wishlist). Finding: `computePriorityScore` in `discovery.service.ts`
- already wired into the dashboard's prospect filter/sort UI today - was a one-line stub
(`SIGNAL_STRENGTH_SCORE[signal.strength]`, nothing else). Upgrading it was the highest value-per-
effort next step: no new external dependency, no anti-bot risk, one small additive migration, and
it improves every prospect already in the DB retroactively, not just future discovery runs.

Three tightly-coupled pieces, all shipped:

1. **Stop discarding corroboration on dedup.** `dedupeProspects`/`findExistingProspect` currently
   `continue`/overwrite on a matched duplicate, throwing away the fact that a second source found
   the same business. Add `Prospect.corroboratingSourceCount Int @default(1)` (small additive
   migration, applied to both `DATABASE_URL` and `TEST_DATABASE_URL` per the two-DB testing setup),
   incremented (monotonic - never decremented, simplest and avoids re-scrape ordering edge cases)
   whenever a re-discovered prospect matches an existing one by domain/phone/address.
2. **Replace the priority-score stub with a real weighted formula**, in new
   `src/features/matching/priority-scoring.ts` (pure function, colocated conceptually with
   `service-matching-rules.ts`, not doing I/O, easily unit-tested): signal strength (base, dominant
   factor) + a capped company-size bonus (bigger company, more budget capacity, but shouldn't
   dominate) + a capped contactability bonus (has domain/phone/address - a prospect with nothing to
   act on shouldn't outrank one with real contact info at equal signal strength) + a capped
   corroboration bonus from item 1 (found by 2+ independent sources = more confidence it's a real,
   active business). Flat, explicitly-commented weighted sum - not the full GPT-proposed
   per-dimension explainable model, deliberately staying in scope.
3. **Lightweight priority-market list as a scoring bonus, not a hard filter.** New
   `src/features/discovery/priority-markets.ts` - a static list (the original GPT-proposed
   high-value US-state/EU-country list), a pure `isPriorityMarket(geography)` loose-match check,
   feeding one more additive term into item 2's formula. Geography stays free-text everywhere else
   - this never blocks or rejects a search, same "degrade gracefully" posture as every other source
   in this codebase.

**Real bug caught in review**: the first cut of `isPriorityMarket` matched long state/country names
by plain substring, which incorrectly scored "Charleston, **West Virginia**" as a match on
"Virginia" - a real, distinct, non-priority state. Word-boundary regex alone doesn't fix this
("Virginia" is a genuine whole word inside "West Virginia"). Fixed by splitting `geography` on
commas and requiring an EXACT match on a whole segment, not a substring/word-boundary match on the
raw string. Known accepted limitation left as-is: this still can't distinguish the US state
"Georgia" from the country "Georgia" (an inherent ambiguity of free-text geography, not worth more
machinery to resolve given this app's actual prospect geography today).

## Explicitly deferred to later (do not start these in this branch)

- **Government business registry connectors** - real work, real value, own session later. Decided:
  start with **UK Companies House** (free, English, clean documented REST API - closest analog to
  how Overpass integrated) and **one US state registry** (not all 50 - start with **Texas**, since
  that's where this app's actual prospect data already is, Austin - more relevant than e.g.
  Delaware, which is popular for incorporation/legal domicile but not operational business
  presence). Each new registry needs its own `ProspectSource` enum value/migration - fold in fixing
  the pre-existing debt where `yellowpages`/`overpass` both currently reuse `source: 'manual'`
  because neither has its own enum value either.
- Job board scraping (strong signal, but real anti-bot/ToS risk - LinkedIn/Indeed are harder
  targets than Cloudflare-on-yellowpages, and this session's own Patchright benchmark confirmed
  headless-only stealth doesn't even clear that bar. The `hiring_post` signal already exists and is
  already populated safely today via Indie Hackers Jobs - low incremental value for the risk.)
- Search-engine-as-signal-source scraping (same ToS/anti-bot risk class, arguably worse - Google's
  anti-automation enforcement is more aggressive/automatic than Cloudflare's)
- Full weighted-confidence canonical-company entity resolution engine (the corroboration-count step
  above is the next stepping stone, not the full fuzzy-name/geocoordinate-radius/registration-number
  system described earlier in this doc - that's a genuinely bigger system, later)
- **PostGIS + Leaflet map UI** - decided: wait. Only the new Overpass source currently populates
  `Prospect.location`'s lat/lng (confirmed via code search - every other source leaves it null), so
  a map today would be sparse and skew entirely toward Overpass results, misrepresenting actual
  discovery coverage. Revisit once more sources contribute coordinates (e.g. once a registry
  connector or Google Places - once billing's fixed - adds them). Current prospect volume (dozens/
  low-hundreds) is nowhere near needing PostGIS's actual value-add (spatial querying at scale)
  either way - plain Leaflet + stored lat/lng would be the right scope whenever this does get built.
- Explicit target-market prioritization/config - superseded by the lighter "next slice" item 3
  above (a scoring bonus, not a structured field replacing free-text geography).

## Open technical question to resolve before implementation

Patchright is a Python-first community project. Verify whether a maintained Node.js/TypeScript
port exists that's compatible with this app's Playwright-for-Node usage before committing to the
benchmark - if no viable Node port exists, the CDP-leak-patching benefit may need a different
implementation path (e.g. manually patching the specific documented leaks, on the current
Playwright base) rather than a wholesale library swap.

**Resolved 2026-08-21**: yes, `patchright` on npm is a maintained, actively-published Node.js port
(same maintainer as the Python original, explicit drop-in-replacement claim). Benchmarked against
the current setup - not adopted (see "Status" above and item 1's update for why).
