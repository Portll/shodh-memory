#!/usr/bin/env node
/**
 * A/B evaluation of harness-level continuous learning (loop 2).
 *
 * The claim under test: the harness gets better at its job because its own
 * lessons are stored as memories, recalled before each turn, and injected.
 * Until this script existed the loop wrote lessons and nobody graded the
 * outcome — a mechanism claim, not a result claim.
 *
 * Design: teach, then test, with a control arm that differs in exactly one
 * thing (`harness_learning: false` on conversation creation).
 *
 *   Phase 1 (teach)  — arm A only: conversations whose cues hit empty recalls
 *                      and tool behaviour, so the automatic capture paths
 *                      write lessons into <user>.seat-harness.
 *   Phase 2 (test)   — SAME cues, fresh conversations, both arms:
 *                        A: harness on  (lessons retrieved + injected)
 *                        B: harness off (identical otherwise)
 *
 * Two kinds of result, and the script is honest about which is which:
 *
 *   MECHANISM (asserted, deterministic, meaningful with the fixture model):
 *     - teaching produced ledger-recorded lessons
 *     - arm A test turns emit harness_learning_applied with those lessons
 *     - arm B emits none
 *     - the user's OWN recall scope never returns a seat-harness lesson
 *       (scope isolation — the failure mode that would corrupt the corpus)
 *
 *   QUALITY (reported, only meaningful with a real model via --provider):
 *     - per-arm citation rate, recall usage, tokens, latency. With the
 *       deterministic fixture these are identical BY CONSTRUCTION and the
 *       script says so instead of printing a fake delta.
 *
 *   node seat/eval/lessons-ab.mjs                     # fixture, mechanism run
 *   node seat/eval/lessons-ab.mjs --provider anthropic --model claude-sonnet-5
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

const args = process.argv.slice(2);
const argOf = (flag) => {
  const index = args.indexOf(flag);
  return index !== -1 ? args[index + 1] : undefined;
};
const PROVIDER = argOf("--provider") ?? "lmstudio";
const MODEL = argOf("--model") ?? "fixture-deterministic-v1";
const usingFixture = PROVIDER === "lmstudio" && MODEL === "fixture-deterministic-v1";

let BACKEND_PORT = 0;
let SEAT_PORT = 0;
let FIXTURE_PORT = 0;
const API_KEY = "lessons-ab-key";
const USER = "lessons-ab";
const BACKEND_EXE =
  process.env.BACKEND_EXE ??
  path.join(repoRoot, "target", "x86_64-pc-windows-msvc", "debug", "shodh-memory-server.exe");

/** Cues semantically ORTHOGONAL to the seeded corpus (which is about pylon
 *  hardware), so recall scores stay under the miss floor and the weak-recall
 *  lesson capture fires. The first version of this file used pylon-adjacent
 *  cues and learned the hard way that semantic recall "hits" on anything
 *  related — which is itself the finding that killed the literal-empty
 *  trigger. */
const TEACH_CUES = [
  "what were the quarterly marketing budget figures?",
  "which vendor supplies the cafeteria coffee beans?",
  "when does the annual charity concert take place?",
];


/** Pick a currently-free TCP port from the OS. There is an inherent race
 *  between closing the probe listener and the child binding it, but eval
 *  processes start immediately and the alternative — fixed ports — caused a
 *  real failure: a leftover service on the same port answered the health
 *  probe and the run proceeded against the WRONG process, failing seven
 *  assertions downstream of an auth mismatch. */
async function freePort() {
  const { createServer } = await import("node:net");
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const results = [];
const record = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? ` — ${detail}` : ""}`);
};

const children = [];
function launch(name, cmd, cmdArgs, env, cwd) {
  const child = spawn(cmd, cmdArgs, {
    cwd,
    env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => process.env.E2E_VERBOSE && console.log(`[${name}] ${d}`.trim()));
  child.stderr.on("data", (d) => process.env.E2E_VERBOSE && console.log(`[${name}!] ${d}`.trim()));
  children.push(child);
  return child;
}

async function waitFor(url, timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

const seatBase = () => `http://127.0.0.1:${SEAT_PORT}`;
const backendBase = () => `http://127.0.0.1:${BACKEND_PORT}`;
const backendHeaders = { "X-API-Key": API_KEY, "Content-Type": "application/json" };

async function createConversation(harnessLearning) {
  const res = await fetch(`${seatBase()}/v1/conversations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      user_id: USER,
      provider: PROVIDER,
      model: MODEL,
      harness_learning: harnessLearning,
    }),
  });
  if (!res.ok) throw new Error(`create: ${res.status} ${await res.text()}`);
  return (await res.json()).conversation_id;
}

async function sendMessage(conversationId, text) {
  const started = Date.now();
  const res = await fetch(`${seatBase()}/v1/conversations/${conversationId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`messages: ${res.status} ${await res.text()}`);
  const events = [];
  let buffer = "";
  for await (const raw of res.body) {
    buffer += Buffer.from(raw).toString("utf-8");
    let sep;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
      if (dataLine) events.push(JSON.parse(dataLine.slice(6)));
    }
  }
  return { events, ms: Date.now() - started };
}

/** Per-arm quality metrics from a set of turn event streams. */
function metrics(runs) {
  let citations = 0;
  let recallsWithHits = 0;
  let tokens = 0;
  let lessonsInjected = 0;
  let totalMs = 0;
  for (const { events, ms } of runs) {
    totalMs += ms;
    const reply = events
      .filter((e) => e.type === "text_delta")
      .map((e) => e.delta)
      .join("");
    if (/\[mem:[0-9a-f]{8}\]/.test(reply)) citations += 1;
    if (events.some((e) => e.type === "memory_recall" && (e.memories?.length ?? 0) > 0))
      recallsWithHits += 1;
    for (const e of events)
      if (e.type === "usage") tokens += e.usage?.totalTokens ?? 0;
    for (const e of events)
      if (e.type === "harness_learning_applied") lessonsInjected += e.memories?.length ?? 0;
  }
  return { citations, recallsWithHits, tokens, lessonsInjected, avgMs: Math.round(totalMs / runs.length) };
}

async function main() {
  BACKEND_PORT = await freePort();
  SEAT_PORT = await freePort();
  FIXTURE_PORT = await freePort();
  const scratch = mkdtempSync(path.join(tmpdir(), "shodh-ab-"));
  console.log(`arms: A=harness-on vs B=harness-off · model: ${PROVIDER}/${MODEL}\nscratch: ${scratch}\n`);

  launch("fixture", process.execPath, [path.join(here, "fixture-model.mjs")], {
    FIXTURE_PORT: String(FIXTURE_PORT),
  });
  launch(
    "backend",
    BACKEND_EXE,
    [],
    { SHODH_MEMORY_PATH: path.join(scratch, "backend"), SHODH_API_KEYS: API_KEY, SHODH_PORT: String(BACKEND_PORT) },
    scratch,
  );
  // A non-local provider needs the credential the user signed in with. It
  // lives in the DEFAULT seat data dir; the eval seat runs on scratch so its
  // conversations and ledger never touch real state — so carry over the
  // credential file alone, never the store. Local/fixture runs skip this.
  if (!usingFixture) {
    const defaultDataDir =
      process.platform === "win32"
        ? path.join(process.env.LOCALAPPDATA ?? "", "shodh", "seat-harness")
        : path.join(process.env.XDG_DATA_HOME ?? path.join(process.env.HOME ?? "", ".local", "share"), "shodh", "seat-harness");
    const credFile = path.join(defaultDataDir, "provider-credentials.json");
    if (existsSync(credFile)) {
      mkdirSync(path.join(scratch, "seat"), { recursive: true });
      copyFileSync(credFile, path.join(scratch, "seat", "provider-credentials.json"));
      console.log("carried provider credential into scratch seat");
    } else {
      console.log(`WARNING: no credential file at ${credFile} — non-local provider will fail auth`);
    }
  }

  launch("seat", process.execPath, [path.join(here, "..", "dist", "index.js")], {
    SHODH_API_URL: backendBase(),
    SHODH_API_KEY: API_KEY,
    SEAT_PORT: String(SEAT_PORT),
    SEAT_DATA_DIR: path.join(scratch, "seat"),
    LMSTUDIO_BASE_URL: `http://127.0.0.1:${FIXTURE_PORT}/v1`,
    OLLAMA_BASE_URL: "http://127.0.0.1:9/v1",
  });

  record("backend up", await waitFor(`${backendBase()}/health`));
  record("seat up", await waitFor(`${seatBase()}/healthz`));

  // A corpus that answers NONE of the teach cues, so recalls come back empty.
  await fetch(`${backendBase()}/api/remember`, {
    method: "POST",
    headers: backendHeaders,
    body: JSON.stringify({
      user_id: USER,
      content: "The east pylon ground strap was replaced after corrosion was found.",
      memory_type: "observation",
    }),
  });

  // ── Phase 1: teach (arm A machinery only) ────────────────────────────────
  console.log("\n— teach —");
  const teachId = await createConversation(true);
  for (const cue of TEACH_CUES) await sendMessage(teachId, cue);

  const ledger = await (
    await fetch(`${seatBase()}/v1/learning/events?limit=200`)
  ).json();
  const lessonWrites = (ledger.events ?? []).filter(
    (e) => e.entry?.scope === "harness" || JSON.stringify(e).includes("seat-harness"),
  );
  record(
    "teaching captured harness lessons (ledger)",
    lessonWrites.length > 0,
    `0 seat-harness entries in ${ledger.events?.length ?? 0} ledger events`,
  );

  // ── Phase 2: test, both arms, same cues, fresh conversations ─────────────
  console.log("\n— test —");
  const armA = [];
  const armB = [];
  for (const cue of TEACH_CUES) {
    const a = await createConversation(true);
    armA.push(await sendMessage(a, cue));
    const b = await createConversation(false);
    armB.push(await sendMessage(b, cue));
  }
  const A = metrics(armA);
  const B = metrics(armB);

  record("arm A injected lessons", A.lessonsInjected > 0, `injected=${A.lessonsInjected}`);
  record("arm B injected none (control is clean)", B.lessonsInjected === 0, `injected=${B.lessonsInjected}`);

  // Scope isolation: the user's own recall must never surface a lesson.
  const userRecall = await (
    await fetch(`${backendBase()}/api/recall`, {
      method: "POST",
      headers: backendHeaders,
      body: JSON.stringify({ user_id: USER, query: "recall strategy lesson", limit: 10 }),
    })
  ).json();
  const leaked = (userRecall.memories ?? []).some((m) =>
    /seat-harness|harness lesson|recall came back empty/i.test(m.experience?.content ?? ""),
  );
  record("no lesson leaked into user recall scope", !leaked);

  // ── Quality table ────────────────────────────────────────────────────────
  console.log("\n— quality (per arm, over the same cues) —");
  console.log(`         citations  recalls-with-hits  tokens  avg-ms  lessons-injected`);
  console.log(`  A(on)  ${A.citations}/${TEACH_CUES.length}        ${A.recallsWithHits}/${TEACH_CUES.length}                ${A.tokens}    ${A.avgMs}     ${A.lessonsInjected}`);
  console.log(`  B(off) ${B.citations}/${TEACH_CUES.length}        ${B.recallsWithHits}/${TEACH_CUES.length}                ${B.tokens}    ${B.avgMs}     ${B.lessonsInjected}`);
  if (usingFixture) {
    console.log(
      "\n  NOTE: the fixture model is deterministic and ignores injected context,\n" +
        "  so quality columns are identical by construction here. They become\n" +
        "  meaningful when run with a real model (--provider anthropic --model …).\n" +
        "  The mechanism assertions above are the fixture run's actual result.",
    );
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  await Promise.allSettled(
    children.map(
      (child) =>
        new Promise((resolve) => {
          child.once("exit", resolve);
          child.kill();
          setTimeout(resolve, 5000);
        }),
    ),
  );
  try {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch (err) {
    console.log(`scratch cleanup skipped (${err.code}): ${scratch}`);
  }
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("lessons-ab crashed:", err);
  for (const child of children) child.kill();
  process.exit(2);
});
