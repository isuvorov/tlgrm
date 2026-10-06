import { type Config, loadConfig } from "../utils/config.ts";
import { clearStale, pidExists, terminate } from "../utils/proc.ts";
import { probeOwner } from "./probe-owner.ts";

export interface StopDaemonOptions {
  account: string;
  config?: Config;
}

export interface StopResult {
  account: string;
  stopped: boolean;
  pid?: number;
  killed?: boolean;
  message: string;
}

export async function stopDaemon(options: StopDaemonOptions): Promise<StopResult> {
  const { account } = options;
  const config = options.config ?? loadConfig();

  const owner = await probeOwner({ account, config });

  if (owner.pid === undefined || !pidExists(owner.pid)) {
    // A stale pair left by a process that was killed past SIGTERM.
    clearStale({ lock: owner.lock, socket: owner.socket });
    return { account, stopped: true, message: "not running" };
  }

  const result = await terminate({ pid: owner.pid });
  clearStale({ lock: owner.lock, socket: owner.socket });

  return {
    account,
    stopped: result.stopped,
    pid: owner.pid,
    killed: result.killed,
    message: `${result.stopped ? "stopped" : "could not stop"} (PID ${owner.pid})${result.killed ? ", finished with SIGKILL" : ""}`,
  };
}
