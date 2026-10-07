import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { BIN_NAME, VERSION } from "../constants.ts";
import { TOKEN_ENV } from "../utils/auth.ts";
import { type Config, loadConfig } from "../utils/config.ts";
import { nodeBin, ownCliPath } from "../utils/paths.ts";

/**
 * `tlgrm daemon` — `tlgrm server` as a launchd LaunchAgent, the way
 * awesome-things runs its HTTP server in the background.
 *
 * launchd, not a detached child: it starts the server at login and restarts it
 * after a crash, which is the whole point of a background owner. `start` and
 * `stop` without `daemon` stay what they were — one owner per account,
 * detached, gone after a reboot.
 */

export const DAEMON_LABEL = `com.${BIN_NAME}.server`;

export function daemonPlistPath(home: string = homedir()): string {
  return join(home, "Library", "LaunchAgents", `${DAEMON_LABEL}.plist`);
}

/** stdout and stderr of the launchd job; per-account owner logs stay where they were. */
export function daemonLogPath(config: Config): string {
  return join(config.logBase, "daemon.log");
}

/**
 * A minimal app bundle the job runs from. Without it macOS names the login item
 * and the "can run in the background" notification after the executable —
 * `node` — with a generic icon. The bundle gives it the tool's name and icon;
 * `AssociatedBundleIdentifiers` in the plist ties the job to it.
 */
export function daemonBundlePath(home: string = homedir()): string {
  return join(home, "Library", "Application Support", BIN_NAME, `${BIN_NAME}.app`);
}

export function renderBundleInfoPlist(): string {
  const entries: [string, string][] = [
    ["CFBundleIdentifier", DAEMON_LABEL],
    ["CFBundleName", BIN_NAME],
    ["CFBundleDisplayName", BIN_NAME],
    ["CFBundleExecutable", BIN_NAME],
    ["CFBundleIconFile", BIN_NAME],
    ["CFBundlePackageType", "APPL"],
    ["CFBundleShortVersionString", VERSION],
    ["CFBundleVersion", VERSION],
  ];
  const body = entries
    .map(([k, v]) => `  <key>${k}</key>\n  <string>${escapeXml(v)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${body}
  <key>LSUIElement</key>
  <true/>
  <key>LSBackgroundOnly</key>
  <true/>
</dict>
</plist>
`;
}

/** The bundle's executable: hands over to node running `server`, same PID. */
export function renderBundleLauncher(node: string, cli: string): string {
  const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  return `#!/bin/sh\nexec ${quote(node)} ${quote(cli)} server\n`;
}

const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

/** Finder's "custom icon" (Get Info → paste), via AppKit from JXA. */
function setFileIcon(icns: string, target: string): void {
  const script = `ObjC.import("AppKit");
$.NSWorkspace.sharedWorkspace.setIconForFileOptions(
  $.NSImage.alloc.initWithContentsOfFile(${JSON.stringify(icns)}),
  ${JSON.stringify(target)},
  0,
);`;
  try {
    execFileSync("osascript", ["-l", "JavaScript", "-e", script], { stdio: "ignore" });
  } catch {
    // Cosmetic only: the job runs either way.
  }
}

export function writeBundle(): string {
  const app = daemonBundlePath();
  const contents = join(app, "Contents");
  mkdirSync(join(contents, "MacOS"), { recursive: true });
  mkdirSync(join(contents, "Resources"), { recursive: true });
  writeFileSync(join(contents, "Info.plist"), renderBundleInfoPlist());
  const launcher = join(contents, "MacOS", BIN_NAME);
  writeFileSync(launcher, renderBundleLauncher(nodeBin(), ownCliPath()));
  chmodSync(launcher, 0o755);
  // lib/cli.js or src/cli.ts -> package root -> assets/
  const icon = join(dirname(ownCliPath()), "..", "assets", `${BIN_NAME}.icns`);
  if (existsSync(icon)) {
    copyFileSync(icon, join(contents, "Resources", `${BIN_NAME}.icns`));
    // Login Items draws the icon of the executable it runs, not of the bundle
    // around it — an unsigned bundle is not matched by its id. A custom Finder
    // icon on the launcher itself is what replaces the generic "exec" one.
    setFileIcon(icon, launcher);
    setFileIcon(icon, app);
  }
  // Register it, so the bundle id in the plist resolves to a name and an icon.
  try {
    execFileSync(LSREGISTER, ["-f", app], { stdio: "ignore" });
  } catch {
    // Cosmetic only: the job runs either way.
  }
  return launcher;
}

export interface DaemonPlistOptions {
  program: string[];
  workingDirectory: string;
  logPath: string;
  env: Record<string, string>;
}

const escapeXml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function renderDaemonPlist(options: DaemonPlistOptions): string {
  const string = (s: string) => `<string>${escapeXml(s)}</string>`;
  const args = options.program.map((a) => `    ${string(a)}`).join("\n");
  const env = Object.entries(options.env)
    .map(([k, v]) => `    <key>${escapeXml(k)}</key>\n    ${string(v)}`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  ${string(DAEMON_LABEL)}
  <key>AssociatedBundleIdentifiers</key>
  <array>
    ${string(DAEMON_LABEL)}
  </array>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key>
  ${string(options.workingDirectory)}
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  ${string(options.logPath)}
  <key>StandardErrorPath</key>
  ${string(options.logPath)}
</dict>
</plist>
`;
}

const domain = () => `gui/${process.getuid?.() ?? 501}`;
const service = () => `${domain()}/${DAEMON_LABEL}`;

function launchctl(args: string[]): { ok: boolean; output: string } {
  try {
    const output = execFileSync("launchctl", args, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, output };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; message: string };
    return { ok: false, output: `${e.stdout ?? ""}${e.stderr ?? e.message}`.trim() };
  }
}

const sleep = (ms: number) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * `bootout` returns before the service is gone; a `bootstrap` right after it
 * fails with "5: Input/output error". Poll until launchd forgets the label.
 */
function bootoutAndWait(): { ok: boolean; output: string } {
  const out = launchctl(["bootout", service()]);
  for (let i = 0; i < 50; i += 1) {
    if (!launchctl(["print", service()]).ok) return { ok: true, output: out.output };
    sleep(200);
  }
  return { ok: false, output: out.output || "the service did not unload within 10s" };
}

export interface DaemonStatus {
  label: string;
  plist: string;
  log: string;
  installed: boolean;
  loaded: boolean;
  running: boolean;
  pid?: number;
}

export interface DaemonOptions {
  config?: Config;
}

export function daemonStatus(options: DaemonOptions = {}): DaemonStatus {
  const config = options.config ?? loadConfig();
  const plist = daemonPlistPath();
  const printed = launchctl(["print", service()]);
  const pid = printed.ok ? /^\s*pid = (\d+)/m.exec(printed.output)?.[1] : undefined;
  return {
    label: DAEMON_LABEL,
    plist,
    log: daemonLogPath(config),
    installed: existsSync(plist),
    loaded: printed.ok,
    running: printed.ok && /^\s*state = running/m.test(printed.output),
    ...(pid ? { pid: Number(pid) } : {}),
  };
}

export interface DaemonResult extends DaemonStatus {
  ok: boolean;
  message: string;
  /** No pinned token: every restart generates a new one and drops MCP clients. */
  tokenWarning?: string;
}

function writePlist(config: Config): string {
  const plist = daemonPlistPath();
  const log = daemonLogPath(config);
  mkdirSync(dirname(plist), { recursive: true });
  mkdirSync(dirname(log), { recursive: true });
  const node = nodeBin();
  const launcher = writeBundle();
  writeFileSync(
    plist,
    renderDaemonPlist({
      program: [launcher],
      workingDirectory: config.projectDir,
      logPath: log,
      env: {
        // launchd starts jobs with a bare PATH; the owner spawns node and ps.
        PATH: [
          dirname(node),
          "/opt/homebrew/bin",
          "/usr/local/bin",
          "/usr/bin",
          "/bin",
          "/usr/sbin",
          "/sbin",
        ].join(":"),
        HOME: homedir(),
        // stdout is daemon.log, not a TTY — keep the colour anyway: the log is
        // read back in a terminal by `daemon up` and `logs`.
        FORCE_COLOR: "1",
      },
    }),
  );
  return plist;
}

function tokenWarning(config: Config): string | undefined {
  if (process.env[TOKEN_ENV] || config.env[TOKEN_ENV]) return undefined;
  return `token is not pinned: every daemon restart generates a new one — set "token" in ~/.config/${BIN_NAME}/config.json`;
}

function result(config: Config, ok: boolean, message: string): DaemonResult {
  const warning = tokenWarning(config);
  return {
    ...daemonStatus({ config }),
    ok,
    message,
    ...(warning ? { tokenWarning: warning } : {}),
  };
}

function bootstrap(config: Config): DaemonResult {
  const plist = writePlist(config);
  let loaded = launchctl(["bootstrap", domain(), plist]);
  // Error 5 is also what a still-unloading previous instance looks like.
  for (let i = 0; !loaded.ok && i < 5; i += 1) {
    sleep(500);
    loaded = launchctl(["bootstrap", domain(), plist]);
  }
  if (!loaded.ok)
    return result(config, false, `launchctl bootstrap failed: ${loaded.output}`);
  return result(config, true, "started");
}

/** Install the LaunchAgent and start it; a running daemon is left alone. */
export function daemonStart(options: DaemonOptions = {}): DaemonResult {
  const config = options.config ?? loadConfig();
  const status = daemonStatus({ config });
  if (status.loaded) {
    return result(
      config,
      true,
      `already running${status.pid ? ` (PID ${status.pid})` : ""}`,
    );
  }
  return bootstrap(config);
}

/**
 * Start or restart: the plist is rewritten every time, so `up` after an update
 * or a `link` picks up the new node and CLI paths.
 */
export function daemonUp(options: DaemonOptions = {}): DaemonResult {
  const config = options.config ?? loadConfig();
  if (daemonStatus({ config }).loaded) {
    const out = bootoutAndWait();
    if (!out.ok) return result(config, false, `launchctl bootout failed: ${out.output}`);
  }
  const started = bootstrap(config);
  return started.ok ? { ...started, message: "restarted" } : started;
}

/** Stop the job and remove the LaunchAgent, so it does not come back at login. */
export function daemonStop(options: DaemonOptions = {}): DaemonResult {
  const config = options.config ?? loadConfig();
  const status = daemonStatus({ config });
  if (status.loaded) {
    const out = bootoutAndWait();
    if (!out.ok) return result(config, false, `launchctl bootout failed: ${out.output}`);
  }
  rmSync(status.plist, { force: true });
  rmSync(daemonBundlePath(), { recursive: true, force: true });
  return result(config, true, status.loaded ? "stopped" : "not running");
}
