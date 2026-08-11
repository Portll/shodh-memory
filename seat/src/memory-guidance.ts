/**
 * Memory-use guidance appended to the seat's base system prompt.
 *
 * Every line here targets a failure measured in the baseline evaluation
 * (seat/eval/memory-guidance-ab.mjs, baseline phase, claude-haiku-4-5, N=3):
 *
 * - recall_memory was called ZERO times across 63 baseline cases; the model
 *   treated the 3-memory auto-surfaced block as the whole of memory and
 *   declared details "not recorded" without ever searching. → bullets 1, 2, 4.
 * - Multi-evidence chain cases failed by citing one link (forward-trace 0/3,
 *   propulsion-chain 1/3). → bullet 3, graph-tools bullet.
 * - The absence case drew fabricated citations 3/3. → citation bullet.
 * - MCP-sourced full-UUID citations appeared 4 times; the seat's citation
 *   contract ([mem:<8 hex>], src/feedback.ts) cannot parse them, and MCP
 *   recall results bypass the reinforcement loop (only native recall passes
 *   through onSurfaced, src/memory-tools.ts). → tool-choice + id bullets.
 * - The correction-pair case cited the stale report over the correction
 *   (casualties-identity 1/3). → last bullet.
 *
 * Write hygiene was 6/6 at baseline — deliberately NOT addressed here; the
 * base prompt's existing bullets already cover it and every added line costs
 * context on every turn.
 *
 * The A/B harness injects this text verbatim as the treatment arm, so what is
 * measured is byte-identical to what would ship.
 *
 * ── A/B VERDICT 1 — guidance alone (claude-haiku-4-5, 8 repeats/arm,
 *    168 trials/arm, interleaved, paired permutation test) ───────────────────
 *
 *   Under the original scoring: control 60.7% ± 9.4pp · guidance 67.9% ±
 *   6.1pp · +7.1pp, p = 0.167 — below the pre-registered bar, so guidance
 *   alone stayed unwired. After the absence-rule scoring fix (the rule was
 *   measured misfiring on honest "nothing recorded" answers that cited real
 *   adjacent memories as context; see the absence-honesty case in
 *   memory-guidance-ab.mjs), the same transcripts rescore to 63.7% ± 10.5pp
 *   vs 72.6% ± 6.1pp (+8.9pp, p = 0.065) — still short of the bar.
 *
 * ── A/B VERDICT 2 — mechanism bundle, "mech1" (control ×4 vs bundle ×6
 *    repeats, interleaved, fresh seeded user per run, pinned backend,
 *    paired permutation test) ────────────────────────────────────────────────
 *
 *   This guidance is now WIRED via MemoryMechanisms.guidance
 *   (conversation.ts) as one of five mechanisms measured as a single
 *   ship-candidate bundle: guidance + proactive sample framing + recall
 *   lineage rendering + deterministic verify loop + MCP redundant-tool
 *   filter. Bundle verdict: control 66.7% ± 6.7pp · bundle 88.1% ± 4.0pp ·
 *   mean per-case delta +21.4pp, p = 0.0012 — clears the pre-registered
 *   p < 0.05 bar. Mechanism movement: native recall 0.02 → 1.09 calls/case,
 *   mcp-recall bypass calls 15 → 0, full-UUID contract violations 2 → 0.
 *   Per-mechanism attribution is deliberately NOT factored (one bundle arm
 *   vs one control arm); the control is byte-identical to the pre-mechanism
 *   seat. Residual failures concentrate in the two causal-chain cases —
 *   bounded by the inferred graph substrate (the drift→strike edge was
 *   absent in 7 of 7 probed user graphs), not by prompt or seat mechanics.
 */
export const MEMORY_GUIDANCE = `Working memory effectively:
- The auto-surfaced memory block is a starting point, not the whole of memory. Never say something is absent from memory until recall_memory has searched for it and come back empty.
- Retrieve with recall_memory. Build queries from concrete entity names, identifiers, and quantities rather than abstractions; if a cue misses, reformulate with alternative concrete terms (names, short forms, codes) before giving up.
- Answer multi-part or causal-chain questions one link at a time: recall each link, then answer citing every memory used. A single recall rarely covers a chain.
- When a recalled memory names an entity you need more detail on, recall again with that entity's exact name.
- If graph tools are connected (trace_lineage, explore_entity, list_entities, list_anomalies, search_facts), use them for structure: trace_lineage for what led to or resulted from a memory (causal edges are typed FROM→TO: Caused, ResolvedBy, InformedBy, TriggeredBy, SupersededBy), explore_entity to walk a named person, place, or system, list_anomalies for "anything unusual?" questions. For plain retrieval always use recall_memory, not an MCP recall variant — only native recall feeds the learning loop.
- Cite [mem:<id>] with the 8-character id shown in recall results; for a long UUID, use its first 8 characters. Cite only memories that directly support the sentence they follow; when memory has nothing on a topic, say so plainly and cite nothing.
- Memories can correct earlier ones. When recalled memories conflict, the correction or newer memory wins; cite it and note what it superseded.`;
