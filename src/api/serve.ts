import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { BIN_NAME, TERMINATE_TIMEOUT_MS, VERSION } from "../constants.ts";
import { resolveBind, type StartedHttp, startHttp } from "../http.ts";
import { loadUserConfig } from "../settings/load.ts";
import { TOKEN_ENV } from "../utils/auth.ts";
import { type Config, loadConfig, requireCreds } from "../utils/config.ts";
import { formatStartupBanner } from "../utils/format.ts";
import {
  beginRequestBox,
  cyan,
  dim,
  endRequestBox,
  green,
  isInteractive,
  logAbove,
  logEvent,
  red,
  write,
  writeError,
  yellow,
} from "../utils/logger.ts";
import {
  ensureAccountDir,
  logDir,
  logPath,
  nodeBin,
  ownCliPath,
  packageCliPath,
  sessionPath,
} from "../utils/paths.ts";
import { probePort } from "../utils/port.ts";
import { probeOwner } from "./probe-owner.ts";
import { reapStaleOwner } from "./reap-stale-owner.ts";

export interface ServeOptions {
  accounts?: string[];
  config?: Config;
  /** Also append every line to `<logBase>/<account>/serve.log`. Default true. */
  tee?: boolean;
  /** Skip the HTTP + MCP surface and only run the owners. */
  noHttp?: boolean;
  port?: number;
  host?: string;
  token?: string;
}

/** Distinct colours so two accounts are tellable apart in one stream. */
const PREFIX_COLORS = [cyan, green, yellow] as const;

interface Child {
  account: string;
  proc: ChildProcess;
}

/**
 * Run the connection owners in the foreground, one child process per account.
 *
 * This is the whole supervision model: no launchd, no plists, no background
 * magic. The owners are children of this process, their output is this
 * process's output, and Ctrl+C takes them down with it. What you started is
 * what is running, and closing the terminal ends it — which is exactly the
 * property a human wants while watching logs.
 *
 * The trade-off is explicit: nothing survives this process. If you want the
 * owners to outlive the terminal, leave the command running in a tmux pane.
 */
export async function serveAccounts(options: ServeOptions = {}): Promise<number> {
  const config = options.config ?? loadConfig();
  const tee = options.tee ?? true;
  const accounts = options.accounts?.length ? options.accounts : config.accounts;

  if (accounts.length === 0) {
    writeError(`${yellow("!")} no accounts found — ${BIN_NAME} login <account>`);
    return 1;
  }

  requireCreds(config);

  const children: Child[] = [];

  for (const [index, account] of accounts.entries()) {
    const color = PREFIX_COLORS[index % PREFIX_COLORS.length] ?? cyan;
    const tag = (text: string) => color(text.padEnd(14));

    const session = sessionPath(config, account);
    if (!existsSync(session)) {
      writeError(`${tag(account)} ${red("no session")} — ${BIN_NAME} login ${account}`);
      continue;
    }

    // An owner that is already serving must not get a second one on the same
    // MTProto session: that is the AUTH_KEY_DUPLICATED case.
    const owner = await probeOwner({ account, config });
    if (owner.state === "alive") {
      writeError(
        `${tag(account)} ${yellow("already owned")} by PID ${owner.pid ?? "?"} — skipping`,
      );
      continue;
    }
    if (owner.state === "unknown") {
      writeError(
        `${tag(account)} ${yellow("cannot check the socket")} (${owner.reason}) — skipping`,
      );
      continue;
    }
    // Verdict is `dead`: release a lock left by a previous owner, if any.
    const reaped = await reapStaleOwner({ account, config });
    if (reaped.terminatedPid !== undefined) {
      writeError(`${tag(account)} ${dim(reaped.reason)}`);
    }

    ensureAccountDir(config, account);
    mkdirSync(logDir(config, account), { recursive: true });

    const proc = spawn(nodeBin(), [packageCliPath(config), "serve"], {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: config.projectDir,
      env: {
        ...process.env,
        ...config.env,
        TELEGRAM_API_ID: config.apiId,
        TELEGRAM_API_HASH: config.apiHash,
        TELEGRAM_SESSION_PATH: session,
      },
    });

    // Tee to a file as well: the screen is the primary log, but after the
    // terminal closes the file is the only record of what happened.
    const sink = tee
      ? createWriteStream(logPath(config, account), { flags: "a" })
      : undefined;

    const pipe = (stream: NodeJS.ReadableStream | null) => {
      if (!stream) return;
      let buffer = "";
      stream.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        // Through logAbove, not write: once the request box is up, a raw
        // println from a child would land inside the frame and smear it.
        for (const line of lines) {
          logAbove(`${tag(account)} ${line}`);
          sink?.write(`${line}\n`);
        }
      });
    };
    pipe(proc.stdout);
    pipe(proc.stderr);

    proc.on("exit", (code, signal) => {
      sink?.end();
      const how = signal ? `signal ${signal}` : `code ${code}`;
      // logAbove, not writeError: an owner can die at any moment, including
      // while the request box owns the bottom of the screen.
      logAbove(`${tag(account)} ${dim(`owner exited (${how})`)}`);
    });

    children.push({ account, proc });
    writeError(`${tag(account)} ${green("owner started")} ${dim(`pid ${proc.pid}`)}`);
  }

  if (children.length === 0) {
    writeError(`${red("✗")} nothing to serve`);
    return 1;
  }

  writeError(
    dim(`  ── serving ${children.length} account(s); Ctrl+C stops everything ──`),
  );

  // The HTTP + MCP surface lives in this process, not in a daemon: it prints
  // its URL here and dies with Ctrl+C alongside the owners.
  let http: StartedHttp | undefined;
  let bannerTail = 0;
  if (!options.noHttp) {
    // Two servers cannot share a port, and walking forward behind our own twin
    // is worse than not starting: the URL in the banner would be one no client
    // is configured for. Say where the running surface is and keep the owners —
    // they are the half of this command that is not duplicated.
    const { port: requested, host } = resolveBind(options);
    const owner = await probePort(requested, host);
    if (owner === "ours") {
      writeError(
        `${yellow("!")} port ${requested} already serves ${BIN_NAME} — this run supervises only, no HTTP surface`,
      );
      writeError(dim(`  ── http://${host}:${requested} belongs to the other run ──`));
    } else {
      http = await startHttp({
        config,
        port: requested,
        host,
        token: options.token,
      });
      const url = `http://${http.host}:${http.port}`;
      if (isInteractive) {
        const banner = formatStartupBanner({
          version: VERSION,
          url,
          token: http.token,
          generated: http.generated,
          tokenEnv: TOKEN_ENV,
          stdio: { command: nodeBin(), args: [ownCliPath(config), "mcp"] },
          requestedPort: http.requestedPort,
          port: http.port,
        });
        write(banner.text);
        bannerTail = banner.configLines;
      } else {
        // No terminal: a log file wants events, not a repainting banner that
        // carries the token in a pasteable config.
        logStarted({ http, url, accounts: children.map((child) => child.account) });
      }
    }
  }

  // Requests now repaint into a box drawn over the pasteable config: that part
  // is read once, while live traffic is read for as long as the terminal stays
  // open. Owner logs scroll above it.
  //
  // Only stdout lines are counted — the note above went to stderr, which a
  // caller may have redirected away, and the cursor arithmetic has to hold
  // either way.
  beginRequestBox(bannerTail);

  return waitForShutdown(children, http?.server);
}

/**
 * The off-terminal face of the startup banner: one line saying what started,
 * where, and out of which config — then one more when a signal stops it.
 *
 * A supervisor run from a pane, a cron job or `nohup` is read afterwards, from
 * the file. Everything the banner is good at (repainting, a pasteable config
 * holding the token) is worthless there, and the token in a file is a liability.
 */
function logStarted(params: {
  http: StartedHttp;
  url: string;
  accounts: string[];
}): void {
  const { http, url, accounts } = params;
  const userConfig = loadUserConfig();
  logEvent(
    "started",
    `v${VERSION}`,
    `pid ${process.pid}`,
    url,
    `accounts ${accounts.join(", ")}`,
    http.port !== http.requestedPort ? yellow(`port ${http.requestedPort} was busy`) : "",
    http.generated ? `token generated (set ${TOKEN_ENV} to pin it)` : "token pinned",
    userConfig.loaded ? `config ${userConfig.path}` : "",
  );
}

/**
 * Resolve when every child is gone, whether on its own or because we were
 * signalled.
 *
 * SIGTERM is forwarded rather than letting the children die with us: the owner
 * has a gracefulExit handler on it that disconnects from Telegram, releases the
 * lock and removes the socket. Skipping it leaves the next run to clean up a
 * poisoned lock.
 */
function waitForShutdown(
  children: Child[],
  server?: import("node:http").Server,
): Promise<number> {
  return new Promise((resolve) => {
    let shuttingDown = false;
    let alive = children.length;

    const finish = () => {
      if (alive > 0) return;
      server?.close();
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      resolve(0);
    };

    for (const { proc } of children) {
      proc.on("exit", () => {
        alive -= 1;
        finish();
      });
    }

    function onSignal(signal?: NodeJS.Signals) {
      if (shuttingDown) return;
      shuttingDown = true;
      // Let go of the box first: shutdown lines are the last thing on screen
      // and must not be erased by a redraw that follows them.
      endRequestBox();
      // Off a terminal the pair of events is the whole record of this run, and
      // an unexplained end of log reads as a crash.
      if (!isInteractive) logEvent("stopped", signal ?? "signal");
      writeError("");
      writeError(dim("  ── stopping owners ──"));
      server?.close();
      for (const { proc } of children) {
        if (!proc.killed) proc.kill("SIGTERM");
      }
      // Anything still up after the graceful budget gets SIGKILL, so a wedged
      // owner cannot hold the terminal hostage.
      setTimeout(() => {
        for (const { proc } of children) {
          if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
        }
      }, TERMINATE_TIMEOUT_MS).unref();
    }

    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  });
}
