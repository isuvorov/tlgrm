#!/usr/bin/env node
import "./settings/autoload.ts";
import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { daemonStart, daemonStatus, daemonStop, daemonUp } from "./api/daemon.ts";
import { doctor } from "./api/doctor.ts";
import { getStatus } from "./api/get-status.ts";
import { listOrphans } from "./api/list-orphans.ts";
import { login } from "./api/login.ts";
import { serveAccounts } from "./api/serve.ts";
import { startDaemon } from "./api/start-daemon.ts";
import { stopDaemon } from "./api/stop-daemon.ts";
import { tailLogs } from "./api/tail-logs.ts";
import { BIN_NAME, PACKAGE_NAME, VERSION } from "./constants.ts";
import { loadUserConfig, saveUserConfig } from "./settings/load.ts";
import { type Config, loadConfig } from "./utils/config.ts";
import {
  colorSeverity,
  configBlock,
  formatAccountStatus,
  SEVERITY_ICON,
  suggestCommand,
} from "./utils/format.ts";
import {
  blue,
  bold,
  cyan,
  dim,
  green,
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
  const [command = "", ...rest] = argv;
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

// Same layout as awesome-things (yargs): usage, main and other commands,
// options with their type, then a copy-pasteable MCP registration.
const HELP_COMMANDS: [string, string][] = [
  ["info", "Show package, installation and environment info"],
  ["mcp", "Start MCP server (stdio transport)"],
  [
    "server [account ...]",
    "Start owners and the HTTP API server with MCP-over-HTTP  [aliases: serve]",
  ],
  ["logs [account ...]", "Show the owner logs (tail of the log files)"],
  ["daemon", "Run the HTTP server in the background (launchd, macOS)"],
  ["start [account ...]", "Run an owner in the background"],
  ["stop [account ...]", "Stop a background owner"],
];

const HELP_OTHER_COMMANDS: [string, string][] = [
  ["status [account ...]", "Show who owns the connection"],
  ["doctor", "Diagnose the setup and say how to fix it"],
  ["orphans", "List package processes in the system"],
  ["login <account>", "QR login into the account's session"],
  ["config save", "Write the current environment (.env included) into the config file"],
];

const HELP_OPTIONS: [string, string, string][] = [
  ["    --json", "Output as JSON", "[boolean] [default: false]"],
  ["-n, --lines", "Log lines to show", "[number]"],
  ["    --port", "HTTP port", "[number] [default: 7717]"],
  ["    --host", "Bind address", '[string] [default: "127.0.0.1"]'],
  ["    --token", "Pin the bearer token", "[string]"],
  ["    --no-http", "Owners only, no port", "[boolean]"],
  ["    --no-color", "Disable colours", "[boolean]"],
  ["-h, --help", "Show help", "[boolean]"],
  ["-v, --version", "Show version number", "[boolean]"],
];

export function formatHelp(): string {
  const width = 80;
  // Word-wrap to the column, the way yargs does: continuation lines start
  // under the description, not at the left edge.
  const wrap = (text: string, room: number): string[] => {
    const lines: string[] = [];
    let line = "";
    for (const word of text.split(" ")) {
      if (line && line.length + 1 + word.length > room) {
        lines.push(line);
        line = word;
      } else line = line ? `${line} ${word}` : word;
    }
    lines.push(line);
    return lines;
  };
  const alignRight = (tag: string) => `${" ".repeat(width - tag.length)}${tag}`;

  const commands = (rows: [string, string][]) => {
    const pad = Math.max(
      ...[...HELP_COMMANDS, ...HELP_OTHER_COMMANDS].map(([c]) => c.length),
    );
    const indent = 2 + BIN_NAME.length + 1 + pad + 2;
    const out: string[] = [];
    rows.forEach(([command, text], i) => {
      const [desc = "", alias] = text.split("  ");
      const body = wrap(desc, width - indent);
      const gap = " ".repeat(pad - command.length);
      out.push(`  ${green(BIN_NAME)} ${cyan(command)}${gap}  ${body[0]}`);
      for (const more of body.slice(1)) out.push(`${" ".repeat(indent)}${more}`);
      if (alias) out.push(alignRight(alias));
      // yargs separates a multi-line entry from the next one.
      if ((body.length > 1 || alias) && i < rows.length - 1) out.push("");
    });
    return out;
  };

  const optionPad = Math.max(...HELP_OPTIONS.map(([flag]) => flag.length));
  const options = HELP_OPTIONS.flatMap(([flag, desc, tag]) => {
    const left = `  ${flag.padEnd(optionPad)}  ${desc}`;
    if (left.length + 1 + tag.length <= width) {
      return [`${left}${" ".repeat(width - left.length - tag.length)}${tag}`];
    }
    return [left, alignRight(tag)];
  });

  return [
    `${BIN_NAME} <command> [options]`,
    "",
    yellow("Commands:"),
    ...commands(HELP_COMMANDS),
    "",
    yellow("Other commands:"),
    ...commands(HELP_OTHER_COMMANDS),
    "",
    yellow("Options:"),
    ...options,
    "",
    ...configBlock("MCP config (CLI)", {
      mcpServers: { [BIN_NAME]: { command: `npx -y ${BIN_NAME} mcp` } },
    }),
  ].join("\n");
}

const COMMANDS = [
  "server",
  "daemon",
  "config",
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

/** `tail -F` until Ctrl+C: -F survives the log being created or rotated. */
function followLog(path: string, lines: number): Promise<number> {
  return new Promise((resolve) => {
    const tail = spawn("tail", ["-n", String(lines), "-F", path], { stdio: "inherit" });
    process.once("SIGINT", () => {
      tail.kill("SIGTERM");
      resolve(0);
    });
    tail.on("exit", () => resolve(0));
  });
}

export async function run(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  // --json must never be polluted by escape codes, and --no-color is explicit.
  if (args.noColor || args.json) setColor(false);

  if (args.version || args.command === "--version" || args.command === "-v") {
    console.log(`${BIN_NAME} ${VERSION}`);
    return 0;
  }

  if (args.command === "help" || argv.includes("--help") || argv.includes("-h")) {
    console.log(formatHelp());
    return 0;
  }

  if (args.command === "") {
    console.error(formatHelp());
    console.error(red("Please specify a command"));
    return 1;
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
    case "server":
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

    case "daemon": {
      const sub = args.accounts[0] ?? "status";
      const actions = { start: daemonStart, up: daemonUp, stop: daemonStop };
      if (sub === "status") {
        const status = daemonStatus({ config });
        if (args.json) out(status);
        else {
          const state = status.running
            ? green(`running (PID ${status.pid})`)
            : status.loaded
              ? yellow("loaded, not running")
              : dim("not running");
          write(`${bold("daemon")}  ${state}`);
          write(dim(`  plist  ${status.plist}${status.installed ? "" : " (absent)"}`));
          write(dim(`  log    ${status.log}`));
        }
        return 0;
      }
      if (!(sub in actions)) {
        writeError(`${red("✗")} Unknown daemon command: ${bold(sub)}`);
        writeError(dim(`  ${BIN_NAME} daemon <start|up|stop|status>`));
        return 1;
      }
      const r = actions[sub as keyof typeof actions]({ config });
      if (args.json) out(r);
      else {
        const pid = r.pid ? dim(` (PID ${r.pid})`) : "";
        write(`${bold("daemon")}  ${r.ok ? r.message : red(r.message)}${pid}`);
        if (sub !== "stop") {
          write(dim(`  plist  ${r.plist}`));
          write(dim(`  log    ${r.log}`));
          if (r.tokenWarning) write(`${yellow("!")} ${r.tokenWarning}`);
        }
      }
      if (!r.ok || sub !== "up" || args.json) return r.ok ? 0 : 1;
      // `up` stays attached to the log, like `docker compose up`. Ctrl+C only
      // detaches: the daemon belongs to launchd and keeps running.
      write(dim(`── ${r.log}  (Ctrl+C detaches, the daemon keeps running)`));
      return followLog(r.log, args.lines ?? 40);
    }

    case "config": {
      const sub = args.accounts[0];
      if (sub !== "save") {
        writeError(`${red("✗")} Unknown config command: ${bold(sub ?? "(none)")}`);
        writeError(dim(`  ${BIN_NAME} config save`));
        return 1;
      }
      // .env first, the real environment on top — the same precedence the
      // tool itself applies when it reads them.
      const saved = saveUserConfig({ ...config.env, ...process.env });
      if (args.json) out(saved);
      else {
        write(`${green("✓")} ${saved.path}`);
        write(
          dim(
            `  ${saved.keys.length > 0 ? saved.keys.join(", ") : "nothing set in the environment"}`,
          ),
        );
      }
      return 0;
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
      if (args.json) {
        out(info);
        return 0;
      }
      // Same layout as awesome-things `info`: one `ℹ <bin> [Key] value` row each.
      const pkg = JSON.parse(
        readFileSync(join(dirname(info.cli), "..", "package.json"), "utf-8"),
      ) as {
        description?: string;
      };
      const rows: [string, string][] = [
        ["Name", BIN_NAME],
        ["Version", VERSION],
        ["Description", pkg.description ?? ""],
        ["CWD", process.cwd()],
        ["Bin", info.cli],
        [
          "Source",
          info.cli.includes("/node_modules/")
            ? "npm (installed package)"
            : "source (local checkout)",
        ],
        ["Platform", `${process.platform} ${process.arch}`],
        ["Runtime", `node v${process.versions.node}`],
        ["Node", process.version],
        ["Config", info.config],
        ["SessionBase", config.sessionBase],
        ["LogBase", config.logBase],
        ["Accounts", config.accounts.join(",") || "none"],
      ];
      for (const [key, value] of rows) {
        write(` ${blue("ℹ")} ${dim(BIN_NAME)} ${`[${key}]`.padEnd(16)} ${value}`);
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
