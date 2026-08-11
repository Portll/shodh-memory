#!/usr/bin/env node
/**
 * Seed the demonstration corpus against a RUNNING backend.
 *
 *   SHODH_API_URL=http://127.0.0.1:3098 SHODH_API_KEY=... USER_ID=demo \
 *     node seat/eval/seed-demo-corpus.mjs
 *
 * The corpus is written to exercise every subsystem the workbench renders,
 * deliberately:
 *  - explicit causal language ("because", "led to", "triggered") for the
 *    causal extractors → typed lineage edges, not bare co-occurrence;
 *  - named people, organisations, places and systems → a visibly typed
 *    ontology once NER typing lands (person/org/location/technology);
 *  - place names in text → toponym linking (gazetteer), distinct from…
 *  - …real recorded coordinates on field events → the geo layer;
 *  - repeated entities across memories → canonicalization + Hebbian edges;
 *  - a deliberate factual correction pair → the facts contradiction path;
 *  - open todos → Tasks.
 *
 * Idempotence: re-running adds duplicates. Seed fresh stores only.
 *
 * Also importable: memory-guidance-ab.mjs seeds the SAME corpus into its own
 * per-run eval users via the exported MEMORIES/TODOS, so the eval measures
 * against exactly the corpus this script defines — one definition, no drift.
 * The CLI behaviour runs only when this file is the entry point.
 */
import { pathToFileURL } from "node:url";

/** [content, type, geo?] — geo only where the event has a real location. */
export const MEMORIES = [
  // Causal chain 1 — the incident
  ["Container ship Dali lost propulsion at 01:24 local time because an electrical breaker tripped during departure from the Port of Baltimore.", "observation", [39.264, -76.6015, 0]],
  ["The loss of propulsion led to the Dali drifting off the channel heading despite the crew dropping anchor.", "observation", [39.24, -76.575, 0]],
  ["The drifting vessel struck a support pier of the Francis Scott Key Bridge, which triggered the collapse of the main truss spans into the Patapsco River.", "observation", [39.217, -76.5285, 0]],
  ["Because the wreckage blocked the shipping channel, the Port of Baltimore suspended all vessel traffic.", "decision", [39.2604, -76.6122, 0]],
  // Causal chain 2 — consequences
  ["The port suspension halted roll-on/roll-off automobile shipments, so Maersk rerouted its services to the Port of New York and New Jersey.", "decision", [40.684, -74.145, 0]],
  ["Overflow automobile volume was diverted south to the Port of Virginia at Norfolk as a result of the closure.", "decision", [36.9312, -76.321, 0]],
  ["Coal exports from the CSX Curtis Bay terminal stopped for six weeks because bulk carriers could not transit the blocked channel.", "observation", [39.2205, -76.5866, 0]],
  // Investigation — people and orgs for the ontology
  ["NTSB chair Jennifer Homendy stated the investigation would examine the Dali's electrical system, after inspectors recovered the voyage data recorder.", "observation", null],
  ["Synergy Marine Group, the ship manager, confirmed the crew reported electrical failures during port inspections in the days before departure.", "observation", null],
  ["Captain Maynard of the pilots association credited the pilot's mayday call with stopping bridge traffic, which prevented further casualties.", "learning", null],
  // Technical layer
  ["The bridge lacked pier protection dolphins that current design standards require, a factor engineers said contributed to the total collapse.", "learning", null],
  ["Salvage crews used the floating crane Chesapeake 1000 to cut the collapsed truss sections for channel clearance.", "task", [39.217, -76.5285, 0]],
  // Deliberate correction pair — exercises the facts contradiction path
  ["Initial reports said four crew members were injured in the collapse.", "observation", null],
  ["Corrected report: no crew members aboard the Dali were injured; the casualties were road workers on the bridge deck.", "observation", null],
  // Unrelated island — proves the graph renders disconnection honestly
  ["The Vamana index rebuild cut recall latency from 340ms to 92ms on the evaluation corpus.", "learning", null],

  // ---------------------------------------------------------------------------
  // THE NEEDLE — a pre-incident warning thread buried in the haystack below.
  // Three quiet memories, weeks apart, no alarm language, no cross-references.
  // The ask "was there any warning sign before the Dali incident?" must fish
  // exactly these out of the routine noise.
  // ---------------------------------------------------------------------------
  ["Routine port-state inspection of the Dali at Seagirt noted an intermittent low-voltage alarm on the main switchboard; the crew reset it and the inspector logged it as resolved.", "observation", [39.2646, -76.5583, 0]],
  ["Electrician's shift note: reefer bank on the Dali's forward feeder showed voltage sag twice during cargo operations, within tolerance but recurring.", "observation", null],
  ["Synergy Marine deferred the Dali's switchboard breaker overhaul to the next scheduled dry dock to avoid a berth overstay.", "decision", null],

  // Quantitative anomaly buried in routine manifests — "any anomalies in the
  // container manifests?" should surface this single mismatch.
  ["Gate scale check: container MSKU-4471820 declared 4,200 kg on the manifest but weighed 28,650 kg at the Seagirt in-gate; flagged for VGM re-verification.", "observation", [39.2646, -76.5583, 0]],

  // Geo outlier — a position that does not belong to the port's operating
  // footprint; the map should make it visually obvious.
  ["Drayage truck T-118 carrying an export reefer pinged 40 km off its assigned corridor near Annapolis during the evening run.", "observation", [38.9784, -76.4922, 0]],

  // ---------------------------------------------------------------------------
  // THE HAYSTACK — routine port operations. Mundane on purpose: berth moves,
  // weather, crane maintenance, customs holds, shift notes. Entities repeat
  // across memories (berths, cranes, ships, terminals) so the graph gets real
  // Hebbian structure, but none of these use causal connectives and none
  // reference the incident.
  // ---------------------------------------------------------------------------
  ["MSC Brianna completed cargo operations at Seagirt berth 3 and departed on the evening tide.", "observation", [39.2646, -76.5583, 0]],
  ["Crane STS-07 at Seagirt completed its 4,000-hour preventive maintenance; hoist brake pads replaced.", "observation", [39.2646, -76.5583, 0]],
  ["Morning shift moved 1,847 containers at Seagirt, slightly above the 30-day average.", "observation", null],
  ["Evergreen Ever Focus assigned to Seagirt berth 2 for Thursday arrival, draft 12.8 metres.", "observation", [39.2646, -76.5583, 0]],
  ["Fog delayed pilot boardings in the Craighill Channel for two hours before conditions lifted.", "observation", [39.13, -76.42, 0]],
  ["Customs placed a documentation hold on 12 containers from the CMA CGM Argentina pending broker corrections.", "observation", null],
  ["Dundalk Marine Terminal handled 3,200 imported vehicles this week, in line with forecast.", "observation", [39.2504, -76.5312, 0]],
  ["Longshore gang 14 set a terminal record with 42 crane moves per hour on the night shift.", "observation", null],
  ["The Wallenius Wilhelmsen Tosca discharged heavy machinery at Dundalk without incident.", "observation", [39.2504, -76.5312, 0]],
  ["Berth 1 at Seagirt scheduled for fender replacement next month; no vessel impact expected.", "task", [39.2646, -76.5583, 0]],
  ["Reefer monitoring rounds found all 240 plugged units within temperature spec.", "observation", null],
  ["The harbor tug Bridget McAllister returned to service after routine engine overhaul.", "observation", null],
  ["Chesapeake Bay pilots reported normal transit conditions; visibility eight nautical miles.", "observation", null],
  ["Weekly safety briefing covered updated lashing procedures for high-cube containers.", "learning", null],
  ["CSX intermodal ramp turned 96% of import boxes within 48 hours this week.", "observation", null],
  ["Empty container yard at Fairfield reached 78% utilization; repositioning plan drafted.", "observation", [39.2431, -76.5877, 0]],
  ["Maersk Kensington arrived at Seagirt berth 4 with 2,900 import containers.", "observation", [39.2646, -76.5583, 0]],
  ["Gate cameras at Dundalk upgraded to read damaged container door labels.", "observation", [39.2504, -76.5312, 0]],
  ["Thunderstorm forecast prompted crane wind-speed monitoring; operations continued below limits.", "observation", null],
  ["Hapag-Lloyd Atlanta Express completed bunkering at anchorage before berthing.", "observation", [39.2, -76.52, 0]],
  ["Terminal operating system patched overnight; gate transactions resumed at 05:00 without backlog.", "observation", null],
  ["Crane STS-04 flagged a slew-drive vibration reading at the high end of normal; monitoring continued.", "observation", [39.2646, -76.5583, 0]],
  ["Quarterly emissions report filed: terminal equipment idle time down 9% year over year.", "observation", null],
  ["Two export soybean trains unloaded at the CNX Marine Terminal on schedule.", "observation", [39.2205, -76.5866, 0]],
  ["Vessel traffic service logged 31 deep-draft transits through the main channel this week.", "observation", null],
  ["Warehouse C at Point Breeze passed its annual fire-suppression inspection.", "observation", [39.2606, -76.5773, 0]],
  ["ZIM Baltimore sailed for Norfolk after a routine eight-hour port call.", "observation", null],
  ["Chassis pool availability tightened to 91%; provider notified per service agreement.", "observation", null],
  ["Pilot association scheduled semi-annual bridge-team simulator training for member pilots.", "learning", null],
  ["Seagirt yard block E re-striped; reefer rows gained four additional plug positions.", "observation", [39.2646, -76.5583, 0]],
  ["The Atlantic Container Line Atlantic Sun loaded project cargo bound for Antwerp.", "observation", null],
  ["Random cargo exam rate held at 3.1% for the month, unchanged from prior period.", "observation", null],
  ["Tug assist requirements reviewed for vessels over 300 metres; no changes recommended.", "learning", null],
  ["Marine terminal lighting audit found six fixtures below lux spec in the Dundalk rail yard.", "observation", [39.2504, -76.5312, 0]],
  ["COSCO Development windowed for Saturday arrival; berth 3 turn time projected at 22 hours.", "observation", [39.2646, -76.5583, 0]],
  ["Monthly draft survey of the Curtis Bay coal pier showed silting within dredge tolerance.", "observation", [39.2205, -76.5866, 0]],
  ["Breakbulk crew discharged wind turbine blades at North Locust Point over two shifts.", "observation", [39.2704, -76.5952, 0]],
  ["Ship chandler deliveries consolidated to a single gate window to reduce congestion.", "decision", null],
  ["Crane operator recertification completed for 28 operators; two scheduled for retest.", "observation", null],
  ["The Grimaldi Grande Baltimora loaded 1,100 export vehicles at Dundalk.", "observation", [39.2504, -76.5312, 0]],
  ["Water taxi service resumed its harbor route after seasonal maintenance.", "observation", [39.2847, -76.6205, 0]],
  ["Line handlers reported a parted stern line on the bulk carrier Ocean Prosperity; replaced without delay to sailing.", "observation", null],
  ["Port administration approved the fiscal-year dredging budget for the access channels.", "decision", null],
  ["Refrigerated cargo volumes rose 14% month over month, led by poultry exports.", "observation", null],
  ["Security drill simulated an unauthorized gate entry; response time met the standard.", "observation", null],
  ["The container freight station cleared its LCL backlog ahead of the holiday weekend.", "observation", null],
  ["Rail dwell for export coal at Curtis Bay averaged 2.1 days, best quarter in two years.", "observation", [39.2205, -76.5866, 0]],
  ["Evergreen Ever Focus departed berth 2 after a 19-hour turn, one hour ahead of window.", "observation", [39.2646, -76.5583, 0]],
  ["Stevedore payroll system migration completed; no missed shifts reported.", "observation", null],
  ["Harbor survey vessel completed side-scan mapping of anchorage B.", "observation", [39.2, -76.52, 0]],
  ["Seagirt gate processed 4,102 truck transactions, a seasonal high, with average turn under 40 minutes.", "observation", [39.2646, -76.5583, 0]],
];

export const TODOS = [
  { content: "Review insurance exposure for charter agreements affected by the port closure", priority: "urgent" },
  { content: "Verify rerouted cargo volumes at NY/NJ against manifest data", priority: "high" },
  { content: "Compile channel clearance timeline from salvage reports", priority: "medium", due_date: "2026-08-12" },
];

const isEntryPoint =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  const BASE = (process.env.SHODH_API_URL ?? "http://127.0.0.1:3098").replace(/\/+$/, "");
  const KEY = process.env.SHODH_API_KEY ?? process.env.SHODH_API_KEYS?.split(",")[0]?.trim();
  const USER = process.env.USER_ID ?? "demo";
  if (!KEY) { console.error("SHODH_API_KEY required"); process.exit(2); }

  const H = { "X-API-Key": KEY, "Content-Type": "application/json" };
  const post = async (path, body) => {
    const res = await fetch(`${BASE}${path}`, { method: "POST", headers: H, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
    return res.json();
  };

  let ok = 0;
  for (const [content, memory_type, geo] of MEMORIES) {
    await post("/api/remember", {
      user_id: USER, content, memory_type,
      ...(geo ? { geo_location: geo } : {}),
    });
    ok += 1;
    process.stdout.write(`\rmemories: ${ok}/${MEMORIES.length}`);
  }
  console.log();
  for (const todo of TODOS) await post("/api/todos/add", { user_id: USER, ...todo });
  console.log(`todos: ${TODOS.length}`);

  const recall = await post("/api/recall", { user_id: USER, query: "why did the bridge collapse", limit: 8, debug: true });
  console.log(`recall smoke: ${recall.count} memories, ${recall.lineage?.length ?? 0} lineage edges, ${recall.facts?.length ?? 0} facts`);
  console.log("seeded.");
}
