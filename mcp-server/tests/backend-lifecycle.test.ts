import { describe, expect, it, beforeEach, afterEach, beforeAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import {
  SERVER_PIDFILE,
  SHIM_PID_DIR,
  backendPidToReap,
  clearSpawnedServer,
  isPidAlive,
  liveSiblingShims,
  readSpawnedServerPid,
  recordSpawnedServer,
  registerShim,
  unregisterShim,
} from "../backend-lifecycle";

let tmpRoot: string;
// A pid that definitely existed and is definitely dead now (short-lived child).
let deadPid: number;

beforeAll(() => {
  const child = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
  if (child.pid === undefined) throw new Error("failed to spawn probe child");
  deadPid = child.pid;
});

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shodh-lifecycle-test-"));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("isPidAlive", () => {
  it("is true for the current process and false for a dead pid", () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(deadPid)).toBe(false);
  });

  it("rejects garbage pids", () => {
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-5)).toBe(false);
    expect(isPidAlive(1.5)).toBe(false);
  });
});

describe("shim registration", () => {
  it("registers and unregisters a pidfile", () => {
    const file = registerShim(tmpRoot, process.pid);
    expect(file).toBe(path.join(tmpRoot, SHIM_PID_DIR, `${process.pid}.pid`));
    expect(fs.existsSync(file)).toBe(true);
    unregisterShim(tmpRoot, process.pid);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("unregister is safe when never registered", () => {
    expect(() => unregisterShim(tmpRoot, 12345)).not.toThrow();
  });
});

describe("liveSiblingShims", () => {
  it("excludes self and prunes dead registrations", () => {
    registerShim(tmpRoot, process.pid); // self
    registerShim(tmpRoot, deadPid); // crashed shim
    const siblings = liveSiblingShims(tmpRoot, process.pid);
    expect(siblings).toEqual([]);
    // The dead shim's stale file must have been pruned.
    expect(fs.existsSync(path.join(tmpRoot, SHIM_PID_DIR, `${deadPid}.pid`))).toBe(false);
  });

  it("reports a live sibling", () => {
    // Register our own (live) pid, then ask from the perspective of another shim.
    registerShim(tmpRoot, process.pid);
    const siblings = liveSiblingShims(tmpRoot, deadPid);
    expect(siblings).toEqual([process.pid]);
  });

  it("returns empty when the directory does not exist", () => {
    expect(liveSiblingShims(tmpRoot, process.pid)).toEqual([]);
  });

  it("prunes unparseable entries", () => {
    fs.mkdirSync(path.join(tmpRoot, SHIM_PID_DIR), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, SHIM_PID_DIR, "garbage.txt"), "x");
    expect(liveSiblingShims(tmpRoot, process.pid)).toEqual([]);
    expect(fs.existsSync(path.join(tmpRoot, SHIM_PID_DIR, "garbage.txt"))).toBe(false);
  });
});

describe("spawned server record", () => {
  it("records and reads the backend pid", () => {
    recordSpawnedServer(tmpRoot, 4242);
    expect(readSpawnedServerPid(tmpRoot)).toBe(4242);
    clearSpawnedServer(tmpRoot);
    expect(readSpawnedServerPid(tmpRoot)).toBeNull();
  });

  it("does not clobber a live backend's record (concurrent-spawn loser)", () => {
    recordSpawnedServer(tmpRoot, process.pid); // "live" backend
    recordSpawnedServer(tmpRoot, 99999999); // loser tries to record its dead child
    expect(readSpawnedServerPid(tmpRoot)).toBe(process.pid);
  });

  it("replaces a dead backend's record", () => {
    recordSpawnedServer(tmpRoot, deadPid);
    recordSpawnedServer(tmpRoot, process.pid);
    expect(readSpawnedServerPid(tmpRoot)).toBe(process.pid);
  });

  it("readSpawnedServerPid rejects garbage content", () => {
    fs.writeFileSync(path.join(tmpRoot, SERVER_PIDFILE), "not-a-pid\n");
    expect(readSpawnedServerPid(tmpRoot)).toBeNull();
  });
});

describe("backendPidToReap — the T14 kill decision", () => {
  it("never kills while another live shim is registered", () => {
    recordSpawnedServer(tmpRoot, process.pid); // pretend backend is alive
    registerShim(tmpRoot, process.pid); // a live sibling (our own pid, seen from selfPid=deadPid)
    expect(backendPidToReap(tmpRoot, deadPid)).toBeNull();
  });

  it("returns the backend pid when this is the last shim", () => {
    recordSpawnedServer(tmpRoot, process.pid);
    expect(backendPidToReap(tmpRoot, process.pid)).toBe(process.pid);
  });

  it("returns null when no backend was auto-spawned (manual servers are never killed)", () => {
    expect(backendPidToReap(tmpRoot, process.pid)).toBeNull();
  });

  it("clears the record and returns null when the backend already died", () => {
    recordSpawnedServer(tmpRoot, deadPid);
    expect(backendPidToReap(tmpRoot, process.pid)).toBeNull();
    expect(readSpawnedServerPid(tmpRoot)).toBeNull();
  });

  it("ignores stale registrations from crashed shims", () => {
    recordSpawnedServer(tmpRoot, process.pid);
    registerShim(tmpRoot, deadPid); // crashed shim never unregistered
    expect(backendPidToReap(tmpRoot, process.pid)).toBe(process.pid);
  });
});
