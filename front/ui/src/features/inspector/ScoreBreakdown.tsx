import { cn } from "@/lib/utils";
import type { ScoreAttribution } from "@/lib/api";
import { Badge } from "@/components/ui/badge";

/**
 * Why this memory surfaced.
 *
 * The server already computes all of this — `ScoreAttribution` in
 * src/memory/types.rs is filled on every recall with `debug: true`. Nothing
 * here is derived, estimated or invented; it is the retrieval pipeline's own
 * account of its own decision, which is the whole reason it can be shown to
 * someone who has to trust the answer.
 *
 * The design problem is that there are eighteen fields and most of them are
 * 1.0 on most memories. Rendering all of them produces a wall in which the two
 * numbers that actually moved are indistinguishable from the fifteen that did
 * not. So the multiplicative factors are filtered to those that deviate from
 * neutral, and the rest are counted rather than listed.
 *
 * The two groups are genuinely different quantities and are not mixed:
 *   - `rrf_base` and its two parts are ADDITIVE reciprocal-rank fusion scores.
 *   - Everything else is a MULTIPLIER where 1.0 means "changed nothing".
 * Showing them in one list would imply they combine the same way. They do not.
 */

/** Multipliers, in pipeline order. Layer numbers are the server's own. */
const FACTORS: { key: keyof ScoreAttribution; label: string; hint: string }[] = [
  { key: "hebbian_boost", label: "Hebbian", hint: "Learned co-activation weight between this memory and the cue" },
  { key: "attribute_boost", label: "Attribute", hint: "Layer 4.5 — query named an attribute this memory carries" },
  { key: "temporal_prefilter_boost", label: "Temporal filter", hint: "Layer 4.45 — fell inside the query's time window" },
  { key: "temporal_fact_boost", label: "Temporal fact", hint: "Layer 4.55 — a dated fact supports it" },
  { key: "interference_adjustment", label: "Interference", hint: "Layer 4.6 — adjusted for competition with similar memories" },
  { key: "prospective_boost", label: "Prospective", hint: "Layer 4.7 — a pending intention pointed at it" },
  { key: "fact_source_boost", label: "Fact source", hint: "Layer 4.8 — it is the source of a semantic fact" },
  { key: "ontological_boost", label: "Ontological", hint: "Layer 4.9 — entity types matched the query's shape" },
  { key: "importance_factor", label: "Importance", hint: "Layer 5 — stored importance" },
  { key: "recency_factor", label: "Recency", hint: "Layer 5 — decay by age" },
  { key: "arousal_factor", label: "Arousal", hint: "Layer 5 — emotional salience at encoding" },
  { key: "credibility_factor", label: "Credibility", hint: "Layer 5 — source credibility" },
  { key: "feedback_multiplier", label: "Feedback", hint: "Layer 5 — reinforcement from past use" },
  { key: "quality_gate", label: "Quality gate", hint: "Content richness" },
];

/**
 * The retrieval legs, in the words the result rows use.
 *
 * `sources` carries the server's own tokens — `"graph"` and `"vector"`, pushed
 * at src/memory/mod.rs:4172 and :4226 — and printing them raw put two things on
 * screen that should not have been there. `vector` is a lie by omission: it
 * labels the HYBRID leg, which is BM25 and vector search already fused
 * (mod.rs:4176-4196), so a reader is told "vector" about a result an exact
 * keyword match found. And it contradicted the same fact stated in words one
 * pane to the left, on the row this panel is explaining (features/recall/why.ts).
 *
 * An unknown token is shown verbatim rather than dropped: this is the panel
 * whose entire job is to account for the score, and silently discarding a leg
 * the server said contributed would be the one failure it cannot have.
 */
const LEG_LABEL: Record<string, string> = {
  vector: "Meaning and wording",
  graph: "The graph",
};

/** A multiplier is "neutral" if it left the score alone. Float noise means an
 *  exact 1.0 comparison would leak 0.9999 rows into the list. */
const NEUTRAL_EPSILON = 0.005;
const isNeutral = (v: number) => Math.abs(v - 1) < NEUTRAL_EPSILON;

/**
 * Lift/reduce is data, not chrome or an alarm — a multiplier below 1 is
 * ordinary attenuation (recency decay, interference), not a fault. Coding it
 * in `--primary`/`--destructive` would be exactly the collision DIRECTION.md
 * warns about: those two are reserved for chrome-focus and real alarms, and
 * routine dampened factors flashing destructive-red would train people to
 * ignore red in the one panel where an actual anomaly also has to read as
 * one. Direction is carried by an arrow glyph plus weight instead of hue.
 */
function Row({ label, hint, value }: { label: string; hint: string; value: number }) {
  const lifts = value > 1;
  return (
    <div className="flex items-baseline justify-between gap-3 py-1" title={hint}>
      <span className="text-muted-foreground truncate text-[11px]">{label}</span>
      <span
        className={cn(
          "mono flex shrink-0 items-baseline gap-1 text-[11px]",
          lifts ? "text-foreground" : "text-muted-foreground",
        )}
      >
        <span aria-hidden="true" className="text-[9px]">
          {lifts ? "↑" : "↓"}
        </span>
        ×{value.toFixed(2)}
      </span>
    </div>
  );
}

export function ScoreBreakdown({ attr }: { attr: ScoreAttribution }) {
  const moved = FACTORS.filter((f) => !isNeutral(attr[f.key] as number));
  const neutralCount = FACTORS.length - moved.length;

  // Which legs found it at all. This is the single most decodable line in the
  // panel — "vector and graph both found this" is a stronger statement about
  // relevance than any of the multipliers.
  const sources = attr.sources.filter(Boolean);

  return (
    <section className="border-border border-t px-4 py-3">
      <h3 className="text-[12px] font-medium tracking-tight">Why this surfaced</h3>

      {sources.length > 0 ? (
        <>
          <p className="text-muted-foreground/70 mt-2 text-[11px]">
            Reached by
          </p>
          <div className="mt-1 flex flex-wrap gap-1">
            {sources.map((s) => (
              <Badge key={s}>{LEG_LABEL[s] ?? s}</Badge>
            ))}
          </div>
        </>
      ) : null}

      {/* Additive fusion base, split by leg. */}
      <div className="mt-3">
        <div className="text-muted-foreground/70 mb-1 text-[10px] tracking-wide uppercase">
          Fusion base
        </div>
        <div className="flex items-baseline justify-between gap-3 py-1">
          <span className="text-muted-foreground text-[11px]">Graph</span>
          <span className="mono text-[11px]">{attr.graph_rrf.toFixed(4)}</span>
        </div>
        <div className="flex items-baseline justify-between gap-3 py-1">
          <span className="text-muted-foreground text-[11px]">Vector + keyword</span>
          <span className="mono text-[11px]">{attr.hybrid_rrf.toFixed(4)}</span>
        </div>
        <div className="border-border mt-1 flex items-baseline justify-between gap-3 border-t py-1">
          <span className="text-[11px]">Combined</span>
          <span className="mono text-[11px]">{attr.rrf_base.toFixed(4)}</span>
        </div>
      </div>

      {/* Multipliers that actually did something. */}
      <div className="mt-3">
        <div className="text-muted-foreground/70 mb-1 text-[10px] tracking-wide uppercase">
          Adjustments
        </div>
        {moved.length > 0 ? (
          moved.map((f) => (
            <Row key={f.key} label={f.label} hint={f.hint} value={attr[f.key] as number} />
          ))
        ) : (
          <p className="text-muted-foreground/70 py-1 text-[11px]">
            None. This ranked on retrieval alone.
          </p>
        )}
        {neutralCount > 0 ? (
          <p className="text-muted-foreground/60 mt-1.5 text-[10px]">
            {neutralCount} further factor{neutralCount === 1 ? "" : "s"} left the score unchanged.
          </p>
        ) : null}
      </div>

      {/* Weight carries the emphasis, not the accent — this is the query's
          own retrieval math, not a focus target or a call to action. */}
      <div className="border-border mt-3 flex items-baseline justify-between gap-3 border-t pt-2">
        <span className="text-[11px] font-semibold">Final score</span>
        <span className="mono text-foreground text-[11px] font-semibold">
          {attr.final_score.toFixed(4)}
        </span>
      </div>
    </section>
  );
}
