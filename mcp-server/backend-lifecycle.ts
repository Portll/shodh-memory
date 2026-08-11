/**
 * Shared-backend lifecycle bookkeeping for MCP shims.
 *
 * Problem this solves: the backend server is spawned detached and shared —
 * several MCP shims (Claude Code, Claude Desktop, Cursor, ...) plus the
 * Claude Code hooks all talk to the same process. The shim that happened to
 * spawn it used to kill it on its own exit, yanking the backend out from
 * under every other client mid-session.
 *
 * Mechanism: pidfiles under the shodh data root.
 *   - `<root>/.mcp-shims/<pid>.pid` — one registration file per live shim.
 *   - `<root>/.mcp-server.pid`      — the pid of an auto-spawned backend.
 * On exit a shim unregisters itself, then kills the backend only when no
 * other live shim remains AND the backend was auto-spawned (pidfile exists).
 * Manually started servers never get a pidfile, so they are never killed.
 *
 * All functions are synchronous: the exit path runs inside process.on("exit")
 * where async work is impossible. Stale registrations (crashed shims) are
 * pruned by liveness-checking their pids.
 */

import * as fs from "fs";
import * as path from "path";

export const SERVER_PIDFILE = ".mcp-server.pid";
export const SHIM_PID_DIR = ".mcp-shims";

/** True when a process with this pid exists (EPERM means it exists but is not ours). */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function shimDir(rootDir: string): string {
  return path.join(rootDir, SHIM_PID_DIR);
}

function shimFile(rootDir: string, pid: number): string {
  return path.join(shimDir(rootDir), `${pid}.pid`);
}

/** Register this shim as a live user of the shared backend. Returns the pidfile path. */
export function registerShim(rootDir: string, pid: number = process.pid): string {
  const dir = shimDir(rootDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = shimFile(rootDir, pid);
  fs.writeFileSync(file, `${pid}\n`, { mode: 0o600 });
  return file;
}

/** Remove this shim's registration. Safe to call when never registered. */
export function unregisterShim(rootDir: string, pid: number = process.pid): void {
  try {
    fs.unlinkSync(shimFile(rootDir, pid));
  } catch {
    // Already gone or never registered.
  }
}

/**
 * Pids of other shims that are still alive. Stale registrations (dead pids,
 * unparseable filenames) are pruned as a side effect.
 */
export function liveSiblingShims(rootDir: string, selfPid: number = process.pid): number[] {
  const dir = shimDir(rootDir);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }

  const alive: number[] = [];
  for (const entry of entries) {
    const match = /^(\d+)\.pid$/.exec(entry);
    const pid = match ? parseInt(match[1], 10) : NaN;
    if (!match || Number.isNaN(pid)) {
      try {
        fs.unlinkSync(path.join(dir, entry));
      } catch {
        // Best effort prune.
      }
      continue;
    }
    if (pid === selfPid) continue;
    if (isPidAlive(pid)) {
      alive.push(pid);
    } else {
      try {
        fs.unlinkSync(path.join(dir, entry));
      } catch {
        // Best effort prune.
      }
    }
  }
  return alive;
}

/**
 * Record the pid of an auto-spawned backend. Never clobbers the record of a
 * backend that is still alive (e.g. a concurrent shim's spawn won the port);
 * dead or missing records are replaced.
 */
export function recordSpawnedServer(rootDir: string, pid: number): void {
  const file = path.join(rootDir, SERVER_PIDFILE);
  const existing = readSpawnedServerPid(rootDir);
  if (existing !== null && existing !== pid && isPidAlive(existing)) return;
  fs.mkdirSync(rootDir, { recursive: true });
  fs.writeFileSync(file, `${pid}\n`, { mode: 0o600 });
}

/** Pid of the auto-spawned backend, or null when none was recorded. */
export function readSpawnedServerPid(rootDir: string): number | null {
  try {
    const raw = fs.readFileSync(path.join(rootDir, SERVER_PIDFILE), "utf-8").trim();
    const pid = parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** Remove the auto-spawned backend record. */
export function clearSpawnedServer(rootDir: string): void {
  try {
    fs.unlinkSync(path.join(rootDir, SERVER_PIDFILE));
  } catch {
    // Already gone.
  }
}

/**
 * Decide whether the exiting shim should reap the auto-spawned backend.
 * Call AFTER unregisterShim. Returns the backend pid to kill, or null when:
 *   - other live shims still use the backend, or
 *   - no auto-spawned backend was recorded (manually started servers), or
 *   - the recorded backend is already dead (record is cleared).
 */
export function backendPidToReap(rootDir: string, selfPid: number = process.pid): number | null {
  if (liveSiblingShims(rootDir, selfPid).length > 0) return null;
  const pid = readSpawnedServerPid(rootDir);
  if (pid === null) return null;
  if (!isPidAlive(pid)) {
    clearSpawnedServer(rootDir);
    return null;
  }
  return pid;
}
