import { skipToken, useQuery } from "@tanstack/react-query";
import type { RecallResponse } from "@/lib/api";
import {
  corpusKey,
  corpusToRecallMemory,
  type CorpusListResponse,
} from "@/lib/api/corpus";
import { useSession } from "@/stores/session";
import { ScoreBreakdown } from "./ScoreBreakdown";
import { Badge } from "@/components/ui/badge";
import { InfoHint } from "@/components/ui/info-hint";
import { ScrollArea } from "@/components/ui/scroll-area";
import { relName } from "@/features/recall/relation";
import { memoryTier, MEMORY_TIER_LABEL, MEMORY_TIER_MEANING } from "@/features/recall/tier";
import { recallKey } from "@/features/recall/useRecall";
import { EntityDetail } from "./EntityDetail";

/**
 * The Inspector — the single object-detail surface.
 *
 * WORKFLOWS.md: every list in the product feeds this one pane, and it always
 * offers the next hop. That is what makes a click lead somewhere instead of
 * terminating.
 *
 * It reads the recall result from the react-query cache under the same key the
 * result list used, rather than taking it as a prop or refetching. Recall is
 * expensive and its response already contains everything shown here —
 * attribution, lineage, facts. Asking again to render a detail view would pay
 * the full retrieval cost twice for data already in memory.
 *
 * Positioned absolutely rather than as a flex column so the d3 canvas can later
 * take the stage's full width with this floated over its right edge. Until then
 * `main` reserves the same width, so nothing is occluded.
 */

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mt-3">
      <div className="text-muted-foreground/70 mb-1 text-[10px] tracking-wide uppercase">
        {label}
      </div>
      {children}
    </div>
  );
}

function Empty({ body }: { body: string }) {
  return (
    <div className="px-4 py-3">
      <p className="text-muted-foreground text-[12px] leading-relaxed">{body}</p>
    </div>
  );
}

export function Inspector() {
  const profile = useSession((s) => s.profile);
  const query = useSession((s) => s.activeQuery);
  const selectedId = useSession((s) => s.selectedMemoryId);
  const selectedEntityId = useSession((s) => s.selectedEntityId);
  const select = useSession((s) => s.select);

  // TWO CACHES, ONE PANE, and the second one is not an optimisation.
  //
  // Recall now opens onto the corpus rather than onto an instruction: with no
  // query, the result column lists the newest memories and every row selects
  // into this pane exactly like a result. But those rows come from the corpus
  // listing, and the recall cache under an empty query has never been
  // populated — so every one of those clicks landed here, found nothing, and
  // was answered with "search, then select a result". A list whose rows are
  // invitations and whose clicks say "do something else first" is a dead end in
  // the one place the product asks a stranger to start.
  //
  // Both are read with `queryFn: skipToken`, which subscribes to a cache entry
  // and can never issue the request itself. This replaces a bare
  // `getQueryData` read, for a reason the earlier note here did not anticipate:
  // a cache read is not a subscription, and both of these entries resolve
  // underneath an Inspector that is already mounted — the corpus fetch lands on
  // the first paint of /recall, and a fresh recall lands while a memory from the
  // previous result set is still selected. Neither re-rendered this pane, so it
  // went on showing a pre-load message, or a selected memory stripped of the
  // attribution the response had just delivered, until something unrelated
  // happened to re-render it.
  //
  // `skipToken` is specifically what the old note was reaching for and could not
  // name: `enabled: false` with no `queryFn` registers a query that throws on an
  // unpopulated key — which IS the first-paint case here — while `skipToken` is
  // the supported form for "read this key, never fetch it". `useCorpus`/
  // `useRecall` are not reused because both need `Reachability`, which this pane
  // is not given and does not need: it only ever reads what those two wrote.
  const { data } = useQuery<RecallResponse>({
    queryKey: recallKey(profile, query),
    queryFn: skipToken,
  });
  const { data: corpus } = useQuery<CorpusListResponse>({
    queryKey: corpusKey(profile),
    queryFn: skipToken,
  });

  // Preference order matters: a memory present in BOTH is read from the recall
  // response, because that copy carries the retrieval evidence — score
  // attribution, tier as retrieved, and the lineage below. The corpus copy is
  // the fallback and knows none of that.

  const recalled = data?.memories.find((m) => m.id === selectedId);
  const listed = recalled ? undefined : corpus?.memories.find((m) => m.id === selectedId);
  const memory = recalled ?? (listed ? corpusToRecallMemory(listed) : undefined);

  // Chain 2: the causal edges that connect this memory to others in the same
  // result set. The server returns these already — no extra endpoint. A memory
  // reached from the corpus listing has none: lineage is a property of a
  // retrieval, not of a memory, and there is no retrieval to be part of.
  const lineage = (data?.lineage ?? []).filter(
    (e) => e.from === selectedId || e.to === selectedId,
  );

  return (
    <aside
      aria-label="Detail"
      // `min(280px,36vw)` — kept in lockstep with `INSPECTOR_OFFSET` in
      // App.tsx, which reserves exactly this width in `main`. A bare 280px
      // here with a bare 280px there is how the two silently drift; see
      // RecallView.tsx for why a fixed width doesn't survive a narrow
      // viewport at all.
      className="border-border bg-card absolute top-12 right-0 bottom-0 z-20 flex w-[min(280px,36vw)] flex-col border-l"
    >
      {/* The two kinds of object this pane holds answer different questions, so
          the header names the one on screen — but it names it, it no longer
          describes it. "Every belief traces back to the sessions it came from"
          was a claim about the product printed above a panel that then goes on
          to demonstrate it, on every selection, forever. One word does the
          orientation; the panel itself does the rest. */}
      <header className="border-border flex shrink-0 items-baseline gap-2 border-b px-4 py-2.5">
        <h2 className="text-[12px] font-medium tracking-tight">Detail</h2>
        <span className="text-muted-foreground/60 text-[11px]">
          {selectedEntityId ? "entity" : memory ? "memory" : null}
        </span>
      </header>

      <ScrollArea className="min-h-0 flex-1">
        {/* One Inspector, two kinds of object — WORKFLOWS.md's rule is that
            there is a single detail surface, not that everything in the product
            is a memory. An entity is reached from the knowledge graph and has
            no content, tier or score attribution; rendering it through the
            memory branch would mean inventing all three. Selection is mutually
            exclusive in the store, so exactly one of these can be live. */}
        {selectedEntityId ? (
          <EntityDetail />
        ) : !memory ? (
          <Empty
            body={
              data || corpus
                ? "Select a memory or an entity."
                : "This profile's memory is still loading."
            }
          />
        ) : (
          <>
            <div className="px-4 py-3">
              <p className="text-[13px] leading-relaxed">{memory.experience.content}</p>

              {/* `GET /api/list` caps content at 500 characters and says so on
                  the row (src/handlers/crud.rs). Recall does not truncate, so
                  this can only appear on a memory reached from the pre-query
                  listing — and text that silently stops mid-sentence in a pane
                  whose whole job is trust has to be labelled as cut, not left
                  to look like the whole record. */}
              {listed?.content_truncated ? (
                <p className="text-muted-foreground/60 mt-1.5 flex items-center gap-1.5 text-[11px]">
                  {/* The label stays on screen — text that silently stops
                      mid-sentence in a pane whose whole job is trust has to be
                      marked as cut. Why it is cut, and how to get the rest, is
                      mechanism and goes behind the icon. */}
                  Preview · <span className="mono">{listed.content_length}</span> characters in full
                  <InfoHint label="why this is a preview">
                    The corpus listing caps content at 500 characters so one request can carry the
                    whole profile. A search result carries the whole text — the same memory reached
                    from a query shows in full here.
                  </InfoHint>
                </p>
              ) : null}

              {memory.experience.tags.length > 0 ? (
                <Field label="Entities">
                  <div className="flex flex-wrap gap-1">
                    {memory.experience.tags.map((t) => (
                      <Badge key={t}>{t}</Badge>
                    ))}
                  </div>
                </Field>
              ) : null}

              <Field label="Recorded">
                <p className="mono text-[11px]">
                  {new Date(memory.created_at).toLocaleString()}
                </p>
              </Field>

              {memory.experience.geo_location ? (
                <Field label="Coordinates">
                  <p className="mono text-[11px]">
                    {memory.experience.geo_location[0].toFixed(5)},{" "}
                    {memory.experience.geo_location[1].toFixed(5)}
                  </p>
                </Field>
              ) : null}

              {/* The same consolidation step the graph canvas encodes as node
                  presence, named here in words. `memory.tier` is a Rust Debug
                  rendering — `LongTerm` — and putting an identifier on screen
                  asks the reader to know the enum. This is the one surface with
                  room to say what the step MEANS, and it costs nothing here
                  because it is shown for one selected memory rather than on
                  every hover. */}
              <Field label="Consolidation">
                <p className="mono text-[11px]">
                  {MEMORY_TIER_LABEL[memoryTier(memory.tier)]}
                </p>
                <p className="text-muted-foreground/70 mt-0.5 text-[11px]">
                  {MEMORY_TIER_MEANING[memoryTier(memory.tier)]}
                </p>
              </Field>
            </div>

            {/* Chain 2 — the onward hop. Every edge here is a real causal
                relation the server returned, and selecting one moves the
                Inspector to the other end of it. */}
            {lineage.length > 0 ? (
              <section className="border-border border-t px-4 py-3">
                <h3 className="text-[12px] font-medium tracking-tight">What it connects to</h3>
                <div className="mt-2 flex flex-col gap-1">
                  {lineage.map((e, i) => {
                    const otherId = e.from === selectedId ? e.to : e.from;
                    const other = data?.memories.find((m) => m.id === otherId);
                    const outgoing = e.from === selectedId;
                    return (
                      <button
                        key={`${e.from}-${e.to}-${i}`}
                        type="button"
                        onClick={() => select(otherId)}
                        disabled={!other}
                        className="hover:bg-accent/60 focus-visible:ring-ring rounded px-2 py-1.5 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:opacity-50"
                      >
                        {/* `relation` arrives as a Rust Debug rendering —
                            `CausedBy`, or `Custom("depends on")` with the
                            quotes on the wire (src/handlers/recall.rs:985).
                            `relName` is the only thing standing between that
                            and Rust syntax on screen.

                            The confidence beside it is the server's own, and
                            it is the point: an edge without a strength is an
                            assertion, an edge with one is evidence. */}
                        <span className="text-primary mono text-[10px]">
                          {outgoing ? "→" : "←"} {relName(e.relation)}
                          <span className="text-muted-foreground/70">
                            {" "}
                            {e.confidence.toFixed(2)}
                          </span>
                        </span>
                        <span className="text-muted-foreground mt-0.5 line-clamp-2 block text-[11px] leading-relaxed">
                          {other?.experience.content ?? "Outside this result set"}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </section>
            ) : null}

            {memory.score_attribution ? (
              <ScoreBreakdown attr={memory.score_attribution} />
            ) : null}
          </>
        )}
      </ScrollArea>
    </aside>
  );
}
