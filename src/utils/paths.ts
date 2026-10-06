import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  ACCOUNT_DIR_MODE,
  LOCK_FILE,
  NODE_BIN,
  NODE_FALLBACKS,
  PACKAGE_NAME,
  SESSION_FILE,
  SOCKET_FILE,
} from "../constants.ts";
import type { Config } from "./config.ts";

/** Account directory: holds the session, daemon.lock and daemon.sock. */
export function accountDir(config: Config, account: string): string {
  return join(config.sessionBase, account);
}

export function lockPath(config: Config, account: string): string {
  return join(accountDir(config, account), LOCK_FILE);
}

export function socketPath(config: Config, account: string): string {
  return join(accountDir(config, account), SOCKET_FILE);
}

export function sessionPath(config: Config, account: string): string {
  return join(accountDir(config, account), SESSION_FILE);
}

/**
 * Create the account directory with a private mode.
 *
 * `mkdir -p` defaults to 0755, which would leave the directory holding the
 * MTProto session file traversable by every local user. The IPC socket is
 * chmod'ed to 0600 by the package, but the session file next to it is the
 * actual account credential, so the directory gets 0700.
 */
export function ensureAccountDir(config: Config, account: string): string {
  const dir = accountDir(config, account);
  mkdirSync(dir, { recursive: true, mode: ACCOUNT_DIR_MODE });
  return dir;
}

/**
 * Owner log, under XDG_DATA_HOME rather than next to the session.
 *
 * Not beside the session file on purpose: that directory is mode 0700 and holds
 * a full account credential, and a log is the one thing here a user wants to
 * open, paste and share.
 */
export function logDir(config: Config, account: string): string {
  return join(config.logBase, account);
}

export function logPath(config: Config, account: string): string {
  return join(logDir(config, account), "serve.log");
}

/**
 * Where this account's log used to be written, inside the checkout.
 *
 * Kept for reading only: after the move a user still has months of history in
 * the old place, and `logs` silently showing an empty file would read as "the
 * owner never logged anything".
 */
export function legacyLogPath(config: Config, account: string): string {
  return join(config.projectDir, ".sessions", account, "serve.log");
}

/**
 * CLI of the supervised package. The pinned copy in the repo's node_modules
 * first, a global installation second: owner and client talk over a private IPC
 * protocol, so a version mismatch between them breaks every tool call.
 */
export function packageCliPath(config: Config): string {
  const pinned = join(config.projectDir, "node_modules", PACKAGE_NAME, "dist", "cli.js");
  if (existsSync(pinned)) return pinned;

  const global = `/opt/homebrew/lib/node_modules/${PACKAGE_NAME}/dist/cli.js`;
  if (existsSync(global)) return global;

  throw new Error(
    `CLI of ${PACKAGE_NAME} not found: neither ${pinned} nor ${global}. Install dependencies: pnpm install`,
  );
}

/** Absolute node, so a child does not depend on how PATH happens to be set. */
export function nodeBin(): string {
  if (existsSync(NODE_BIN)) return NODE_BIN;
  for (const candidate of NODE_FALLBACKS) {
    if (existsSync(candidate)) return candidate;
  }
  // Last resort — whatever node is running us right now.
  return process.execPath;
}

/** This tool's own CLI — used when printing an MCP stdio registration. */
export function ownCliPath(config: Config): string {
  return join(config.projectDir, "src", "cli.ts");
}
