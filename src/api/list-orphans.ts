import { type Config, loadConfig } from "../utils/config.ts";
import { lockPath } from "../utils/paths.ts";
import { listPackageProcesses, type PackageProcess, readLockPid } from "../utils/proc.ts";

export interface OrphanInfo extends PackageProcess {
  /** The lock file of this account names the PID as its owner. */
  ownerOf?: string;
}

export interface OrphansReport {
  processes: OrphanInfo[];
  /** Account -> PID from its lock file. */
  owners: Record<string, number | undefined>;
  /** Processes not registered as the owner of any account. */
  unclaimed: OrphanInfo[];
}

/**
 * Processes of the supervised package and how they relate to the lock files.
 *
 * Kills nothing: the decision belongs to the human, because live daemons appear
 * in the same list. Such processes accumulate one per closed Claude Code
 * session whenever a session ran the package without a live daemon.
 */
export async function listOrphans(
  options: { config?: Config } = {},
): Promise<OrphansReport> {
  const config = options.config ?? loadConfig();

  const owners: Record<string, number | undefined> = {};
  const ownerPids = new Map<number, string>();
  for (const account of config.accounts) {
    const pid = readLockPid(lockPath(config, account));
    owners[account] = pid;
    if (pid !== undefined) ownerPids.set(pid, account);
  }

  const processes: OrphanInfo[] = (await listPackageProcesses()).map((p) => ({
    ...p,
    ownerOf: ownerPids.get(p.pid),
  }));

  return {
    processes,
    owners,
    unclaimed: processes.filter((p) => p.ownerOf === undefined),
  };
}
