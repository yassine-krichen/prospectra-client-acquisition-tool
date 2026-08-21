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

## Explicitly deferred to later (do not start these in this branch)

- Government business registry connectors (per-country, real work, real value - own project later)
- Job board scraping (strong signal, but real anti-bot/ToS risk - LinkedIn/Indeed are harder
  targets than Cloudflare-on-yellowpages, not a good next fight)
- Search-engine-as-signal-source scraping (same ToS/anti-bot risk class, arguably worse)
- Full weighted-confidence canonical-company entity resolution engine (today's lighter dedup
  upgrade is the stepping stone, not the destination)
- PostGIS + Leaflet map UI
- Full buying-signal scoring engine (this app already has a simpler analog -
  `computeServiceSuggestions`/`projectFit`/`estimatedBudget` in `service-matching-rules.ts` - the
  GPT-proposed model is a real upgrade to that, later)
- Explicit target-market prioritization/config (geography stays free-text for now)

## Open technical question to resolve before implementation

Patchright is a Python-first community project. Verify whether a maintained Node.js/TypeScript
port exists that's compatible with this app's Playwright-for-Node usage before committing to the
benchmark - if no viable Node port exists, the CDP-leak-patching benefit may need a different
implementation path (e.g. manually patching the specific documented leaks, on the current
Playwright base) rather than a wholesale library swap.
