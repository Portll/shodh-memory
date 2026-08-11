# MCP capability map

What an agent can actually do with shodh-memory through the MCP server, established by
calling every tool against a live backend rather than by reading the source.

- Server source pinned at commit `4baef94c` (`mcp-server/index.ts`, 6294 lines).
- Read-only calls ran against the demo backend on `127.0.0.1:3030`, user `demo`:
  74 memories, 341 graph entities, 1542 graph edges, 113 causal edges, 3 todos, 0 facts.
- Every write ran against a disposable store on `127.0.0.1:3097`, seeded from the same
  `seat/eval/seed-demo-corpus.mjs`. See [Method and scope](#method-and-scope) for the split.
- Verbatim output below is trimmed but never paraphrased. Latency is wall time for the
  whole MCP round trip, including the HTTP hop to the backend.

---

## What the server exposes

| Surface | Observed over stdio | Declared in source | Match |
|---|---|---|---|
| Tools | 51 | 51 | yes |
| Prompts | 6 | 6 | yes |
| Resources | 34 (4 static + 30 memory URIs) | 4 static + up to 30 memories | yes |
| Resource templates | 4 | 4 | one is not implemented |

`serverInfo` is `{"name":"shodh-memory","version":"0.2.0"}` and capabilities are
`{"prompts":{},"resources":{},"tools":{}}`. The tool count matches the source exactly;
there is no drift between what the file declares and what the running server advertises.

The memory resource list is capped at 30 by `.slice(0, 30)` in the list handler, so on the
74-memory demo corpus an agent browsing resources sees 40 percent of the store with no
indication that the list is truncated. It is a browsing aid, not an inventory.

One of the four declared resource templates, `shodh://search/{query}`, has no read handler.
Reading it fails with `Unknown resource: search/bridge%20collapse`. See [F1](#f1).

---

## Capability groups

### 1. Store and retrieve

The core loop. This is the part that works well.

| Tool | Needs | Returns | Latency | Verdict |
|---|---|---|---|---|
| `remember` | `content`; 23 optional fields | formatted receipt with the new UUID | 200-2500 ms | Solid |
| `recall` | `query`; 17 optional filters | ranked memories with scores, ids, tiers, plus a lineage block | 210-620 ms | Solid, one broken filter |
| `recall_by_tags` | `tags[]` | memories with their full auto-extracted tag lists | 4-210 ms | Solid |
| `read_memory` | `memory_id` (UUID or 8-char prefix) | full body, type, tier, tags, parent/children | 5 ms | Solid |
| `list_memories` | optional `limit` | id + type + tier per memory, with a type histogram | 6-10 ms | Solid |
| `context_summary` | optional flags | recent decisions and learnings, truncation-marked | 5-9 ms | Solid |
| `proactive_context` | `context` | surfaced memories, detected entities, due reminders | 245-436 ms | Solid; writes by default |

`recall` is the single most useful tool in the server. On the buried three-memory warning
thread it did the job the corpus was built to test — the query "was there any warning sign
before the Dali incident" returned the port-state inspection, the electrician's shift note
and the deferred breaker overhaul at ranks 2, 3 and 4, ahead of 50 routine port-ops
memories. Geo filtering is a genuine hard filter: a 5 km radius around Annapolis returned
exactly the one off-corridor truck ping and nothing else.

Output is designed for a model to act on. Every memory carries its id, so the
`recall` to `read_memory` to `trace_lineage` chain is self-serving; truncated previews carry
an explicit marker with real character counts and a `read_memory("<id>")` hint rather than
silently cutting text.

`remember` accepts a wide field set (affect, episode sequencing, robotics telemetry, geo,
hierarchy) and all of it is accepted without error. Whether the robotics and affect fields
change retrieval was not testable on this corpus; see [Not exercised](#not-exercised).

Two cautions:

- `proactive_context` defaults to `auto_ingest: true`. It stores the context you pass as a
  new Conversation memory. That is documented in the parameter description, but it means the
  tool an agent is told to "call with every user message" is a write, not a read. The write
  is asynchronous: immediately after a call reporting `[Context ingested: 67af3349-...]`,
  `list_memories` and `memory_stats` still showed the old count; the memory was present in
  the store when queried later.
- `recall`'s `tags` filter is broken. See [F2](#f2).

### 2. Causal lineage

The differentiated capability, and the one whose usefulness depends most on the corpus.

| Tool | Needs | Returns | Latency | Verdict |
|---|---|---|---|---|
| `list_causal_edges` | optional `limit` | totals by relation, confidence, top edges with `edge_id` | 10-31 ms | Useful; the entry point |
| `trace_lineage` | `memory_id` | edges by direction, plus root cause when tracing backward | 3-10 ms | Useful; mislabelled depth |
| `add_causal_link` | `from_memory_id`, `to_memory_id`, `relation` | the recorded edge at 100 percent confidence | 12-14 ms | Works; vocabulary trap |
| `validate_causal_link` | `edge_id`, `verdict` | confirmation or deletion | 8-10 ms | Works |

`list_causal_edges` is the right first call: it is the only tool that emits `edge_id`, which
`validate_causal_link` requires, and it prints both endpoints of every edge with previews,
so an agent can pick a chain to trace without any other call.

`add_causal_link` behaves well once you get the relation name right — it accepts 8-character
id prefixes, rejects self-links with a clear message ("a memory cannot cause itself"), and
the edge is immediately visible to `trace_lineage`, including as a root cause.

On the demo corpus the automatic extraction is weaker than the tooling around it. Of 113
inferred edges the average confidence is 25 percent and only one is confirmed. The seeded
four-step chain (breaker trip, propulsion loss, pier strike, collapse) is not fully linked:
the pier-strike memory has four outgoing edges and zero incoming ones, so
`trace_lineage(direction:"backward")` on the most obvious "why did the bridge collapse"
memory returns nothing. That is an extraction gap, not a tool gap, but an agent hits it
first through this tool. See [F3](#f3) and [F4](#f4).

### 3. Knowledge graph

| Tool | Needs | Returns | Latency | Verdict |
|---|---|---|---|---|
| `list_entities` | optional `limit` | entities ranked by salience, with type and mention count | 43-54 ms | Useful as a name lookup |
| `explore_entity` | `entity_name` | neighbours by hop, typed relationships with source quotes | 6 ms (depth 1) to 161 ms (depth 2) | Useful; types are wrong |

Name matching in `explore_entity` is genuinely fuzzy and the miss path is well written:
`Nonexistent Entity XYZ` returns "no exact, case-insensitive, stemmed, or substring match.
Use `list_entities` to see what the graph knows" — an agent can recover from that in one call.

Depth is the parameter to watch. `explore_entity("Seagirt", max_depth: 2)` returned 299
connected entities and 842 relationships on a 341-entity graph, which is most of the graph
rendered as a wall of text. Depth 1 is the usable default the schema already sets.

The entity types this surface reports are wrong often enough to mislead. See [F5](#f5).

### 4. Statistical surfacing

| Tool | Needs | Returns | Latency | Verdict |
|---|---|---|---|---|
| `list_anomalies` | optional `limit`, `min_sigma` | memories ranked by z-score with per-component explanations | 5-11 ms | Genuinely good |

This is the strongest non-obvious tool in the server. It has no query — it scores the corpus
against its own rolling baseline — and it independently surfaced the same buried warning the
needle query was built for, at the top of the list, with a reason a model can quote:

```
🚩 1. [8.5σ] 8/8/2026, 7:04:44 AM
     "Routine port-state inspection of the Dali at Seagirt noted an intermittent
      low-voltage alarm on the main switchboard..."
     why: pmi_gated_ratio 8.5σ above baseline (0.022 vs 0.000); untyped_ratio 1.9σ
      above baseline (0.600 vs 0.295)
     entities: Dali, Seagirt, crew, intermittent low-voltage, low-voltage alarm
     memory: 1309fabf-507a-4098-8f79-c01fd35dbe72
```

`min_sigma` does not filter the list, it only changes how many entries are flagged: with
`min_sigma: 3.0` and `limit: 5` the header reads "5 entries ranked by |z| │ 3 flagged at
≥3.0σ" and all five are still printed. That is defensible (the ranking is the product) but
the parameter name suggests a filter.

One artefact worth knowing: todo-creation memories compete with real content. The
second-ranked anomaly was `[SHO-1] Todo created: ...`, flagged at 3.9σ because todo
bookkeeping introduces novel entities. On a small corpus the system's own writes crowd the
feed.

### 5. Distilled facts

| Tool | Needs | Returns | Latency | Verdict |
|---|---|---|---|---|
| `search_facts` | none; optional `query`, `entity`, `limit` | empty on both stores | 3-7 ms | Dead weight today |
| `fact_narratives` | optional `limit`, `entity_filter` | empty on both stores | 4 ms | Dead weight today |
| `purge_facts` | `pattern`; optional `dry_run` | "0 of 0 facts match" | 3 ms | Correct, nothing to purge |

All three work mechanically and their empty-state copy is honest and actionable. They
return nothing because there are no facts to return, on either store, and that is not a
young-corpus artefact. See [F6](#f6).

### 6. Tasks

The largest group by tool count (16 of 51) and the one with the most rough edges.

| Tool | Needs | Returns | Latency | Verdict |
|---|---|---|---|---|
| `add_todo` | `content` | short key (`SHO-4`, or `AUD-1` under a project) plus a rendered row | 0.4-2.0 s | Works; description overpromises |
| `list_todos` | none; 8 optional filters | Linear-style list grouped by status, nested subtasks | 3-112 ms | Works; `query` is dead, see [F19](#f19) |
| `update_todo` | `todo_id` | updated row | 4-521 ms | Works; the real subtask route |
| `complete_todo` | `todo_id` | completion row with elapsed time | 5 ms | Works |
| `delete_todo` | `todo_id` | confirmation | 4 ms | Works |
| `reorder_todo` | `todo_id`, `direction` | "Moved SHO-4 up" | 3-5 ms | No input validation |
| `todo_stats` | none | counts by status, overdue, due today, projects | 4-7 ms | Works |
| `list_subtasks` | `parent_id` | header and count, no rows | 4 ms | Broken renderer, see [F8](#f8) |
| `add_todo_comment` | `todo_id`, `content` | the comment as rendered | 261-582 ms | Works |
| `list_todo_comments` | `todo_id` | comments with author and type, no ids | 3-4 ms | Works; breaks the chain |
| `update_todo_comment` | `todo_id`, `comment_id`, `content` | updated comment | 3 ms | Unreachable, see [F7](#f7) |
| `delete_todo_comment` | `todo_id`, `comment_id` | confirmation | 3 ms | Unreachable, see [F7](#f7) |
| `add_project` | `name` | project name and 8-char id | 5 ms | Works |
| `list_projects` | none | projects with active/total counts | 4-5 ms | Works; ignores archived |
| `archive_project` | `project` | "Status: Archived" | 3 ms | Status changes, nothing hides |
| `delete_project` | `project` | "Deleted project 'X' and 1 todos" | 5 ms | Works |

Short keys are the currency here. `add_todo` returns `SHO-4`; every other todo tool accepts
that key directly, including the comment tools. An agent never needs a UUID for todos, which
is a good design — except for comments, where a UUID is required and never provided.

`list_todos` renders subtask nesting correctly (`SHO-9` indented under `SHO-8`), so the
hierarchy exists and is visible; only `list_subtasks` fails to print it.

### 7. Reminders

| Tool | Needs | Returns | Latency | Verdict |
|---|---|---|---|---|
| `set_reminder` | `content`, `trigger_type` | reminder with its UUID and resolved trigger | 3-455 ms | Works |
| `list_reminders` | optional `status` | reminders with UUIDs, type, priority, due time | 3-5 ms | Works |
| `dismiss_reminder` | `reminder_id` | confirmation | 4 ms | Works |

The cleanest group in the server. All three trigger types work — `time` with an ISO
timestamp, `duration` with `after_seconds`, `context` with keywords and a threshold — the
invalid case is rejected clearly ("Invalid trigger_type: telepathy"), `list_reminders` emits
the UUID that `dismiss_reminder` needs, and the `status` filter works. There is no
`delete_reminder`, though `/api/reminders/{id}/delete` exists on the backend.

### 8. Feedback

| Tool | Needs | Returns | Latency | Verdict |
|---|---|---|---|---|
| `reinforce_memories` | `memory_ids[]`, `outcome` | processed count, boosts, decays, associations strengthened | 4-7 ms | Works; report it honestly |

`helpful` produced "Memories processed: 1 (boosted) │ Importance boosts: 1 │ decays: 0";
`misleading` produced the mirror. Bad ids fail loudly ("none of the provided ids resolved to
memories"). Note that "Associations strengthened: 0" in both cases — the memory-to-memory
association layer did not fire for single-id calls, so the Hebbian claim this tool implies
is only partly delivered on this evidence.

### 9. Session and token accounting

| Tool | Needs | Returns | Latency | Verdict |
|---|---|---|---|---|
| `token_status` | none | pipeline tokens against a 100k budget | 4-7 ms | Operator-only |
| `reset_token_session` | none | previous and current counter | 3 ms | Operator-only |
| `session_digest` | none | timestamps, tokens, memory counts, tool-use histogram | 5 ms | Misleading, see [F18](#f18) |
| `session_history` | optional `limit`, `group_by_project` | "No session history found" | 3-6 ms | Not exercisable |

`token_status` is explicit that it counts memory tool I/O and not the model's context window,
which is the right disclaimer, but it is a diagnostic for whoever operates the server, not a
tool a model should be choosing between. `reset_token_session` is the same. Both belong
behind an operator flag rather than in a model's tool list.

### 10. Index, backups, maintenance

Operator territory. All of these work; none of them should be in a model's default tool list.

| Tool | Needs | Returns | Latency | Verdict |
|---|---|---|---|---|
| `memory_stats` | none | totals, graph size, indexed vectors, average importance | 5-28 ms | Works; drops a section |
| `verify_index` | none | storage vs indexed counts, orphan count, health verdict | 3-6 ms | Works |
| `repair_index` | none | repaired and failed counts | 5 ms | Works |
| `consolidation_report` | optional `since`, `until` | strengthen/decay events, maintenance cycles | 19-20 ms | Works; bad default window |
| `backup_create` | none | backup id, type, size, checksum | 372-485 ms | Works; miscounts memories |
| `backup_list` | none | id, type, size, timestamp per backup | 3-43 ms | Works |
| `backup_verify` | `backup_id` (number) | valid or corrupt | 14 ms | Works; type-brittle |
| `backup_purge` | optional `keep_count` | purged and kept counts | 3-33 ms | Works |
| `backup_restore` | `backup_id` (number) | restored store list | 278 ms | Restores less than it claims |

`memory_stats` declares a "By Type" histogram in its formatter, but the section never
renders because it reads `memory_types` from an endpoint that does not return that field.
See [F9](#f9). `consolidation_report` defaults to a one-hour window and therefore reports "No
consolidation activity in this period" on a corpus with 15 events in the last week; pass
`since` explicitly. `backup_restore` restored only `["graph"]` while its description says it
"replaces all current data for the user"; see [F10](#f10).

---

## Dependency chains

An agent cannot call these tools in arbitrary order. The chains that matter:

```
recall / list_memories / context_summary / list_anomalies
        └─ memory UUID ──▶ read_memory
                        ──▶ trace_lineage
                        ──▶ add_causal_link (needs two)
                        ──▶ reinforce_memories

list_causal_edges ── edge_id ──▶ validate_causal_link
        (list_causal_edges and trace_lineage are the ONLY sources of edge_id)

list_entities ── entity name ──▶ explore_entity
        (explore_entity fuzzy-matches, so a name from recall output often works too)

add_todo / list_todos ── short key (SHO-n) ──▶ update_todo, complete_todo, delete_todo,
                                               reorder_todo, list_subtasks,
                                               add_todo_comment, list_todo_comments

backup_create / backup_list ── numeric id ──▶ backup_verify, backup_restore

set_reminder / list_reminders ── UUID ──▶ dismiss_reminder

add_project ── project name ──▶ add_todo(project:), archive_project, delete_project
```

Two chains are broken:

- **`comment_id` has no source.** `update_todo_comment` and `delete_todo_comment` both
  require it. `list_todo_comments` prints author, type, timestamp and body but not the id.
  No other tool emits it. Both tools work correctly when handed an id obtained out of band
  from `GET /api/todos/{id}/comments`, so the tools are fine and the chain is not. See [F7](#f7).
- **`add_todo` cannot create a subtask** despite its description saying it can. The
  `parent_id` route is `update_todo`. See [F11](#f11).

Note the asymmetry in id forms: memories use UUIDs (8-character prefixes accepted almost
everywhere), todos use short keys, backups use small integers, comments and reminders use
UUIDs. An agent has to keep three id conventions straight.

---

## Prompts

Six prompts, all working, all fast, all returning a single `user`-role message. They are
thin convenience wrappers over the same endpoints the tools use.

| Prompt | Arguments | Latency | Notes |
|---|---|---|---|
| `quick_recall` | `query` (required) | 375 ms | Prose list of recalled memories; no ids |
| `session_summary` | none | 6 ms | Recent learnings and decisions |
| `what_i_know` | `topic` (required) | 370 ms | Same as quick_recall, grouped by memory type |
| `pending_work` | none | 3 ms | Todos with priority markers |
| `recent_memories` | `count` | 6 ms | Newest memories by type |
| `memory_health` | none | 7 ms | Totals and index status; two fields always zero |

The prompts drop the memory ids that the equivalent tools return. That makes them fine for a
human reading a slash command and poor as a starting point for an agent that wants to act on
what it found — `quick_recall` gives you text you cannot then trace or read in full.
`memory_health` prints "Last 24h: 0 / Last 7 days: 0" on a corpus seeded yesterday; see [F9](#f9).

---

## Resources

Four static resources plus up to 30 memory URIs.

| URI | MIME | Works | Notes |
|---|---|---|---|
| `shodh://commands` | text/markdown | yes | Stale; see [F12](#f12) |
| `shodh://summary` | text/plain | yes | Same content as the `session_summary` prompt |
| `shodh://todos` | text/plain | yes | Same content as the `pending_work` prompt |
| `shodh://stats` | application/json | yes | The only raw-JSON surface an agent can read |
| `memory://{uuid}` | text/plain | yes | Content, type, created, id |
| `shodh://search/{query}` | — | **no** | Declared as a template, no handler; see [F1](#f1) |

`shodh://stats` is worth knowing about: it is the only place an agent gets unformatted
numbers, including tier counts that no tool exposes. It also contradicts the tools; see [F13](#f13).

Unknown URIs fail cleanly with `MCP error -32603: Failed to read resource: Unknown resource: nope`.

---

## Route reconciliation

Checked against `src/handlers/router.rs` at the same commit.

**No MCP tool hits a route that no longer exists.** Every endpoint referenced by
`mcp-server/index.ts` is registered in the router, and every call in this audit reached a
real handler. Several tools deliberately use the MCP-specific aliases the router carries for
them (`/api/backups`, `/api/backups/purge`, `/api/remind`, `/api/reminders/context`,
`/api/todos/{id}/comments/{cid}/update`), and those aliases are all present.

The gap runs the other way: large parts of the backend are unreachable from an agent. Route
families with no MCP tool at all:

| Area | Routes with no MCP tool | Why it matters |
|---|---|---|
| Bulk forget | `/api/forget/age`, `/importance`, `/pattern`, `/tags`, `/date`, `/api/memories/bulk`, `/api/memories/clear` | An agent can only delete memories one id at a time |
| Memory editing | `PUT /api/memory/{id}`, `/api/upsert` | No way to correct a stored memory; only delete and re-add |
| Batch write | `/api/remember/batch` | Bulk import must be 1 call per memory (200 ms-2.5 s each) |
| Retrieval variants | `/api/recall/date`, `/recall/paginated`, `/recall/tracked`, `/api/relevant`, `/api/search/advanced`, `/api/search/multimodal`, `/api/search/robotics` | Date-range recall and pagination are absent from the tool surface |
| Graph administration | `/api/graph/{user}/rebuild`, `/canonicalize`, `/clear`, `/tier-census`, `/curvature`, `/universe`, `/export` | Entity mis-typing (see [F5](#f5)) cannot be repaired from the agent side |
| Graph authoring | `/api/graph/entity/add`, `/relationship/add`, `/relationship/invalidate`, `/entity/find`, `/episode/get` | An agent can read the entity graph but never write or correct it |
| Consolidation trigger | `/api/consolidate`, `/api/consolidation/events` | The facts pipeline cannot be started from MCP; see [F6](#f6) |
| Codebase file memory | `/api/projects/{id}/files`, `/scan`, `/index`, `/files/search`, `/api/files/stats` | An entire subsystem is invisible to agents |
| MIF interchange | `/api/export/mif`, `/api/import/mif`, `/api/mif/adapters` | No import/export path |
| A/B testing | all 13 `/api/ab/*` routes | Entire subsystem, operator-facing |
| Sessions | `/api/sessions`, `/sessions/stats`, `/sessions/end`, `/sessions/{id}` | Only digest and history are wired up |
| Storage | `/api/memory/compress`, `/decompress`, `/api/storage/stats`, `/cleanup`, `/migrate`, `/api/index/rebuild` | Operator maintenance |
| Reminders | `/api/reminders/due`, `/reminders/check`, `/reminders/{id}/delete` | Reminders can be set and dismissed but not deleted, and due ones cannot be polled directly |
| Misc | `/api/todos/due`, `/api/facts/stats`, `/api/lineage/branches`, `/api/lineage/branch`, `/api/users`, `/api/stats` | Branching lineage is entirely absent from the tool surface |

The bulk-forget and memory-edit gaps are the ones most likely to bite in practice: an agent
that stores a wrong memory can delete it, but an agent asked to clean up fifty of them has to
make fifty calls, and an agent asked to correct one cannot.

---

## Findings

Ordered by how much they cost an agent, with the fault attributed to the tool or the endpoint.

### F1
**`shodh://search/{query}` is advertised as a resource template and has no handler.**
`resources/templates/list` returns it alongside three working templates. Reading
`shodh://search/bridge%20collapse` fails with `MCP error -32603: Failed to read resource:
Unknown resource: search/bridge%20collapse`. The read handler switches on `commands`,
`summary`, `todos`, `stats` and the `memory://` scheme; there is no `search` branch.
*Fault: MCP server. Fix: implement it or stop declaring it.*

### F2
**`recall`'s `tags` filter returns nothing for tags that demonstrably exist.**
`recall({query: "port", limit: 3, tags: ["Seagirt"]})` returns "No memories or todos found",
while `recall_by_tags({tags: ["Seagirt"]})` returns three memories whose printed tag lists
contain `Seagirt`, and the same query without the tag filter returns three results. Verified
against the endpoint directly: `POST /api/recall` with `{"tags":["Seagirt"]}` returns
`{"memories":[],"count":0}` and without it returns 3.
*Fault: the `/api/recall` endpoint — the MCP layer passes the array through unchanged. The
tag filter there does not match the same tag vocabulary that `/api/recall/tags` matches
against.* An agent that reads the schema ("Filter by tags (any match)") will conclude the
corpus has no such memories.

### F3
**`trace_lineage` reports a "Depth reached" that is always the edge count, not a depth.**
Tracing forward from the pier-strike memory with `max_depth: 5` prints
`Depth reached: 31 │ Edges: 31`. Verified against the endpoint: `max_depth` is honoured
(1 gives 4 edges, 3 gives 26, 5 gives 31, 20 gives 31), but the response field named `depth`
carries the edge count, and the MCP tool renders it verbatim under a "Depth reached" label.
The two numbers are identical in every trace.
*Fault: the `/api/lineage/trace` endpoint's field naming; the MCP tool faithfully renders a
mislabelled field.* A model reading "depth 31" from a 5-hop request will mistrust its own
parameters.

### F4
**Inferred causal edges are unreliable enough to mislead, and the arrow labels contradict the
relation names.** Two separate problems on the same output:

The edge `94eb3d1e ──TriggeredBy──▶ 327ddfb2` renders as *"The drifting vessel struck a
support pier..." triggered "The bridge lacked pier protection dolphins that current design
standards require..."*. A missing design feature is a precondition, not an effect; the edge
is backwards in substance. And 74 of the 113 edges are `InformedBy`, which the renderer
prints as "A informed B" while the relation name reads "A is informed by B" — the arrow and
the name point in opposite directions.

Separately, the seeded causal chain is incomplete: the pier-strike memory has four outgoing
edges and zero incoming ones, so `trace_lineage(direction:"backward")` on it returns
"No causal edges found backward". The obvious agent question — why did the bridge collapse,
trace it back — fails on the corpus built to demonstrate it.
*Fault: the edge inference in the backend, plus a naming choice in the MCP renderer. Average
inferred confidence is 25 percent; only 1 of 113 edges is confirmed.*

### F5
**`list_entities` and `explore_entity` report entity types that are wrong often enough to be
worse than no type at all.** Verbatim from a 341-entity graph:

```
  1. Seagirt  (railway station │ mentions: 9 │ salience: 1.00)
  2. berth  (railway station │ mentions: 9 │ salience: 1.00)
  3. Maersk  (airline │ mentions: 3 │ salience: 0.95)
  4. Dali  (airline │ mentions: 7 │ salience: 0.94)
  ...
 13. Breakbulk crew  (armed group │ mentions: 1 │ salience: 0.68)
```

Seagirt is a container terminal, `berth` is a common noun, Maersk is a shipping line, the
Dali is a ship and a breakbulk crew is a work gang. `Port of Baltimore` types as
`power station`. The mis-typing looks like gazetteer or knowledge-base linking matching on
name alone without a domain prior.

`explore_entity` compounds it by attaching relationships to the wrong subject:
`harbor ──Struck──▶ Francis Scott Key Bridge` and
`Curtis Bay coal pier ──Triggers──▶ Francis Scott Key Bridge`, both sourced from the sentence
where the *drifting vessel* struck the bridge.
*Fault: entity typing and relation extraction in the backend, not the MCP layer.* An agent
asked "what kind of thing is Seagirt" gets a confident wrong answer, and no MCP tool can
correct it because the graph-authoring routes are unreachable ([Route reconciliation](#route-reconciliation)).

### F6
**All three facts tools return empty, and it is not a young-corpus artefact.**
`search_facts`, `fact_narratives` and `purge_facts` return nothing on both the 74-memory demo
store and the 91-memory audit store. The empty-state copy blames corpus youth: "Semantic
facts distill out of episodic memories during consolidation — a young or recently imported
corpus may have none yet."

That explanation was tested. `POST /api/consolidate` on the audit store ran consolidation
explicitly; the consolidation report afterwards showed replayed memories, decayed memories
and maintenance cycles, but `extracted_facts: []`, and `/api/facts/stats` still reported
`total_facts: 0` after 60 seconds of polling.
*Fault: fact extraction in the backend produces nothing on a realistic corpus. The MCP tools
are correct and their messages are honest, but they are dead weight — three of 51 tools, six
percent of the agent's tool budget, that cannot return anything today.* Compounding it, the
consolidation these tools point at cannot be triggered from MCP at all.

### F7
**`update_todo_comment` and `delete_todo_comment` are unreachable through the MCP surface.**
Both require `comment_id`. The only tool that lists comments, `list_todo_comments`, prints:

```
📝 Comments on SHO-8 (3 total)

1. 🔄 system (2026-08-09 09:33)
   Created
2. 💬 demo (2026-08-09 09:35)
   audit comment with a valid type
```

No ids. `add_todo_comment` returns the rendered comment without an id either. The underlying
`GET /api/todos/{id}/comments` response does carry them
(`["7971c366-...","430607e1-...","de48de17-..."]`), and both tools work correctly when handed
one of those out of band — update and delete both succeeded and the subsequent list showed
2 comments instead of 3.
*Fault: MCP server. `list_todo_comments` renders `result.formatted` and discards
`result.comments`, where the ids live.* Two tools are permanently uncallable.

### F8
**`list_subtasks` returns a header and a count with no rows.** On a parent with one subtask:

```
🐘━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
┃  SUBTASKS OF SHO-8  ┃
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

SHO · My Todos                                                       1 items
```

The endpoint response is not empty: `GET /api/todos/SHO-8/subtasks` returns
`count: 1` and a `todos` array containing the child with its correct `parent_id`, alongside a
`formatted` string that contains only the header and the "1 items" line. `list_todos` renders
the same subtask correctly, nested under its parent, so the hierarchy is intact.
*Fault: shared between both layers. The endpoint's `formatted` renderer for the subtasks
route emits no rows; the MCP tool prints `result.formatted` only and throws away the
`todos` array that would have let it render them itself.*

### F9
**Three surfaces read response fields the stats endpoint does not return, and silently print
zeros or nothing.** `GET /api/users/demo/stats` returns exactly:

```json
{"total_memories":74,"working_memory_count":0,"session_memory_count":0,
 "long_term_memory_count":74,"vector_index_count":74,"compressed_count":0,
 "promotions_to_session":0,"promotions_to_longterm":0,"total_retrievals":183,
 "average_importance":0.7756872,"graph_nodes":341,"graph_edges":1542}
```

- `memory_stats` reads `memory_types` to build a "By Type" histogram. The field does not
  exist, so the whole section is skipped without comment — the tool looks like it has no
  such feature.
- The `memory_health` prompt reads `memories_last_24h` and `memories_last_7d`. Neither
  exists, so it prints "Last 24h: 0 / Last 7 days: 0" unconditionally. On the demo corpus,
  seeded the previous day, "Last 7 days: 0" is simply false.
- The same prompt reads `memories_by_type` for its own "By Type" section, which likewise
  never renders.

*Fault: MCP server reading a stale response shape — the endpoint is internally consistent,
the client is not.* The 24h/7d numbers are the dangerous ones because they are printed as
facts rather than omitted.

### F10
**`backup_restore` restores less than its description promises.** The description says it
"replaces all current data for the user with the backup contents". Restoring backup #3 on the
audit store returned:

```
✓ Backup #3 restored successfully
Restored stores: graph

⚠️ Restore complete for user 'demo'. Restored: ["graph"]. Server restart recommended
```

Only the graph store was restored. `memory_stats` went from 94 to 91 memories across the
restore, so something changed, but the memory store itself was not replaced from the backup.
*Fault: description over-promises relative to endpoint behaviour.* Given how destructive the
described behaviour would be, the gap between promise and reality is the risk here: an
operator trusting the description would believe a restore had recovered memories it did not.

Related, in the same group:
- `backup_create` reports "Memories: 897" for a store holding 88 memories, and "Memories: 934"
  for one holding 91. The number counts stored keys, not memories; it is labelled "Memories".
- `backup_restore` with a purged id returns HTTP 500 `INTERNAL_ERROR: NotFound: Backup not
  found` — a not-found condition surfaced as a server error.
- `backup_verify`/`backup_restore` declare `backup_id` as `number`. Passing the string `"1"`
  produces a raw serde error: `API error 422: Failed to deserialize the JSON body into the
  target type: backup_id: invalid type: string "1", expected u32`. There is no client-side
  coercion or validation, and models routinely emit ids as strings.

### F11
**`add_todo`'s description promises subtask creation that its schema does not support.**
Description: "Supports GTD workflow with projects, contexts, priorities, due dates, and
subtasks (via parent_id)". `parent_id` is not in `add_todo`'s `inputSchema.properties`.
`list_subtasks`'s description repeats the claim: "Use add_todo with parent_id to create
subtasks." Calling `add_todo({content: "...", parent_id: "SHO-8"})` creates an unparented
top-level todo (`SHO-10`) with no error. The working route is `update_todo({todo_id, parent_id})`,
which is documented only on `update_todo` itself.
*Fault: MCP server — two descriptions describe a parameter that was never added to the
schema.* Note `remember` does expose `parent_id` for memory hierarchies, which makes the
inconsistency easy to trip over.

### F12
**`shodh://commands` is a hand-maintained tool list that has drifted from the tool list.**
It names 35 tools. Two of them do not exist: `recall_by_date` and `streaming_status`. It
omits 18 that do: `read_memory`, all five `backup_*`, `consolidation_report`, `session_digest`,
`session_history`, `purge_facts`, `reorder_todo`, `archive_project`, `delete_project`,
`list_subtasks`, and all four todo-comment tools.
*Fault: MCP server.* An agent that reads this resource to discover capabilities will look for
two tools that will fail and miss a third of the surface. It should be generated from the
tool array rather than written by hand.

### F13
**Tier reporting contradicts itself across surfaces.** `shodh://stats` reports
`working_memory_count: 0, long_term_memory_count: 74`. `list_memories`, `recall` and
`read_memory` all label every one of those same 74 memories `Working`:

```
 1. 📋 Because the wreckage blocked the shipping channel...
    ┗━ Decision │ Working │ 01c59ffa-d33f-4935-88b2-86ac4120e6be
```

Two agent-visible surfaces disagree about the tier of every memory in the store.
*Fault: not attributable from the MCP side — both surfaces read from the backend; one of the
two tier reads is wrong.* Worth resolving before any claim about three-tier promotion is made
on the basis of these numbers.

### F14
**A generic 404 hint is appended to errors that have nothing to do with missing endpoints.**
Deleting an already-deleted memory:

```
Error: API error 404: {"code":"MEMORY_NOT_FOUND","message":"Memory not found: 5cc0b260-..."}

Endpoint not found. The server may be running an older version.
```

The same false hint appears on `list_subtasks` with an unknown todo
(`404 TODO_NOT_FOUND` plus "Endpoint not found. The server may be running an older version.").
*Fault: MCP server — the error formatter keys on HTTP 404 rather than on the error code the
backend already provides.* It tells an agent to suspect a version mismatch when the real
answer is that the id does not exist, which is a recoverable condition it might otherwise
retry correctly.

### F15
**`reorder_todo` accepts any `direction` and silently treats it as "down".**
`reorder_todo({todo_id: "SHO-4", direction: "sideways"})` returned "Moved SHO-4 down". The
schema documents `direction` only as "Direction to move the todo" with no enum, and there is
no validation on either side. Compare `recall`'s `mode`, `add_causal_link`'s `relation`,
`validate_causal_link`'s `verdict` and `set_reminder`'s `trigger_type`, all of which reject
invalid values with the list of accepted ones.
*Fault: MCP server.*

### F16
**The lineage and entity graphs use different relation vocabularies, and the tools do not say
so.** `explore_entity` displays entity-level relations named `Causes`, `Triggers`, `Struck`,
`DependsOn`. `add_causal_link` accepts only `Caused, ResolvedBy, InformedBy, SupersededBy,
TriggeredBy, BranchedFrom, RelatedTo`. Passing `Causes` — the spelling the other graph tool
just displayed — is rejected. The rejection message is good (it lists the accepted values),
so this costs one wasted call rather than a failure, but it is an avoidable one.
*Fault: naming inconsistency across two subsystems, surfaced unmediated by the tools.*

### F17
**`consolidation_report` defaults to a one-hour window and reports nothing on an active
corpus.** With no arguments it reported "Period: 1:53 PM to 2:53 PM │ Events: 0 │ Memories: 0"
and "No consolidation activity in this period. Store and access memories to trigger
learning." With `since: 2026-08-01` it reported 15 events and 5 maintenance cycles over the
same corpus. The `since` parameter description says "Defaults to 24 hours ago"; the MCP
handler passes `since` through unset and `src/handlers/consolidation.rs:713` falls back to
`now - Duration::hours(1)`.
*Fault: MCP server — its description documents a 24-hour default the endpoint does not
implement.* The advice line ("Store and access memories to trigger learning") is actively
wrong when the learning already happened, just outside the window.

### F18
**`session_digest` reports numbers that are not this session's.** On the audit store, in a
process that had made two tool calls, it reported:

```
📅 8/9/2026 | ⏱ 3:03:35 PM → 3:03:35 PM (0m)
🐘 Memory: 83 created, 10 surfaced, 0 used
📋 Todos: 12 created, 2 completed
🔧 Tools Used:
   token_status: 1
   session_digest: 1
```

The tool-use histogram is correctly scoped to the MCP process, but the memory and todo counts
aggregate work done by other clients against the same store, under a session whose start and
end timestamps are identical. A model calling this to answer "what did I do this session"
gets another client's totals attributed to itself.
*Fault: session accounting in the backend; the MCP tool renders what it is given.*

### F19
**`list_todos`'s `query` parameter returns nothing, including for exact word matches.**
The description promises "semantic search via query parameter... uses vector similarity to
find matching todos". Against a store holding a todo titled "Audit-2 parent task":

```
### list_todos {"query":"Audit-2 parent"}  [99ms]
No todos found.
```

Not a similarity-threshold artefact — the query words are a literal prefix of the todo's
content. Verified against the endpoint: `POST /api/todos/list` with
`{"user_id":"demo","query":"Audit-2 parent"}` returns `count: 0`, and the identical body
without `query` returns `count: 8`. The other seven filters on the same tool
(`status`, `project`, `limit`, `offset`) work.
*Fault: the `/api/todos/list` endpoint — the MCP layer passes `query` through unchanged, and
the endpoint's semantic path matches nothing.* Passing `query` is worse than useless: it
turns a working list call into an empty one, and an agent will read "No todos found" as
evidence that the user has no such task.

### Redundant pairs

- `session_summary` (prompt) and `shodh://summary` (resource) return the same text from the
  same endpoint. So do `pending_work` and `shodh://todos`.
- `quick_recall` and `what_i_know` are the same `/api/recall` call; the only difference is
  that `what_i_know` groups by memory type. Both drop the ids that make results actionable.
- `memory_stats` (tool), `shodh://stats` (resource) and `memory_health` (prompt) are three
  renderings of one endpoint, and they disagree (see [F13](#f13)) or print false zeros (see [F9](#f9)).
- `verify_index` is called by both the `verify_index` tool and the `memory_health` prompt.

### Operator-only, and probably wrong to expose to a model

Eleven of the 51 tools are maintenance controls a model has no basis for choosing to invoke:
`repair_index`, `backup_create`, `backup_list`, `backup_verify`, `backup_purge`,
`backup_restore`, `token_status`, `reset_token_session`, `purge_facts`, `consolidation_report`,
and arguably `verify_index`. Three of them are destructive (`backup_restore`, `backup_purge`,
`purge_facts`). They consume roughly a fifth of the tool-list budget and add decision noise to
every call. An operator flag that hides them from `tools/list` by default would make the
agent-facing surface considerably sharper.

---

## Method and scope

**Inventory** came from `tools/list`, `prompts/list`, `resources/list` and
`resources/templates/list` over real MCP stdio — `bun run mcp-server/index.ts` from a
worktree pinned at `4baef94c`, driven by `@modelcontextprotocol/sdk` with an explicit
environment allowlist (Bun auto-loads `.env` from cwd, and the pinned worktree has none, so
nothing leaked in from the developer shell).

**Read-only tools ran against the owner's demo backend** on `127.0.0.1:3030` with
`SHODH_USER_ID=demo`: `recall`, `recall_by_tags`, `context_summary`, `list_memories`,
`read_memory`, `memory_stats`, `verify_index`, `consolidation_report`, `backup_list`,
`token_status`, `session_digest`, `session_history`, `fact_narratives`, `search_facts`,
`list_entities`, `explore_entity`, `list_causal_edges`, `trace_lineage`, `list_anomalies`,
`list_todos`, `todo_stats`, `list_projects`, `list_reminders`, `list_subtasks`,
`list_todo_comments`, plus all six prompts and every resource.

`proactive_context` ran there only with `auto_ingest: false` explicitly set, because its
default is `true` and it would otherwise have written to the owner's corpus.

Two side effects on the demo store are unavoidable and were accepted: `recall` persists
retrieval scores, and `proactive_context` records surfacing state. The read passes were each
executed twice (the harness was re-run to page through its own output), so those score
updates landed twice. No memory, todo, project, reminder, edge or backup was created,
modified or deleted there — verified after the fact: 74 memories, 341 graph nodes, 3 todos,
unchanged from the start.

**Every mutating tool ran only against a disposable store** on `127.0.0.1:3097`
(`SHODH_MEMORY_PATH=C:\smt\mcpaudit-store`, its own named pipe so it could not collide with
the live server's IPC endpoint), seeded from `seat/eval/seed-demo-corpus.mjs`:
`remember`, `forget`, `repair_index`, `backup_create`, `backup_verify`, `backup_purge`,
`backup_restore`, `reset_token_session`, `purge_facts`, `set_reminder`, `dismiss_reminder`,
`add_todo`, `update_todo`, `complete_todo`, `delete_todo`, `reorder_todo`, `add_project`,
`archive_project`, `delete_project`, `add_todo_comment`, `update_todo_comment`,
`delete_todo_comment`, `add_causal_link`, `validate_causal_link`, `reinforce_memories`, and
`proactive_context` with its default `auto_ingest: true`. The store and its backups were
deleted afterwards.

Where a finding needed the fault attributed to the tool or the endpoint, the endpoint was
called directly with `curl` and the raw JSON compared against what the tool rendered.

### Not exercised

- **`session_history`** returned "No session history found" on both stores. Sessions are
  recorded when Claude Code exits, so no amount of MCP calling can produce data for it. The
  empty result is unattributable — it is neither a confirmed bug nor a confirmed pass.
- **Robotics retrieval** (`recall` with `robot_id`, `mission_id`, `action_type`, `reward_min`,
  `reward_max`, `outcome_type`, `failures_only`, `terrain_type`, and modes `mission` and
  `action_outcome`) was exercised only far enough to confirm the filters are wired and the
  error paths are sane — `mode: "mission"` correctly demands a `mission_id`, and the filters
  correctly return nothing on a corpus with no robotics telemetry. A single `remember` call
  carrying the full robotics field set was accepted without error, but whether these filters
  retrieve correctly was not tested; that needs a robotics corpus.
- **Affect and episode fields** on `remember` (`emotional_valence`, `emotional_arousal`,
  `emotion`, `source_type`, `credibility`, `episode_id`, `sequence_number`,
  `preceding_memory_id`, `sensor_data`) were accepted without error. Whether they influence
  retrieval or consolidation was not measured.
- **`set_reminder` triggers never fired.** All three trigger types were created successfully
  and are listed correctly, but no reminder was waited out or context-matched, so the
  surfacing behaviour the tool description promises is unverified.
- **Streaming** (`SHODH_STREAM`, the WebSocket to `/api/stream`) connected and handshook
  successfully during inventory but was disabled for the measured passes to keep latency
  attributable. It is not a tool and no tool depends on it.
