import { type Config, loadConfig } from "../utils/config.ts";
import { clearStale, pidExists, terminate } from "../utils/proc.ts";
import { probeOwner } from "./probe-owner.ts";

export interface ReapStaleOwnerOptions {
  account: string;
  config?: Config;
}

export interface ReapResult {
  account: string;
  /** Whether the lock was released. `false` means intervening was not allowed. */
  reaped: boolean;
  /** Who had to be taken down; undefined when the lock was merely stale. */
  terminatedPid?: number;
  killed?: boolean;
  reason: string;
}

/**
 * Release an account's lock when a non-functional process holds it.
 *
 * The internal guard is mandatory: killing is allowed ONLY on an explicit
 * `dead` verdict. On `unknown` (a sandbox refused the socket, or the owner did
 * not answer within the budget) this refuses to act — otherwise it would take
 * down a healthy daemon.
 *
 * Without this cleanup a restart cannot succeed: tryAcquireLock() in the
 * package sees a held lock with a live PID and exits with code 1, so an
 * orphaned owner blocks the account for good.
 */
export async function reapStaleOwner(
  options: ReapStaleOwnerOptions,
): Promise<ReapResult> {
  const { account } = options;
  const config = options.config ?? loadConfig();
  const owner = await probeOwner({ account, config });

  if (owner.state !== "dead") {
    return {
      account,
      reaped: false,
      reason: `owner not declared dead (${owner.state}: ${owner.reason}) — leaving it alone`,
    };
  }

  let terminatedPid: number | undefined;
  let killed = false;

  if (owner.pid !== undefined && pidExists(owner.pid)) {
    // An orphaned owner: still holds the Telegram connection, no longer serves
    // clients.
    const result = await terminate({ pid: owner.pid });
    terminatedPid = owner.pid;
    killed = result.killed;
  }

  clearStale({ lock: owner.lock, socket: owner.socket });

  return {
    account,
    reaped: true,
    terminatedPid,
    killed,
    reason:
      terminatedPid === undefined
        ? "lock was stale, there was no owner"
        : `orphaned owner PID ${terminatedPid} taken down${killed ? " (SIGKILL)" : ""}`,
  };
}
