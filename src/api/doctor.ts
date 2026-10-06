import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BIN_NAME, ENV_PREFIX, PACKAGE_NAME } from "../constants.ts";
import { type Config, loadConfig } from "../utils/config.ts";
import { packageCliPath } from "../utils/paths.ts";
import { type AccountStatus, listStatuses } from "./get-status.ts";
import { listOrphans, type OrphansReport } from "./list-orphans.ts";

export type Severity = "ok" | "warn" | "error";

export interface Finding {
  severity: Severity;
  title: string;
  detail: string;
  advice?: string;
}

export interface DoctorReport {
  accounts: AccountStatus[];
  orphans: OrphansReport;
  findings: Finding[];
}

/** Name of the variable listing MCP configs — derived from the CLI name. */
const MCP_CONFIGS_ENV = `${ENV_PREFIX}_MCP_CONFIGS`;

/** Where an MCP server is usually registered. Override with <PREFIX>_MCP_CONFIGS. */
function defaultMcpConfigs(): string[] {
  const home = homedir();
  return [
    join(home, ".claude.json"),
    join(home, ".cursor", "mcp.json"),
    join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
  ];
}

interface McpEntry {
  file: string;
  name: string;
  command?: string;
  hasCreds: boolean;
}

function readMcpEntries(files: string[]): McpEntry[] {
  const entries: McpEntry[] = [];
  for (const file of files) {
    if (!existsSync(file)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf-8"));
    } catch {
      continue;
    }
    const servers = (parsed as { mcpServers?: Record<string, unknown> })?.mcpServers;
    if (!servers || typeof servers !== "object") continue;

    for (const [name, raw] of Object.entries(servers)) {
      const entry = raw as {
        command?: string;
        args?: string[];
        env?: Record<string, string>;
      };
      const haystack = `${name} ${entry.command ?? ""} ${(entry.args ?? []).join(" ")}`;
      if (!haystack.includes("telegram")) continue;
      entries.push({
        file,
        name,
        command: entry.command,
        hasCreds: Boolean(entry.env?.TELEGRAM_API_HASH || entry.env?.TELEGRAM_API_ID),
      });
    }
  }
  return entries;
}

/**
 * Aggregate diagnosis: accounts, supervision, stray processes, client
 * registration.
 *
 * The checks are chosen from failures that actually happened rather than
 * imagined ones: orphaned owners, an unsupervised daemon, credentials in the
 * client's config (which let a client become an owner) and a client launched
 * from a file inside the project (that exec is denied to a sandboxed caller —
 * EPERM on posix_spawn).
 */
export async function doctor(
  options: { config?: Config; mcpConfigs?: string[] } = {},
): Promise<DoctorReport> {
  const config = options.config ?? loadConfig();
  const findings: Finding[] = [];

  const accounts = await listStatuses({ config });
  const orphans = await listOrphans({ config });

  if (config.envError) {
    findings.push({
      severity: "warn",
      title: ".env exists but cannot be read",
      detail: config.envError,
      advice: `chmod 600 ${join(config.projectDir, ".env")} and check its owner`,
    });
  }

  if (!config.apiId || !config.apiHash) {
    findings.push({
      severity: "error",
      title: "No Telegram credentials",
      detail: `TELEGRAM_API_ID / TELEGRAM_API_HASH not found in ${join(config.projectDir, ".env")} or the environment`,
      advice: "cp .env.example .env and fill it in",
    });
  }

  if (accounts.length === 0) {
    findings.push({
      severity: "warn",
      title: "No accounts found",
      detail: `no session files under ${config.sessionBase}`,
      advice: `${BIN_NAME} login <account>`,
    });
  }

  // node runs TypeScript directly since 23.6; anything older cannot run the sources.
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  if (major < 23) {
    findings.push({
      severity: "error",
      title: `node ${process.versions.node} is too old`,
      detail: "sources are TypeScript executed directly, which needs node >= 23.6",
    });
  }

  try {
    packageCliPath(config);
  } catch (error) {
    findings.push({
      severity: "error",
      title: "Supervised package not found",
      detail: (error as Error).message,
      advice: "pnpm install",
    });
  }

  for (const status of accounts) {
    if (status.health === "orphaned") {
      findings.push({
        severity: "error",
        title: `${status.account}: orphaned owner`,
        detail: status.message,
        advice: status.advice,
      });
    }
  }

  if (orphans.unclaimed.length > 0) {
    findings.push({
      severity: "warn",
      title: `Stray package processes: ${orphans.unclaimed.length}`,
      detail: "not registered as the owner of any account",
      advice: `${BIN_NAME} orphans for the list; take them down by hand`,
    });
  }

  const configuredPaths = process.env[MCP_CONFIGS_ENV];
  const mcpFiles =
    options.mcpConfigs ??
    (configuredPaths ? configuredPaths.split(":") : defaultMcpConfigs());

  for (const entry of readMcpEntries(mcpFiles)) {
    if (entry.hasCreds) {
      findings.push({
        severity: "warn",
        title: `MCP "${entry.name}": credentials in the client config`,
        detail: `${entry.file} — with credentials the process can become the connection owner and leave a poisoned lock behind`,
        advice:
          "drop TELEGRAM_API_ID/HASH from the client env, keep only TELEGRAM_SESSION_PATH",
      });
    }
    if (entry.command?.startsWith(config.projectDir)) {
      findings.push({
        severity: "error",
        title: `MCP "${entry.name}": command inside the project`,
        detail: `${entry.command} — a session sandboxed to a different folder cannot execute it (EPERM on posix_spawn)`,
        advice: `use an interpreter from an allowed location, e.g. npx -y ${PACKAGE_NAME}@<version>`,
      });
    }
  }

  if (findings.length === 0) {
    findings.push({
      severity: "ok",
      title: "No problems found",
      detail: "accounts are served, no stray processes",
    });
  }

  return { accounts, orphans, findings };
}
