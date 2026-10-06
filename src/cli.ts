#!/usr/bin/env node
import "./settings/autoload.ts";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { doctor } from "./api/doctor.ts";
import { getStatus } from "./api/get-status.ts";
import { listOrphans } from "./api/list-orphans.ts";
import { login } from "./api/login.ts";
import { serveAccounts } from "./api/serve.ts";
import { startDaemon } from "./api/start-daemon.ts";
import { stopDaemon } from "./api/stop-daemon.ts";
import { tailLogs } from "./api/tail-logs.ts";
import { BIN_NAME, PACKAGE_NAME, VERSION } from "./constants.ts";
import { loadUserConfig } from "./settings/load.ts";
import { ACCOUNTS_ENV, type Config, loadConfig } from "./utils/config.ts";
import {
  colorSeverity,
  formatAccountStatus,
  SEVERITY_ICON,
  suggestCommand,
} from "./utils/format.ts";
import {
  bold,
  cyan,
  dim,
  red,
  setColor,
  write,
  writeError,
  yellow,
} from "./utils/logger.ts";
import { packageCliPath } from "./utils/paths.ts";

/**
 * Argument parsing by hand.
 *
 * yargs cannot be installed here — the npm registry is unreachable from this
 * machine's sandbox — and the surface is small: a command, account names and
 * four flags.
 */
export interface Args {
  command: string;
  accounts: string[];
  json: boolean;
  lines?: number;
  noColor: boolean;
  version: boolean;
  port?: number;
  host?: string;
  token?: string;
  noHttp: boolean;
  /**
   * Flags we did not recognise.
   *
   * Collected rather than ignored: silently swallowing `--josn` meant a typo
   * ran the command as if nothing had been passed, which is worse than failing.
   */
  unknown: string[];
}

export function parseArgs(argv: string[]): Args {
  const [command = "status", ...rest] = argv;
  const args: Args = {
    command,
    accounts: [],
    json: false,
    noColor: false,
    version: false,
    noHttp: false,
    unknown: [],
  };

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] as string;
    const [flag, inline] = arg.includes("=")
      ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]
      : [arg, undefined];

    switch (flag) {
      case "--json":
        args.json = true;
        break;
      case "--lines":
      case "-n": {
        const raw = inline ?? rest[i + 1];
        const value = Number.parseInt(raw ?? "", 10);
        if (Number.isInteger(value) && value > 0) {
          args.lines = value;
          if (inline === undefined) i += 1;
        }
        break;
      }
      case "--port": {
        const raw = inline ?? rest[i + 1];
        const value = Number.parseInt(raw ?? "", 10);
        if (Number.isInteger(value) && value > 0) {
          args.port = value;
          if (inline === undefined) i += 1;
        }
        break;
      }
      case "--host":
      case "--token": {
        const raw = inline ?? rest[i + 1];
        if (raw && !raw.startsWith("-")) {
          if (flag === "--host") args.host = raw;
          else args.token = raw;
          if (inline === undefined) i += 1;
        }
        break;
      }
      case "--no-http":
        args.noHttp = true;
        break;
      case "--no-color":
      case "--plain":
        args.noColor = true;
        break;
      case "--version":
      case "-v":
        args.version = true;
        break;
      default:
        if (arg.startsWith("-")) args.unknown.push(arg);
        else args.accounts.push(arg);
    }
  }

  return args;
}

function targets(args: Args, config: Config): string[] {
  return args.accounts.length > 0 ? args.accounts : config.accounts;
}

const HELP = `${BIN_NAME} — keeps the Telegram connection owner alive

  ${BIN_NAME} serve [account ...]       owners + HTTP/MCP in the foreground (Ctrl+C stops all)
  ${BIN_NAME} status [account ...]      who owns the connection
  ${BIN_NAME} doctor                    aggregate diagnosis and how to fix it
  ${BIN_NAME} logs [account ...] -n 40  tail an owner log
  ${BIN_NAME} orphans                   package processes in the system
  ${BIN_NAME} login <account>           QR login into the account's session
  ${BIN_NAME} mcp                       MCP server on stdio
  ${BIN_NAME} info                      versions and discovered accounts

  ${BIN_NAME} start|stop [account ...]  start or stop an owner in the background

Flags: --json  machine-readable        --lines N, -n N  log lines
       --port N  HTTP port             --token T  pin the bearer token
       --host H  bind address          --no-http  owners only, no port
       --no-color                      --version

With no account, a command applies to every account found in the session base
(override with ${ACCOUNTS_ENV}).`;

const COMMANDS = [
  "serve",
  "status",
  "doctor",
  "logs",
  "orphans",
  "login",
  "mcp",
  "info",
  "start",
  "stop",
  "help",
];

export async function run(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  // --json must never be polluted by escape codes, and --no-color is explicit.
  if (args.noColor || args.json) setColor(false);

  if (args.version || args.command === "--version" || args.command === "-v") {
    console.log(`${BIN_NAME} ${VERSION}`);
    return 0;
  }

  if (args.command === "help" || args.command === "--help" || args.command === "-h") {
    console.log(HELP);
    return 0;
  }

  // An unrecognised flag is an error, not something to shrug off.
  if (args.unknown.length > 0) {
    writeError(
      `${red("✗")} Unknown ${args.unknown.length > 1 ? "flags" : "flag"}: ${args.unknown.join(", ")}`,
    );
    writeError(dim(`  ${BIN_NAME} help  lists every flag`));
    return 1;
  }

  const config = loadConfig();
  const out = (value: unknown) => console.log(JSON.stringify(value, null, 2));

  switch (args.command) {
    case "serve":
      return serveAccounts({
        accounts: args.accounts,
        config,
        noHttp: args.noHttp,
        port: args.port,
        host: args.host,
        token: args.token,
      });

    case "status": {
      const statuses = await Promise.all(
        targets(args, config).map((account) => getStatus({ account, config })),
      );
      if (args.json) {
        out(statuses);
      } else if (statuses.length === 0) {
        write(
          `${yellow("!")} no accounts found — ${cyan(`${BIN_NAME} login <account>`)}`,
        );
      } else {
        write("");
        for (const s of statuses) for (const line of formatAccountStatus(s)) write(line);
        write("");
      }
      return statuses.some((s) => s.health === "orphaned") ? 1 : 0;
    }

    case "doctor": {
      const report = await doctor({ config });
      if (args.json) {
        out(report);
        return report.findings.some((f) => f.severity === "error") ? 1 : 0;
      }
      write("");
      for (const s of report.accounts)
        for (const line of formatAccountStatus(s)) write(line);
      write("");
      for (const f of report.findings) {
        write(
          `  ${colorSeverity(f.severity, SEVERITY_ICON[f.severity])} ${bold(f.title)}`,
        );
        write(`      ${dim(f.detail)}`);
        if (f.advice) write(`      ${dim("→")} ${cyan(f.advice)}`);
      }
      write("");
      return report.findings.some((f) => f.severity === "error") ? 1 : 0;
    }

    case "start": {
      const results = await Promise.all(
        targets(args, config).map((account) => startDaemon({ account, config })),
      );
      if (args.json) out(results);
      else for (const r of results) write(`${bold(r.account)}  ${r.message}`);
      return results.every(
        (r) => r.outcome === "started" || r.outcome === "already-owned",
      )
        ? 0
        : 1;
    }

    case "stop": {
      const results = await Promise.all(
        targets(args, config).map((account) => stopDaemon({ account, config })),
      );
      if (args.json) out(results);
      else for (const r of results) write(`${bold(r.account)}  ${r.message}`);
      return results.every((r) => r.stopped) ? 0 : 1;
    }

    case "logs": {
      const tails = await Promise.all(
        targets(args, config).map((account) =>
          tailLogs({ account, lines: args.lines, config }),
        ),
      );
      if (args.json) {
        out(tails);
      } else {
        for (const t of tails) {
          write(dim(`── ${t.account}: ${t.path}`));
          write(t.exists ? t.lines.join("\n") : dim("(no log)"));
        }
      }
      return 0;
    }

    case "orphans": {
      const report = await listOrphans({ config });
      if (args.json) {
        out(report);
        return 0;
      }
      write(dim("── package processes in the system"));
      if (report.processes.length === 0) write(dim("(none)"));
      for (const p of report.processes) {
        const tag = p.ownerOf ? cyan(`owner of ${p.ownerOf}`) : yellow("stray");
        write(`  ${p.pid}  ${dim(`ppid ${p.ppid}, ${p.started}`)}  ${tag}`);
      }
      write("");
      write(dim("── lock files"));
      for (const [account, pid] of Object.entries(report.owners)) {
        write(`  ${bold(account)}  ${pid ?? dim("lock empty")}`);
      }
      if (report.unclaimed.length > 0) {
        write("");
        write(
          `${yellow("!")} ${report.unclaimed.length} stray — a live owner can appear here too, so check before killing:`,
        );
        write(`  kill ${report.unclaimed.map((p) => p.pid).join(" ")}`);
      }
      return 0;
    }

    case "login": {
      const account = args.accounts[0];
      if (!account) {
        writeError(`${red("✗")} Name an account: ${BIN_NAME} login <account>`);
        return 1;
      }
      const result = await login({ account, config });
      if (args.json) out(result);
      else write(`${bold(result.account)}  ${result.message}`);
      return result.ok ? 0 : 1;
    }

    case "mcp": {
      // Awaited, not fire-and-forget: the promise settles only when the
      // transport closes, so the process stays alive to answer requests.
      const { serveStdio } = await import("./mcp.ts");
      return serveStdio({ config });
    }

    case "info": {
      let supervised: string;
      try {
        supervised = packageCliPath(config);
      } catch {
        supervised = "not installed";
      }
      // The config path is here whether or not the file exists: "where would it
      // be read from" is the question a user has when a setting is ignored.
      const userConfig = loadUserConfig();
      const info = {
        name: BIN_NAME,
        version: VERSION,
        node: process.versions.node,
        cli: fileURLToPath(import.meta.url),
        supervises: PACKAGE_NAME,
        supervisedCli: supervised,
        config: `${userConfig.path}${userConfig.loaded ? "" : " (absent)"}`,
        sessionBase: config.sessionBase,
        logBase: config.logBase,
        accounts: config.accounts,
      };
      if (args.json) out(info);
      else
        for (const [key, value] of Object.entries(info)) {
          write(`${dim(`${key}:`.padEnd(16))} ${value}`);
        }
      return 0;
    }

    default: {
      const guess = suggestCommand(args.command, COMMANDS);
      writeError(`${red("✗")} Unknown command: ${bold(args.command)}`);
      if (guess) {
        writeError(`  ${dim("did you mean")} ${cyan(`${BIN_NAME} ${guess}`)}${dim("?")}`);
      }
      writeError(dim(`  ${BIN_NAME} help  lists every command`));
      return 1;
    }
  }
}

/**
 * Run as a CLI only when this file is the process entry point, so importing it
 * from tests (or from api.ts) does not execute main.
 */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  run(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      writeError(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
