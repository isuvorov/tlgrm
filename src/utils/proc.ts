import { execFile } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { promisify } from "node:util";
import { TERMINATE_TIMEOUT_MS } from "../constants.ts";

const execFileAsync = promisify(execFile);

/**
 * Whether a process with this PID exists.
 *
 * `kill(pid, 0)` fails in two different ways and they must not be conflated:
 * ESRCH means no such process; EPERM means the process is there but we may not
 * signal it (its PID was reused by another user's process, or we are sandboxed).
 * Treating EPERM as death means deleting someone else's lock and starting a
 * second owner on the same session — i.e. AUTH_KEY_DUPLICATED.
 */
export function pidExists(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** PID from the lock file. Says nothing about whether that owner still works. */
export function readLockPid(lockFile: string): number | undefined {
  if (!existsSync(lockFile)) return undefined;
  try {
    const raw = readFileSync(lockFile, "utf-8").trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface TerminateResult {
  /** The process is gone. */
  stopped: boolean;
  /** SIGKILL was needed, meaning gracefulExit never ran. */
  killed: boolean;
}

/**
 * Stop a process: SIGTERM first, SIGKILL once the budget runs out.
 *
 * SIGTERM matters: the owner has a gracefulExit handler on it — disconnect from
 * Telegram, release the lock, remove the socket. SIGKILL would leave that
 * debris behind along with a stuck auth_key.
 */
export async function terminate(options: {
  pid: number;
  timeoutMs?: number;
}): Promise<TerminateResult> {
  const { pid, timeoutMs = TERMINATE_TIMEOUT_MS } = options;
  if (!pidExists(pid)) return { stopped: true, killed: false };

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Died between the check and the signal — that is success, not an error.
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidExists(pid)) return { stopped: true, killed: false };
    await sleep(250);
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Also fine: the goal is the absence of the process.
  }
  await sleep(500);
  return { stopped: !pidExists(pid), killed: true };
}

/** Remove the lock+socket pair left by an owner that no longer works. */
export function clearStale(paths: { lock: string; socket: string }): void {
  for (const file of [paths.lock, paths.socket]) {
    try {
      rmSync(file, { force: true });
    } catch {
      // Best effort: we have no business deleting another user's files anyway.
    }
  }
}

export interface PackageProcess {
  pid: number;
  ppid: number;
  started: string;
  command: string;
}

/**
 * Processes of the supervised package currently in the system.
 *
 * These pile up one per closed Claude Code session whenever a session started
 * the package without a live daemon: the process became the connection owner
 * and never got to run its stdin-end handler (master.js:232-235 in the package).
 */
export async function listPackageProcesses(
  pattern = "mcp-telegram",
): Promise<PackageProcess[]> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("ps", [
      "-ax",
      "-o",
      "pid=,ppid=,lstart=,command=",
    ]));
  } catch {
    return [];
  }

  const result: PackageProcess[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.includes(pattern)) continue;
    // pid ppid <lstart: 5 fields> command...
    const parts = line.trim().split(/\s+/);
    if (parts.length < 8) continue;
    const pid = Number.parseInt(parts[0] ?? "", 10);
    const ppid = Number.parseInt(parts[1] ?? "", 10);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    result.push({
      pid,
      ppid,
      started: parts.slice(2, 7).join(" "),
      command: parts.slice(7).join(" "),
    });
  }
  return result;
}
