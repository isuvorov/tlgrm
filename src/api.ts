/**
 * Public API aggregator: every operation in one place.
 *
 * Each operation takes a single options object plus an optional `config`, so a
 * caller can reuse an already-loaded .env (and substitute it in tests). Without
 * `config` it is loaded on demand.
 */

export type { DoctorReport, Finding, Severity } from "./api/doctor.ts";
export { doctor } from "./api/doctor.ts";
export type { AccountHealth, AccountStatus } from "./api/get-status.ts";
export { getStatus, listStatuses } from "./api/get-status.ts";
export type { OrphanInfo, OrphansReport } from "./api/list-orphans.ts";
export { listOrphans } from "./api/list-orphans.ts";
export type { LoginResult } from "./api/login.ts";
export { login } from "./api/login.ts";
export type { OwnerInfo } from "./api/probe-owner.ts";
export { probeOwner } from "./api/probe-owner.ts";
export type { ReapResult } from "./api/reap-stale-owner.ts";
export { reapStaleOwner } from "./api/reap-stale-owner.ts";
export type { ServeOptions } from "./api/serve.ts";
export { serveAccounts } from "./api/serve.ts";
export type { StartOutcome, StartResult } from "./api/start-daemon.ts";
export { startDaemon } from "./api/start-daemon.ts";
export type { StopResult } from "./api/stop-daemon.ts";
export { stopDaemon } from "./api/stop-daemon.ts";
export type { LogTail } from "./api/tail-logs.ts";
export { tailLogs } from "./api/tail-logs.ts";
export { BIN_NAME, PACKAGE_NAME, VERSION } from "./constants.ts";
export type { Config } from "./utils/config.ts";
export {
  discoverAccounts,
  loadConfig,
  parseEnvFile,
  resolveSessionBase,
} from "./utils/config.ts";
export { listPackageProcesses, pidExists, readLockPid } from "./utils/proc.ts";
export type { OwnerState, ProbeResult } from "./utils/socket.ts";
export { probeSocket } from "./utils/socket.ts";
