import type { DiscoveredProspect } from '@/features/discovery/discovery.types';
import { extractDomain, normalizeDomain } from '@/features/discovery/normalize-domain';

import type { AgenticProspectLine } from './prospect-line.schema';

/**
 * Reshapes one validated agent-produced JSONL line into the
 * `DiscoveredProspect` shape the real discovery pipeline (`dedupeProspects`/
 * `persistProspect` in discovery.service.ts) already expects, so this
 * standalone tool can feed the exact same downstream code every other
 * discovery source uses rather than duplicating dedupe/persist logic.
 */
export function mapToDiscoveredProspect(line: AgenticProspectLine): DiscoveredProspect {
  const domain = line.domain ? normalizeDomain(line.domain) : extractDomain(line.websiteUrl);

  const evidence = line.secondarySignal
    ? `${line.evidenceSummary} | Secondary: ${line.secondarySignal}`
    : line.evidenceSummary;

  return {
    companyName: line.companyName,
    domain,
    websiteUrl: line.websiteUrl,
    industry: line.industry,
    location: {
      city: line.city,
      country: line.country,
      lat: null,
      lng: null,
    },
    companySize: line.companySize,
    source: 'ai_agent',
    sourceUrl: line.evidenceUrl,
    discoveredAt: new Date(),
    signal: {
      type: line.signalType,
      description: line.signalDescription,
      evidence,
      strength: line.signalStrength,
    },
    phone: line.phone,
    address: line.address,
    // Starts at 1 for a freshly-discovered prospect, same as every other
    // discovery source - `dedupeProspects`/`persistProspect` increment this
    // further when a match is found.
    corroboratingSourceCount: 1,
  };
}
