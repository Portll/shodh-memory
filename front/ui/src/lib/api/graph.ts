import { api } from "./client";

/**
 * The entity knowledge graph — `GET /api/graph/{user_id}/universe`
 * (src/handlers/router.rs:241-244 → graph::get_memory_universe,
 * src/handlers/graph.rs:211-228).
 *
 * This is a DIFFERENT question from the lineage canvas on /recall. Lineage
 * answers "how do these recalled memories cause each other" and is scoped to
 * one result set. This answers "what does this corpus know" — the typed
 * entities and typed relations that exist whether or not anyone has run a
 * query. Both are needed; neither substitutes for the other.
 *
 * The endpoint takes no query parameters and no body (graph.rs:211-214 is
 * `State` + `Path` only), and it is UNCAPPED: `get_universe`
 * (src/graph_memory.rs:7104-7220) returns every entity and every relationship.
 * That is the whole reason the client does its own budgeting and clustering —
 * see universe.ts.
 */

/** `Position3D` — src/graph_memory.rs:7271-7277. Server-computed layout on a
 *  golden-angle spiral with one gravitational relaxation pass. This client runs
 *  its own force layout, so these are received and ignored. */
export interface Position3D {
  x: number;
  y: number;
  z: number;
}

/**
 * `UniverseStar` — src/graph_memory.rs:7279-7291. One ENTITY.
 *
 * No serde attributes anywhere in this struct family: field names are the
 * snake_case Rust names verbatim, and `entity_type` has no
 * `skip_serializing_if`, so it is explicitly `null` for an entity with no
 * labels rather than absent (graph_memory.rs:7134).
 *
 * Note there is NO memory id here. An entity does not carry the memories that
 * mention it, which is why the graph cannot open a memory in the Inspector
 * directly the way the lineage canvas can.
 */
export interface UniverseStar {
  id: string;
  name: string;
  /** `EntityLabel::as_str()` — src/graph_memory.rs:254-288. One of ~35
   *  Title-Cased values: Person, Organization, Location, Technology, Concept,
   *  Event, Date, Product, Skill, Keyword, Project, Task, Document, Repository,
   *  Service, Database, Metric, Configuration, Environment, Pipeline, Team,
   *  Role, Module, Norp, Gpe, Facility, Vehicle, Weapon, Work, Law, Title,
   *  Cyber, Money, Quantity, Time. `null` when the entity has no label. */
  entity_type: string | null;
  salience: number;
  mention_count: number;
  is_proper_noun: boolean;
  position: Position3D;
  /** Server-assigned hex from `entity_type_color` (graph_memory.rs:7229-7268).
   *  Deliberately unused: that palette is not this product's design system, and
   *  colour here comes from the `--node-*` tokens instead. */
  color: string;
  /** `5.0 + salience * 20.0` (graph_memory.rs:7140). Recomputed client-side. */
  size: number;
}

/**
 * `GravitationalConnection` — src/graph_memory.rs:7293-7303. One typed relation.
 *
 * The endpoints are `from_id`/`to_id`, NOT d3's `source`/`target`, so the
 * layout has to remap. `strength` is `rel.effective_strength()` — decay-aware,
 * so it is the current weight rather than the weight at write time.
 */
export interface GravitationalConnection {
  id: string;
  from_id: string;
  to_id: string;
  /** `RelationType::as_str()` — WorksWith, LocatedIn, Uses, PartOf, Contains,
   *  CreatedBy, … plus generic CoOccurs/CoRetrieved/RelatedTo bulk. */
  relation_type: string;
  strength: number;
  /** `EdgeTier` — src/graph_memory.rs:493-501. Serde derive with no
   *  `rename_all`, so the wire values are the variant names verbatim.
   *  L1 working (new, dense, aggressive decay) → L2 episodic (proven) →
   *  L3 semantic (consolidated, near-permanent). */
  tier: "L1Working" | "L2Episodic" | "L3Semantic";
  from_position: Position3D;
  to_position: Position3D;
}

/** `UniverseBounds` — src/graph_memory.rs:7305-7310. */
export interface UniverseBounds {
  min: Position3D;
  max: Position3D;
}

/**
 * `MemoryUniverse` — src/graph_memory.rs:7312-7320.
 *
 * `total_entities`/`total_connections` are the FULL lengths, not a page count:
 * the handler applies no cap, so they always equal `stars.length` and
 * `connections.length`. They are still read rather than derived, because they
 * are what the server states and any future cap would show up as a divergence.
 */
export interface MemoryUniverse {
  stars: UniverseStar[];
  connections: GravitationalConnection[];
  total_entities: number;
  total_connections: number;
  bounds: UniverseBounds;
}

export function fetchUniverse(userId: string, signal?: AbortSignal): Promise<MemoryUniverse> {
  return api.get<MemoryUniverse>(`/api/graph/${encodeURIComponent(userId)}/universe`, signal);
}

// =============================================================================
// ENTITY → MEMORIES
// =============================================================================

/**
 * The hop from an entity back to the memories it was extracted from.
 *
 * There is no purpose-built "memories for this entity" endpoint. The exact
 * reverse index exists in the store — `get_episodes_by_entity`
 * (src/graph_memory.rs:5003-5050) is literally this lookup — but no HTTP
 * handler routes it. What IS routed is edge provenance, and that is enough,
 * because of one fact that makes the whole hop work:
 *
 *   An episode's uuid IS the memory id. Episodes are created with
 *   `uuid: memory_id.0` (src/handlers/state.rs:3349-3350) and the idempotency
 *   check reads `get_episode(&memory_id.0)` (state.rs:3302).
 *
 * So every `source_episode_id` on a relationship edge is a memory id, and
 * `POST /api/graph/episode/get` hydrates it into readable content.
 *
 * ONE HONEST LIMIT, surfaced in the UI rather than hidden: this is
 * edge-derived. An edge only exists between two entities, so a memory whose
 * extraction produced fewer than two entities creates no edge and is invisible
 * here (the pair loop at state.rs:3373+). This finds memories that connected
 * this entity to another, not every memory that named it.
 */

/** `TraverseGraphRequest` — src/handlers/graph.rs:96-100. */
export interface TraverseRequest {
  user_id: string;
  entity_name: string;
  max_depth?: number;
}

/** `ProvenanceRecord` — src/graph_memory.rs:771-786. One source episode that
 *  attested an edge. `source_episode_id` is a memory id. */
export interface ProvenanceRecord {
  source_episode_id: string;
  mention_count: number;
  first_observed: string;
  last_observed: string;
  confidence?: number | null;
  evidence_span?: [number, number] | null;
}

/** `RelationshipEdge` — src/graph_memory.rs:638-680. Only the fields this hop
 *  reads; the struct also carries Hebbian activation counters and timestamps. */
export interface RelationshipEdge {
  uuid: string;
  from_entity: string;
  to_entity: string;
  strength: number;
  /** The episode that created this relationship — a memory id when present. */
  source_episode_id?: string | null;
  context: string;
  /** Up to 8 attesting sources (PROVENANCE_MAX_SOURCES_DEFAULT). */
  provenance?: ProvenanceRecord[];
}

/** `GraphTraversal` — src/graph_memory.rs:7334-7338. `relationships` covers the
 *  whole traversed subgraph, not just edges touching the queried entity, so
 *  callers must filter on `from_entity`/`to_entity` themselves. */
export interface GraphTraversal {
  entities: unknown[];
  relationships: RelationshipEdge[];
}

/** `POST /api/graph/traverse` — src/handlers/router.rs:263, graph.rs:103-137.
 *  404s with `EntityNotFound` when the name does not resolve. */
export function traverseEntity(req: TraverseRequest, signal?: AbortSignal): Promise<GraphTraversal> {
  return api.post<GraphTraversal>("/api/graph/traverse", { max_depth: 1, ...req }, signal);
}

/** `EpisodicNode` — src/graph_memory.rs:2134-2158. Only what this hop renders.
 *  `uuid` is the memory id; `content` is the memory text. */
export interface EpisodicNode {
  uuid: string;
  content: string;
  created_at?: string;
  entity_refs?: string[];
}

/** `POST /api/graph/episode/get` — src/handlers/router.rs:264, graph.rs:141-144.
 *  Returns `null` (Rust `Option::None`) when the episode is unknown. */
export function fetchEpisode(
  userId: string,
  episodeUuid: string,
  signal?: AbortSignal,
): Promise<EpisodicNode | null> {
  return api.post<EpisodicNode | null>(
    "/api/graph/episode/get",
    { user_id: userId, episode_uuid: episodeUuid },
    signal,
  );
}
