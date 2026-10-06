import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync } from "node:fs";
import { BIN_NAME, START_TIMEOUT_MS } from "../constants.ts";
import { type Config, loadConfig, requireCreds } from "../utils/config.ts";
import {
  ensureAccountDir,
  logDir,
  logPath,
  nodeBin,
  packageCliPath,
  sessionPath,
} from "../utils/paths.ts";
import { probeOwner } from "./probe-owner.ts";
import { reapStaleOwner } from "./reap-stale-owner.ts";

export interface StartDaemonOptions {
  account: string;
  config?: Config;
  timeoutMs?: number;
}

export type StartOutcome =
  | "already-owned"
  | "started"
  | "refused-unknown"
  | "no-session"
  | "timeout";

export interface StartResult {
  account: string;
  outcome: StartOutcome;
  pid?: number;
  message: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Bring up the owner daemon for an account.
 *
 * Refuses to act on an `unknown` verdict: blindly starting a second owner on
 * the same MTProto session is how you get AUTH_KEY_DUPLICATED.
 */
export async function startDaemon(options: StartDaemonOptions): Promise<StartResult> {
  const { account, timeoutMs = START_TIMEOUT_MS } = options;
  const config = options.config ?? loadConfig();

  const owner = await probeOwner({ account, config });

  if (owner.state === "alive") {
    return {
      account,
      outcome: "already-owned",
      pid: owner.pid,
      message: `PID ${owner.pid ?? "?"} already owns the connection and the socket answers — nothing to start`,
    };
  }

  if (owner.state === "unknown") {
    return {
      account,
      outcome: "refused-unknown",
      pid: owner.pid,
      message: `could not check socket ${owner.socket} (${owner.reason}); start skipped so a second owner is not created — check from a regular terminal`,
    };
  }

  requireCreds(config);
  await reapStaleOwner({ account, config });

  const session = sessionPath(config, account);
  if (!existsSync(session)) {
    return {
      account,
      outcome: "no-session",
      message: `no session at ${session} — run ${BIN_NAME} login ${account} first`,
    };
  }

  ensureAccountDir(config, account);
  mkdirSync(logDir(config, account), { recursive: true });

  const log = logPath(config, account);
  const logFd = openSync(log, "a");

  // The package expects TELEGRAM_SESSION_PATH to point at the session FILE and
  // derives the lock and socket from its directory. Our .env holds the base, so
  // it is expanded here.
  const child = spawn(nodeBin(), [packageCliPath(config), "serve"], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    cwd: config.projectDir,
    env: {
      ...process.env,
      ...config.env,
      TELEGRAM_API_ID: config.apiId,
      TELEGRAM_API_HASH: config.apiHash,
      TELEGRAM_SESSION_PATH: session,
    },
  });
  // detached + unref: the daemon outlives its parent.
  child.unref();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(500);
    const check = await probeOwner({ account, config });
    if (check.state === "alive") {
      return {
        account,
        outcome: "started",
        pid: check.pid,
        message: `started, PID ${check.pid ?? child.pid ?? "?"}`,
      };
    }
  }

  return {
    account,
    outcome: "timeout",
    message: `did not come up within ${Math.round(timeoutMs / 1000)}s — see ${log}`,
  };
}
