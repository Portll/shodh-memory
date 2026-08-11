/**
 * Lineage relation naming and classing.
 *
 * `RecallLineageEdge.relation` is produced by `format!("{:?}", edge.relation)`
 * (src/handlers/recall.rs:985, :998) — a Rust *Debug* rendering, not a display
 * string. So the wire carries `CausedBy`, `Precedes`, and for user-defined
 * relations the literal `Custom("depends on")` with the quotes and parentheses
 * in the payload. Rendering that raw puts Rust syntax on screen.
 *
 * Both helpers are ports of the old vanilla dashboard's, which were validated
 * against the live GDELT corpus: `relName` from front/index.html:569 and
 * `relClass` from front/index.html:1643-1649. That file has since been deleted
 * — the React app replaced the last thing it was needed for — so every
 * front/index.html line number in this repo resolves in git history, not in
 * the tree. They are kept because they are the provenance of what was ported.
 */

/** `Custom("hit by")` → `hit by`; `CausedBy` → `Caused By`. */
export function relName(relation: string): string {
  const custom = /Custom\("(.+)"\)/.exec(relation);
  return (custom ? custom[1] : relation).replace(/([a-z])([A-Z])/g, "$1 $2");
}

/**
 * Relation classes, in the order they matter to this product.
 *
 * `causal` is the signal: the causal spine is what distinguishes this from a
 * co-occurrence hairball, so those edges are drawn bright and everything else
 * recedes. `weak` is generic co-occurrence — present in bulk, meaning almost
 * nothing on its own.
 */
export type RelationClass = "causal" | "typed" | "loc" | "weak";

export function relClass(relation: string): RelationClass {
  // Strip quotes and parens too, so `Custom("Precedes")` classes as its inner
  // relation rather than falling through to `typed`.
  const r = (relation || "").replace(/[\s_"()-]/g, "").toLowerCase();
  if (!r || r === "cooccurs" || r === "relatedto" || r === "coretrieved" || r === "associatedwith") {
    return "weak";
  }
  if (
    /caus|trigger|resultsin|struck|rammed|damaged|closed|killed|leadsto|precede|collapsedinto|destroyed|hitby/.test(
      r,
    )
  ) {
    return "causal";
  }
  if (r.startsWith("located")) return "loc";
  return "typed";
}
