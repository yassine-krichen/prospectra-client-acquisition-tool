import type { SignalStrength } from '@/features/prospects/prospect.types';

export interface StaleStackMatch {
  strength: SignalStrength;
  description: string;
}

interface StaleStackRule {
  id: string;
  evaluate(technologies: readonly string[]): StaleStackMatch | null;
}

function extractVersionMajor(technologyName: string): number | null {
  const match = technologyName.match(/(\d+)\.\d+/);
  return match ? Number(match[1]) : null;
}

const MODERN_FRAMEWORK_PATTERN = /(react|vue\.?js|next\.?js|angular|svelte|nuxt)/i;

// EOL/outdated framework signals a BuiltWith tech-stack response can surface.
// Each rule inspects the full technology-name list (not just one entry)
// because some signals - e.g. "WordPress with nothing modern layered on
// top" - depend on what's absent as much as what's present.
const STALE_STACK_RULES: readonly StaleStackRule[] = [
  {
    id: 'eol-jquery',
    evaluate(technologies) {
      const jquery = technologies.find((tech) => /jquery/i.test(tech));
      if (!jquery) return null;

      const major = extractVersionMajor(jquery);

      // jQuery 1.x (EOL since ~2016) and 2.x (EOL since ~2016 too, dropped
      // IE8 support) are both long past maintenance. 3.x+ is still actively
      // maintained, so it isn't flagged.
      if (major !== null && major <= 1) {
        return {
          strength: 'strong',
          description: `jQuery ${major}.x detected - EOL major version`,
        };
      }
      if (major === 2) {
        return { strength: 'medium', description: 'jQuery 2.x detected - EOL major version' };
      }
      if (major === null) {
        return {
          strength: 'weak',
          description: 'jQuery detected without a reported version, alongside no modern JS framework',
        };
      }

      return null;
    },
  },
  {
    id: 'legacy-wordpress-theme',
    evaluate(technologies) {
      const hasWordpress = technologies.some((tech) => /wordpress/i.test(tech));
      const hasModernFramework = technologies.some((tech) => MODERN_FRAMEWORK_PATTERN.test(tech));

      if (hasWordpress && !hasModernFramework) {
        return {
          strength: 'weak',
          description: 'WordPress detected with no modern JS framework layered on top - likely a dated theme-based site',
        };
      }

      return null;
    },
  },
];

const SIGNAL_STRENGTH_ORDER: Record<SignalStrength, number> = {
  weak: 1,
  medium: 2,
  strong: 3,
};

/**
 * Runs the full stale-stack rules table against a BuiltWith technology-name
 * list and returns the strongest match, or `null` if no rule fired.
 */
export function detectStaleStackSignal(technologies: readonly string[]): StaleStackMatch | null {
  const matches = STALE_STACK_RULES.map((rule) => rule.evaluate(technologies)).filter(
    (match): match is StaleStackMatch => match !== null
  );

  if (matches.length === 0) return null;

  return matches.reduce((strongest, match) =>
    SIGNAL_STRENGTH_ORDER[match.strength] > SIGNAL_STRENGTH_ORDER[strongest.strength] ? match : strongest
  );
}
