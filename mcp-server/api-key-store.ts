/**
 * Persisted API key shared between every local shodh-memory client.
 *
 * Problem this solves: when no key is configured in the environment, each MCP
 * shim used to generate its own random key in memory. Two shims starting
 * concurrently would each generate a different key — whichever one lost the
 * spawn race then received 401s for the rest of the session. Claude Code hooks
 * (memory-hook.ts and the .sh hooks) had no way to learn the auto-generated
 * key at all, so capture died silently on every fresh install.
 *
 * Mechanism: the first shim to need a key generates one and persists it to
 * `<data-root>/.api-key`, created atomically so exactly one writer wins.
 * Every other shim — and every hook — reads that file. The data root matches
 * the Rust server's default storage path (`dirs::data_dir()/shodh-memory`,
 * see src/config.rs::default_storage_path), or SHODH_MEMORY_PATH when set.
 * The key file sits beside the server's subdirectories (`storage/`,
 * `bm25_index/`) — never inside a RocksDB directory.
 *
 * NOTE: hooks/memory-hook.ts ships as a single self-contained file and cannot
 * import this module. It duplicates the read-side path resolution — keep the
 * two in sync (search for API_KEY_FILENAME there).
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export const API_KEY_FILENAME = ".api-key";

/**
 * Resolve the directory that holds the shared key and pidfiles:
 *   - SHODH_MEMORY_PATH when set
 *   - Windows: %APPDATA%\shodh-memory
 *   - macOS:   ~/Library/Application Support/shodh-memory
 *   - Linux:   $XDG_DATA_HOME/shodh-memory or ~/.local/share/shodh-memory
 *
 * This is NOT a faithful mirror of the Rust server's `default_storage_path()`
 * (src/config.rs): that function first returns `./shodh_memory_data` when such
 * a directory exists in the server's working directory, and this one has no
 * equivalent branch. Harmless today — the server receives its key through the
 * environment and never reads this file, and every reader (shim and hooks)
 * resolves the root the same way, so they always agree with each other. It
 * matters only if something later assumes the key file sits next to the
 * database. Do not "fix" this by claiming parity in a comment; if real parity
 * is ever needed, port the legacy branch and say so here.
 */
export function shodhDataRoot(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDir: string = os.homedir(),
): string {
  const explicit = env.SHODH_MEMORY_PATH?.trim();
  if (explicit) return explicit;

  if (platform === "win32") {
    const appData = env.APPDATA?.trim() || path.join(homeDir, "AppData", "Roaming");
    return path.join(appData, "shodh-memory");
  }
  if (platform === "darwin") {
    return path.join(homeDir, "Library", "Application Support", "shodh-memory");
  }
  const xdg = env.XDG_DATA_HOME?.trim() || path.join(homeDir, ".local", "share");
  return path.join(xdg, "shodh-memory");
}

export function apiKeyFilePath(rootDir: string): string {
  return path.join(rootDir, API_KEY_FILENAME);
}

/** Read a persisted key. Returns null when the file is missing or empty. */
export function readPersistedApiKey(file: string): string | null {
  try {
    const raw = fs.readFileSync(file, "utf-8").trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

/** Synchronous sleep without spinning the CPU (used only in a rare race window). */
function sleepSync(ms: number): void {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

/**
 * Create `file` with `content` if and only if it does not already exist.
 * Returns true when this process created the file, false when it already
 * existed (i.e. another process won the race).
 *
 * Primary strategy: write a private temp file, then hard-link it into place.
 * link(2) fails with EEXIST if the target exists and — unlike open(O_EXCL) +
 * write — makes the complete content appear atomically, so a concurrent
 * reader can never observe a partially written key. Falls back to an
 * exclusive write on filesystems without hard-link support.
 */
function createExclusive(file: string, content: string): boolean {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  try {
    fs.linkSync(tmp, file);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return false;
    // Hard links unsupported here — fall back to exclusive create.
    try {
      fs.writeFileSync(file, content, { flag: "wx", mode: 0o600 });
      return true;
    } catch (wxErr) {
      if ((wxErr as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw wxErr;
    }
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Best effort: tmp already gone or was renamed away.
    }
  }
}

/** Atomically replace `file` with `content` (used to heal an empty/corrupt key file). */
function replaceAtomic(file: string, content: string): void {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * Publish an already-resolved key (one that came from the environment) to the
 * shared file so hooks can find it.
 *
 * Why this exists: an MCP client's `env` block — the normal way to configure
 * SHODH_API_KEY — is visible only to the shim process. Claude Code hooks are
 * spawned by Claude Code itself and never see it, so without this they fall
 * back to the legacy dev key and get 401s. Auto-generated keys were already
 * shared via loadOrCreatePersistedApiKey; this closes the same gap for the
 * more common configured-key case.
 *
 * Callers MUST gate this on the backend being local — a remote/production key
 * does not belong on disk just because a hook might want it.
 *
 * Returns true when the file was created or updated, false when it already
 * held this key (the steady state, so the common path does no writes).
 */
export function publishSharedApiKey(rootDir: string, key: string): boolean {
  const file = apiKeyFilePath(rootDir);
  if (readPersistedApiKey(file) === key) return false;
  fs.mkdirSync(rootDir, { recursive: true });
  // Replace rather than create-exclusive: the configured key is authoritative,
  // and rewriting it is how a stale key from an earlier config self-heals.
  replaceAtomic(file, key + "\n");
  return true;
}

export interface PersistedApiKey {
  key: string;
  file: string;
  /** True when this call generated and persisted a new key. */
  created: boolean;
}

/**
 * Load the shared API key, generating and persisting one if none exists yet.
 *
 * Concurrency contract: any number of processes may call this at the same
 * time; exactly one generates the key, and every caller returns the same
 * value. Losers of the creation race read the winner's file (with a short
 * bounded retry to cover the wx-fallback write window).
 */
export function loadOrCreatePersistedApiKey(
  rootDir: string,
  generate: () => string,
): PersistedApiKey {
  const file = apiKeyFilePath(rootDir);

  const existing = readPersistedApiKey(file);
  if (existing) return { key: existing, file, created: false };

  fs.mkdirSync(rootDir, { recursive: true });

  const candidate = generate();
  if (createExclusive(file, candidate + "\n")) {
    return { key: candidate, file, created: true };
  }

  // Another process created the file first — read the winner's key.
  for (let attempt = 0; attempt < 20; attempt++) {
    const winner = readPersistedApiKey(file);
    if (winner) return { key: winner, file, created: false };
    sleepSync(25);
  }

  // The file exists but never became readable/non-empty: a writer crashed
  // mid-create. Heal it by atomically installing our candidate.
  replaceAtomic(file, candidate + "\n");
  return { key: candidate, file, created: true };
}
