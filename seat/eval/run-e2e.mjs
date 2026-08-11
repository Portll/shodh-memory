#!/usr/bin/env node
/**
 * Live end-to-end run of the seat harness: real backend, real seat, scripted
 * model. Proves the plumbing a demo depends on — streaming, the tool
 * round-trip, memory ops as first-class events, both learning loops, the
 * ledger, and persistence across a seat restart — with deterministic
 * assertions. The only thing NOT exercised is model intelligence, which is
 * exactly the part a real provider swaps in without touching any of this.
 *
 * Requires a built backend binary and a built seat (`npm run build`). Spawns
 * everything itself on scratch ports/dirs; touches no real data.
 *
 *   node seat/eval/run-e2e.mjs
 *   BACKEND_EXE=path/to/shodh-memory-server.exe node seat/eval/run-e2e.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

let BACKEND_PORT = 0;
let SEAT_PORT = 0;
let FIXTURE_PORT = 0;
const API_KEY = "e2e-fixed-key";
const USER = "e2e";
const BACKEND_EXE =
  process.env.BACKEND_EXE ??
  path.join(repoRoot, "target", "x86_64-pc-windows-msvc", "debug", "shodh-memory-server.exe");


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
function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}
function assert(name, cond, detail = "") {
  record(name, Boolean(cond), cond ? "" : detail);
}

const children = [];
function launch(name, cmd, args, env, cwd) {
  const child = spawn(cmd, args, {
    cwd,
    // Explicit, minimal env. The dev machine exports SHODH_API_KEY* from
    // profile/.env sources that outrank dev keys (src/auth.rs resolution
    // order), which has silently redirected a "clean" test before. PATH is
    // kept so node/exe resolve; everything shodh-related is pinned here.
    env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => process.env.E2E_VERBOSE && console.log(`[${name}] ${d}`.trim()));
  child.stderr.on("data", (d) => process.env.E2E_VERBOSE && console.log(`[${name}!] ${d}`.trim()));
  children.push(child);
  return child;
}

async function waitFor(url, headers, timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

const backendHeaders = { "X-API-Key": API_KEY, "Content-Type": "application/json" };
const seatBase = () => `http://127.0.0.1:${SEAT_PORT}`;

/** POST a message and collect the full SSE event stream until agent_end. */
async function sendMessage(conversationId, text) {
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
  return events;
}

async function main() {
  BACKEND_PORT = await freePort();
  SEAT_PORT = await freePort();
  FIXTURE_PORT = await freePort();
  const scratch = mkdtempSync(path.join(tmpdir(), "shodh-e2e-"));
  const backendData = path.join(scratch, "backend");
  const seatData = path.join(scratch, "seat");

  console.log(`scratch: ${scratch}\n`);

  // ── processes ────────────────────────────────────────────────────────────
  launch("fixture", process.execPath, [path.join(here, "fixture-model.mjs")], {
    FIXTURE_PORT: String(FIXTURE_PORT),
  });
  launch(
    "backend",
    BACKEND_EXE,
    [],
    {
      SHODH_MEMORY_PATH: backendData,
      SHODH_API_KEYS: API_KEY,
      SHODH_PORT: String(BACKEND_PORT),
    },
    scratch,
  );

  const seatEnv = {
    SHODH_API_URL: `http://127.0.0.1:${BACKEND_PORT}`,
    SHODH_API_KEY: API_KEY,
    SEAT_PORT: String(SEAT_PORT),
    SEAT_DATA_DIR: seatData,
    LMSTUDIO_BASE_URL: `http://127.0.0.1:${FIXTURE_PORT}/v1`,
    // Dead port so the ollama probe fails fast instead of finding a real
    // install and adding nondeterministic models to the catalog.
    OLLAMA_BASE_URL: "http://127.0.0.1:9/v1",
  };
  let seat = launch("seat", process.execPath, [path.join(here, "..", "dist", "index.js")], seatEnv);

  assert(
    "backend up",
    await waitFor(`http://127.0.0.1:${BACKEND_PORT}/health`),
    "backend /health never came up — is the binary built?",
  );
  assert("seat up", await waitFor(`${seatBase()}/healthz`), "seat /healthz never came up");

  // ── seed ─────────────────────────────────────────────────────────────────
  const seeds = [
    "The relay failure in sector 7 was traced to a corroded ground strap on the east pylon.",
    "Sector 7 maintenance logs show the east pylon inspection was skipped in March.",
    "Unrelated: the cafeteria menu rotates on Thursdays.",
  ];
  let seeded = 0;
  for (const content of seeds) {
    const res = await fetch(`http://127.0.0.1:${BACKEND_PORT}/api/remember`, {
      method: "POST",
      headers: backendHeaders,
      body: JSON.stringify({ user_id: USER, content, memory_type: "observation" }),
    });
    if (res.ok) seeded += 1;
  }
  assert("seeded 3 memories", seeded === 3, `seeded ${seeded}/3`);

  // ── model discovery ──────────────────────────────────────────────────────
  const models = await (await fetch(`${seatBase()}/v1/models?refresh=1`)).json();
  const fixture = (models.models ?? []).find((m) => m.id === "fixture-deterministic-v1");
  assert("fixture model discovered via lmstudio path", Boolean(fixture));
  assert(
    "fixture model is billing:none local",
    fixture?.billing === "none" && fixture?.local === true,
    JSON.stringify(fixture ?? null),
  );

  // ── conversation ─────────────────────────────────────────────────────────
  const convo = await (
    await fetch(`${seatBase()}/v1/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: USER, provider: fixture.provider, model: fixture.id }),
    })
  ).json();
  assert("conversation created", Boolean(convo.conversation_id), JSON.stringify(convo));

  const events = await sendMessage(convo.conversation_id, "why did the relay in sector 7 fail?");
  const types = events.map((e) => e.type);

  const recall = events.find((e) => e.type === "memory_recall");
  const firstAttr = recall?.memories?.[0]?.score_attribution;
  assert("turn streamed to agent_end", types.includes("agent_end"), types.join(","));
  assert("tool round-trip ran (recall_memory)", types.includes("tool_call_start"));
  assert("memory_recall event with memories", (recall?.memories?.length ?? 0) > 0);
  assert(
    "recall carries 20-field score_attribution",
    firstAttr && Object.keys(firstAttr).length === 20,
    firstAttr ? `${Object.keys(firstAttr).length} fields` : "absent",
  );
  assert("text streamed", types.includes("text_delta"));
  const reply = events
    .filter((e) => e.type === "text_delta")
    .map((e) => e.delta)
    .join("");
  assert("reply cites [mem:id]", /\[mem:[0-9a-f]{8}\]/.test(reply), reply.slice(0, 120));
  const usage = events.find((e) => e.type === "usage");
  assert("usage reported with totals", (usage?.usage?.totalTokens ?? 0) > 0);

  // ── second turn: followup feedback path ──────────────────────────────────
  const events2 = await sendMessage(
    convo.conversation_id,
    "no, that's wrong — the relay failure was not about the pylon.",
  );
  const proactive2 = events2.find((e) => e.type === "proactive_context");
  assert("second turn ran proactive pass", Boolean(proactive2));
  assert(
    "followup feedback processed on second turn",
    proactive2?.feedback !== null && proactive2?.feedback !== undefined,
    JSON.stringify(proactive2?.feedback ?? null),
  );

  // ── ledger ───────────────────────────────────────────────────────────────
  const ledger = await (
    await fetch(`${seatBase()}/v1/learning/events?conversation_id=${convo.conversation_id}`)
  ).json();
  assert("ledger recorded learning events", (ledger.events?.length ?? 0) > 0, `0 events`);

  // ── persistence across restart ───────────────────────────────────────────
  seat.kill();
  await new Promise((r) => setTimeout(r, 1000));
  seat = launch("seat", process.execPath, [path.join(here, "..", "dist", "index.js")], seatEnv);
  assert("seat restarted", await waitFor(`${seatBase()}/healthz`));
  const detail = await (
    await fetch(`${seatBase()}/v1/conversations/${convo.conversation_id}`)
  ).json();
  assert(
    "conversation persisted across restart (2 turns)",
    (detail.turns?.length ?? detail.events?.length ?? 0) >= 2 ||
      (detail.transcript?.length ?? 0) >= 2,
    `detail keys: ${Object.keys(detail).join(",")}`,
  );

  // ── verdict ──────────────────────────────────────────────────────────────
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  // Wait for children to actually exit before removing scratch — RocksDB
  // holds its directory until the backend process is gone, and on Windows
  // kill() returns before that happens. Cleanup failure is then tolerated
  // anyway: it is a temp dir, and a leftover folder must never turn a green
  // run red.
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
  console.error("e2e runner crashed:", err);
  for (const child of children) child.kill();
  process.exit(2);
});
