// Vendored from github.com/blader/humanizer (MIT-licensed portable agent
// skill: a static SKILL.md of rewrite instructions removing 33 detected
// AI-writing patterns). This codebase has no interactive agent harness to
// load a skill file into, so the methodology is reformulated here as plain
// instructional prompt text fed straight into a completion-API call,
// rather than the original Markdown frontmatter/loader format the upstream
// skill ships as. Pattern list confirmed against the upstream skill's own
// documented catalogue (33 patterns across content, language/grammar,
// style, communication, and filler/hedging categories), not guessed.

/**
 * Rewrite instructions for making a draft read as human-written, following
 * the humanizer skill's documented 33-pattern catalogue. Composed by
 * `buildHumanizePrompt` (prompt-templates.ts) alongside this app's own hard
 * constraints (word count, one-observation/one-soft-ask, banned phrases) and
 * `fenceUntrustedData`.
 */
export const HUMANIZER_SKILL_INSTRUCTIONS = `Rewrite the text to remove AI-writing tells, without changing its meaning
or adding anything not already present in it. Fix these patterns wherever
they appear:

Content patterns:
- Undue emphasis on significance ("pivotal moment", "marks a shift") ->
  state the fact directly, no editorializing about its importance
- Undue emphasis on notability (listing every outlet/source that covered
  something) -> cut the list, keep only a specific citation if one exists
- Superficial "-ing" analysis tacked onto a sentence ("highlighting...",
  "reflecting...") to fake depth -> cut it or make the point directly
- Promotional/travel-brochure language ("vibrant", "nestled", "stunning")
  -> replace with a neutral, concrete description
- Vague attribution ("experts argue", "observers cite") with no named
  source -> cut the attribution, state the point directly, or drop the
  claim if it can't be supported without inventing a source
- Formulaic "despite challenges..." boilerplate -> compress or cut it

Language and grammar patterns:
- Overused AI vocabulary ("tapestry", "interplay", "crucial", "underscore",
  "delve into", "leverage" as a verb, "robust", "seamless", "cutting-edge",
  "navigate" as in "navigate this challenge") -> replace with plain,
  ordinary words
- Copula avoidance ("serves as", "boasts", "features") -> use "is"/"are"/
  "has" instead
- Negative parallelism ("not only X but also Y") -> rewrite as a plain,
  direct statement of X and Y
- Rule-of-three overuse (forcing everything into triplets, e.g. "clear,
  concise, and compelling") -> use however many items actually fit, don't
  pad or trim to exactly three
- Elegant variation (cycling through synonyms for the same thing instead of
  repeating the term) -> repeat the key term instead
- False ranges ("from X to Y") when the endpoints aren't meaningfully
  scaled -> state the actual point instead of a fake range
- Passive voice and subjectless fragments -> use active voice, name the
  actor

Style patterns:
- Em-dash overuse -> remove them; use a period, comma, colon, or restructure
  the sentence instead
- Overuse of boldface on ordinary terms/acronyms -> strip mechanical bolding
- Inline-header lists (a bolded label + colon used as a mini-heading) ->
  convert into flowing prose
- Title-case headings -> use standard sentence capitalization
- Decorative emojis in headings/bullets -> remove them
- Curly quotation marks -> use straight quotes

Communication patterns:
- Collaborative-assistant artifacts ("I hope this helps", "let me know if",
  "want me to...") -> cut them, this is an email, not a chat reply
- Speculative knowledge-cutoff disclaimers or gap-filling -> state only what
  is actually known, or omit the point
- Sycophantic tone ("great question", "excellent point", over-validating) ->
  cut it

Filler and hedging patterns:
- Filler phrases ("due to the fact that" -> "because", "in order to" -> cut
  "in order")
- Excessive hedging ("could potentially possibly") -> trim to a single plain
  qualifier ("may")
- Generic upbeat closers with no content -> cut them, end on a concrete point
- Hyphenated-pair overuse in predicate position ("the results were
  high-quality") -> drop the hyphen ("were high quality")
- Persuasive-authority tropes ("the real question is...") -> state the point
  directly instead
- Signposting/announcements ("let's dive in", "here's what you need to
  know") -> cut them, get to the point
- A one-line restatement paragraph immediately after a heading that just
  repeats the heading -> cut it
- Diff-anchored writing (describing something only in terms of how it
  changed from before) -> describe it as it is
- Manufactured staccato punchlines -> vary sentence length naturally instead
- Aphorism formulas ("X is the language of Y") -> replace with a concrete,
  specific claim
- Theatrical rhetorical openers ("Honestly?", dramatic pauses) -> cut them,
  state the point directly

Hard rule: never invent facts. The rewrite must contain no fact, name,
number, date, quote, or citation absent from the original text - only
wording, structure, and phrasing may change. Swap a vague phrase for a
specific one only when that specific detail already exists in the source;
if a sentence would need invented real-world detail to read naturally,
write the plainer, less specific version instead.`;
