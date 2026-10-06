import { type Config, loadConfig } from "../utils/config.ts";
import { lockPath, socketPath } from "../utils/paths.ts";
import { readLockPid } from "../utils/proc.ts";
import { type OwnerState, probeSocket } from "../utils/socket.ts";

export interface ProbeOwnerOptions {
  account: string;
  config?: Config;
  timeoutMs?: number;
}

export interface OwnerInfo {
  account: string;
  state: OwnerState;
  reason: string;
  /** PID from the lock file. May exist even when state !== 'alive'. */
  pid?: number;
  socket: string;
  lock: string;
}

/**
 * Who owns the account's connection — decided by the socket's answer, never by
 * the PID in the lock file.
 *
 * Returns three states; `dead` is the only one that permits killing the lock
 * holder or starting a daemon. See OwnerState in utils/socket.ts.
 */
export async function probeOwner(options: ProbeOwnerOptions): Promise<OwnerInfo> {
  const { account, timeoutMs } = options;
  const config = options.config ?? loadConfig();
  const socket = socketPath(config, account);
  const lock = lockPath(config, account);

  const { state, reason } = await probeSocket({ socketPath: socket, timeoutMs });

  return { account, state, reason, pid: readLockPid(lock), socket, lock };
}
