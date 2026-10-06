import { existsSync } from "node:fs";
import { BIN_NAME } from "../constants.ts";
import { type Config, loadConfig } from "../utils/config.ts";
import { logPath, sessionPath } from "../utils/paths.ts";
import { pidExists } from "../utils/proc.ts";
import type { OwnerState } from "../utils/socket.ts";
import { probeOwner } from "./probe-owner.ts";

/**
 * Verdict for one account. `orphaned` is the failure that used to block an
 * account forever: the PID is alive and holds the lock, but the socket is not
 * being served.
 */
export type AccountHealth =
  | "alive"
  | "orphaned"
  | "stale-lock"
  | "stopped"
  | "no-session"
  | "unknown";

export interface AccountStatus {
  account: string;
  health: AccountHealth;
  ownerState: OwnerState;
  pid?: number;
  socket: string;
  session: string;
  hasSession: boolean;
  log: string;
  /** What the human should do. Empty when everything is fine. */
  advice?: string;
  message: string;
}

export interface GetStatusOptions {
  account: string;
  config?: Config;
}

export async function getStatus(options: GetStatusOptions): Promise<AccountStatus> {
  const { account } = options;
  const config = options.config ?? loadConfig();

  const owner = await probeOwner({ account, config });
  const session = sessionPath(config, account);
  const hasSession = existsSync(session);

  const base = {
    account,
    ownerState: owner.state,
    pid: owner.pid,
    socket: owner.socket,
    session,
    hasSession,
    log: logPath(config, account),
  };

  if (owner.state === "alive") {
    return {
      ...base,
      health: "alive",
      message: `alive, PID ${owner.pid ?? "?"}, socket ${owner.socket}`,
    };
  }

  if (owner.state === "unknown") {
    return {
      ...base,
      health: "unknown",
      message: `UNKNOWN — ${owner.reason} (lock holds PID ${owner.pid ?? "none"})`,
      advice: "this is what a sandbox looks like: run it from a regular terminal",
    };
  }

  if (!hasSession) {
    return {
      ...base,
      health: "no-session",
      message: `no session at ${session}`,
      advice: `${BIN_NAME} login ${account}`,
    };
  }

  if (owner.pid !== undefined && pidExists(owner.pid)) {
    return {
      ...base,
      health: "orphaned",
      message: `ORPHANED owner — PID ${owner.pid} holds the lock and the Telegram connection, but the socket does not answer`,
      advice: `${BIN_NAME} start ${account} — takes it down and brings up a daemon`,
    };
  }

  if (owner.pid !== undefined) {
    return {
      ...base,
      health: "stale-lock",
      message: `stale lock (PID ${owner.pid} is gone)`,
      advice: `${BIN_NAME} start ${account} will clean it up`,
    };
  }

  return {
    ...base,
    health: "stopped",
    message: "not running",
    advice: `${BIN_NAME} start ${account}`,
  };
}

export async function listStatuses(options: { config?: Config } = {}) {
  const config = options.config ?? loadConfig();
  return Promise.all(config.accounts.map((account) => getStatus({ account, config })));
}
