import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
 * dist/ of the supervised package. The copy next to this checkout first, then
 * wherever node resolves it from here — an npm install may hoist it out of
 * our own node_modules.
 */
export function packageDistDir(config: Config): string | undefined {
  const pinned = join(config.projectDir, "node_modules", PACKAGE_NAME, "dist");
  if (existsSync(pinned)) return pinned;
  try {
    return dirname(createRequire(import.meta.url).resolve(PACKAGE_NAME));
  } catch {
    return undefined;
  }
}

/**
 * CLI of the supervised package. The copy resolved for this install first, a
 * global installation second: owner and client talk over a private IPC
 * protocol, so a version mismatch between them breaks every tool call.
 */
export function packageCliPath(config: Config): string {
  const dist = packageDistDir(config);
  const pinned = dist ? join(dist, "cli.js") : undefined;
  if (pinned && existsSync(pinned)) return pinned;

  const global = `/opt/homebrew/lib/node_modules/${PACKAGE_NAME}/dist/cli.js`;
  if (existsSync(global)) return global;

  throw new Error(
    `CLI of ${PACKAGE_NAME} not found: neither in ${config.projectDir}/node_modules nor ${global}. Install dependencies: pnpm install`,
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
export function ownCliPath(): string {
  // src/utils/paths.ts -> src/cli.ts, lib/utils/paths.js -> lib/cli.js
  const self = fileURLToPath(import.meta.url);
  return join(dirname(self), "..", `cli${extname(self)}`);
}
