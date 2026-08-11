# Onboarding: the first five minutes (T14–T17)

Branch: `fix/onboarding-first-five-minutes` · Date: 2026-08-07

Fixes the four defects that make a fresh install fail — three of them silently.
Work was done by a Fable agent (commits `0481a926`, `2e6af05f`, `f8d4e0ba`,
`28e69683`) and then independently verified, which turned up three further
defects fixed in `f10225e5` and `48feef30`.

## Why this was the priority

A locally-deployable memory that nobody successfully installs is
indistinguishable from no product. Of the four defects, T15 and T16 share one
root — the auto-generated API key was never persisted, so nothing else could
learn it — and both end in capture 401ing forever while the user believes
memory is working. That is worse than a crash: a crash gets reported.

## The mechanism, chosen once

A shared key file at `<data-root>/.api-key`, written by the MCP shim and read by
the hooks. Zero IPC, works for `bash` hooks and the standalone `memory-hook.ts`
alike, and collapses the concurrent-spawn race because both shims converge on
the same key. Creation is atomic (temp file + hard link, `wx` fallback), so a
concurrent reader can never observe a half-written key.

`<data-root>` is `SHODH_MEMORY_PATH`, else the platform data dir. It is **not** a
faithful mirror of the Rust `default_storage_path()` — see below.

## What each commit does

| Commit | Defect | Failure mode it removes |
|---|---|---|
| `0481a926` | T15 | Each shim generated its own key; the spawn-race loser 401'd all session |
| `2e6af05f` | T14 | The shim that spawned the backend killed it on exit, cutting off every sibling client |
| `f8d4e0ba` | T16 | Hooks defaulted to a dev key the server never accepts; capture died silently |
| `28e69683` | T17 | Unquoted hook path broke every user whose home directory contains a space; matcher had the wrong shape |
| `f10225e5` | — | Install-time hook removal would delete a developer's hand-written hooks |
| `48feef30` | — | Env-supplied keys were never shared with hooks; a warming backend was misdiagnosed as a bad key |

## Verified, and how

Two of the three links in `shim persists → hook reads → server accepts` were
executed for real against live processes, not stubs:

- **Fresh install.** Shim run from a clean cwd with no key configured anywhere:
  generated a key, persisted it, presented it to `/api/users`.
- **Hook pickup.** A real `memory-hook.ts SessionStart` process with the same
  data root presented the *same* key and completed all six briefing calls.
- **Negative control.** The same hook without the shared root fell back to the
  dev key, got 401, and printed the loud banner plus `systemMessage` and
  `additionalContext`. The failure is loud, which was the point.
- **The env-key case** (`48feef30`): with `SHODH_API_KEY` set only for the shim,
  the hook presented `sk-shodh-dev-local-testing-key` before the fix and the
  configured key after.

The third link — the server accepting the key it was spawned with — is
source-verified, not executed: `serverEnv["SHODH_DEV_API_KEY"] = API_KEY`
(`mcp-server/index.ts`) feeds `configured_api_keys()` (`src/auth.rs`), which
accepts `SHODH_DEV_API_KEY` outside production. No server binary was built, so
this chain has not run against the real Rust server.

`/api/users` was confirmed to be an authenticated route: `auth_middleware`
exempts only `/health` and `/webhook/*`.

### This machine cannot tell fixed from broken

Three independent reasons the dev box works either way, all found during
verification:

1. `.mcp.json` pins `SHODH_API_KEY=sk-shodh-dev-local-testing-key`.
2. The repo's `.env` sets the same key, and **Bun auto-loads `.env` from cwd** —
   so even `env -u SHODH_API_KEY` does not clear it when running from the repo.
3. The hook's legacy fallback is that same literal string.

Any future test of this path must run from a directory with no `.env`.

## Known limitations — not fixed, deliberately

- **`SHODH_MEMORY_PATH` divergence.** If it is set in an MCP `env` block but not
  in the shell, the shim and the hooks resolve different roots and the hook
  falls back to the dev key. Now a loud 401 rather than silence, but not
  working. Fixing it needs a location both sides agree on without shared env.
- **`shodhDataRoot()` is not `default_storage_path()`.** The Rust function first
  returns `./shodh_memory_data` if that directory exists in the server's cwd;
  the TypeScript has no such branch. Harmless today — the server never reads the
  key file, and shim and hooks agree with each other — and the comment now says
  so instead of claiming parity.
- **PID reuse.** A recycled pid in `.mcp-shims/` reads as a live sibling and can
  pin a leaked backend. Costs a stray process, not data.
- **macOS `.sh` search order** checks the XDG path before
  `~/Library/Application Support`, unlike the TypeScript. Only bites if a stale
  XDG key file exists on a Mac.
- **`SessionStart` adds one sequential auth probe** before the parallel fetch.
- Pre-existing: `src/auth.rs:143` comments a "built-in default" that the code
  does not have; `hooks/memory-hook.test.ts` is stale and `bun test` segfaults
  on this machine. Neither is in CI.

## Test evidence

173 vitest tests pass (45 added across the six commits); `bun run build` green.
All tests ran under Node/vitest while the shim and hooks run under Bun — the
one runtime-sensitive primitive, `Atomics.wait` on the main thread, was checked
directly under Bun and works.

`~/.claude/settings.json` was **not** modified by any of this work (mtime
2026-08-05, no backup siblings); it was read to confirm the correct matcher
shape, because the repo's own template had the wrong one.
