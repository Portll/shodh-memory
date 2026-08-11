# Workbench demonstration runbook

A repeatable, verifiable walk of every surface, in the order the beats build on
each other. Each beat names what it proves and what "working" looks like, so a
rehearsal produces a pass/fail list rather than an impression.

## Preflight

1. **Binary** built from the merged demo branch; `models/` present beside it
   (GLiNER + spaCy assets are embedded/provisioned as of the causal-extraction
   fix — a scratch deployment must produce typed causal edges; if it does not,
   stop here, nothing downstream is worth rehearsing).
2. **Fresh data dir.** Never demo on a store that carries earlier experiments:
   `SHODH_MEMORY_PATH=<fresh> SHODH_API_KEYS=<key> SHODH_PORT=3030 shodh-memory-server`
3. **Seed:** `SHODH_API_URL=... SHODH_API_KEY=... USER_ID=demo node seat/eval/seed-demo-corpus.mjs`
   — the smoke line must report lineage edges > 0.
4. **Seat** on its default data dir (holds the provider credential from
   sign-in): `SHODH_API_URL=... SHODH_API_KEY=... node seat/dist/index.js`
5. **Front**: the embedded UI from the binary, or `vite` in `front/ui` for a
   dev walk. Providers page must show the model provider READY before starting.
6. Machine hygiene: antivirus exclusion for the build/binary directory
   (a debug exe binding ports repeatedly has been deleted from disk before);
   close file-sync apps; external display mirrored at 1440×900.

## The beats

| # | Beat | Proves | Working looks like |
|---|---|---|---|
| 1 | Recall: "why did the bridge collapse" | deterministic retrieval, no model | ranked results instantly; unrelated island absent |
| 2 | Select result → Inspector | attribution | 20-factor breakdown; moved factors listed, rest counted |
| 3 | Lineage hop in Inspector | causal chains | typed edges with confidence; hop lands on the cause |
| 4 | Graph destination | the ontology, visibly | typed node colours (person/org/location/…); three edge-tier colours with counts; declared edge floor caption |
| 5 | Entity click → provenance | trust chain | entity → relations → source memory text |
| 6 | Geo: search "Baltimore" | located memory | pins at real coordinates; click → Inspector |
| 7 | Floating seat over Graph | conversation follows the analyst | minimized bar shows logo · model · live tokens · billing badge |
| 8 | Ask: "what connects the Dali to the port closure? cite memories" | grounded generation | evidence fills BEFORE the model speaks; `[mem:id]` chips in the answer; reinforcement line with revert |
| 9 | Mid-conversation model swap | BYOM / evidence independence | transcript and evidence untouched; new model badge; billing semantics switch honestly |
| 10 | Tasks | work capture | seeded todos, priority/overdue badges |
| 11 | Learning ledger (via chat blocks) | reviewability | reinforce/write events listed; revert works and says what it can and cannot undo |
| 12 | **Needle**: ask "was there any warning sign before the Dali incident?" | needle-in-haystack over ~67 memories | the three quiet pre-incident memories (switchboard alarm at inspection, reefer-feeder voltage sag, deferred breaker overhaul) surface out of the routine noise; the model assembles them into a warning narrative with `[mem:id]` chips; none of the haystack ops logs pollute the evidence |
| 13 | **Anomaly**: ask "any anomalies in the container manifests?" | quantitative outlier detection via recall | the single MSKU-4471820 weight mismatch (4,200 kg declared vs 28,650 kg weighed) surfaces from dozens of routine manifest/ops memories; model states the discrepancy and the VGM flag |
| 14 | **Contradiction**: ask "how many crew were injured in the collapse?" | the system carries corrections, the model reasons over them | both the initial four-injured report and the correction surface; the model leads with the corrected fact and cites the correction memory |
| 15 | **Geo outlier**: map view after asking "anything unusual in truck movements?" | spatial anomaly, visibly | truck T-118's Annapolis ping sits alone, far from the port cluster; clicking it opens the Inspector on the off-corridor memory |

Beats 12–15 are the analyst-workbench thesis in miniature: the model is
replaceable (beat 9 proved it), the MEMORY does the finding. Deliver each one
by typing the quoted ask into the seat, then let the evidence panel populate
before the model speaks — the audience must see retrieval land first.

Beat 9 runs on the SAME subscription credential: swap between two models of
the configured provider (e.g. a Sonnet-class to a Haiku-class model). The
evidence panel not changing while the prose and latency visibly do is the
whole point, and it needs no second provider. Local runtimes (Ollama/vLLM)
are deliberately deferred — when one is installed later, the same beat gains
the on-device variant and the egress badge flip, with no other change.

## Rehearsal rule

Walk all beats twice: once as the operator, once letting someone else drive
from this table without help. Anything that needs explaining is a finding.
