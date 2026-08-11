import type { RecallLineageEdge, RecallMemory } from "@/lib/api";

/**
 * The one line of "why is this here" that belongs on the row itself.
 *
 * The full account already exists — `ScoreBreakdown` renders every factor the
 * server attributed — but it lives in the Inspector, which is one click and one
 * decision away. A list of ranked results with no stated reason reads as a
 * black box no matter how good the panel behind it is, so the strongest single
 * sentence comes forward and the arithmetic stays where it was.
 *
 * WHICH SENTENCE IS STRONGEST. `ScoreBreakdown` already says it in its own
 * comment: which legs found the memory at all is the most decodable thing in
 * the panel. "The graph reached this, nothing in the text matched" is a claim
 * about the product that a person can check by reading the memory; "×0.87
 * recency" is not.
 *
 * WHAT THE LEG NAMES MEAN, EXACTLY. `ScoreAttribution.sources` carries at most
 * two values, both pushed in src/memory/mod.rs:
 *
 *   "graph"  (mod.rs:4172) — the memory was in the graph leg: spreading
 *            activation reached it from the entities the cue touched.
 *   "vector" (mod.rs:4226-4227) — the memory was in the HYBRID leg, which is
 *            BM25 and vector search fused before this point (mod.rs:4176-4196).
 *            The name is the server's; it does not mean the vector leg alone,
 *            and the copy below must not claim it does. That is why the phrase
 *            is "meaning and wording" and not "vector".
 *
 * Anything else the server may push in future is ignored rather than printed:
 * a raw enum token on a result row would be exactly the jargon leak this file
 * exists to prevent.
 *
 * ABSENT MEANS ABSENT. `score_attribution` only arrives with `debug: true`, and
 * corpus rows (the pre-query listing) have no attribution at all because they
 * were never retrieved. Both cases return null and the row renders no line —
 * never a placeholder, never a guess.
 */

export interface Why {
  /** Which legs reached it, in plain words. Null when the server said nothing. */
  legs: string | null;
  /** How many other results in this set it is causally linked to. */
  links: number;
}

export function whyItSurfaced(
  memory: RecallMemory,
  lineage: RecallLineageEdge[] | undefined,
): Why | null {
  const sources = memory.score_attribution?.sources ?? [];
  const byGraph = sources.includes("graph");
  const byHybrid = sources.includes("vector");

  const legs = byGraph
    ? byHybrid
      ? "Meaning, wording and the graph"
      : // The differentiator, stated where it happens: nothing in the text
        // matched, and it surfaced anyway because activation travelled to it.
        "No text matched — the graph reached it"
    : byHybrid
      ? "Meaning and wording"
      : null;

  // Distinct partners, not edge count: two edges between the same pair would
  // otherwise read as two connected memories.
  const partners = new Set<string>();
  for (const edge of lineage ?? []) {
    if (edge.from === memory.id) partners.add(edge.to);
    else if (edge.to === memory.id) partners.add(edge.from);
  }

  if (legs === null && partners.size === 0) return null;
  return { legs, links: partners.size };
}
