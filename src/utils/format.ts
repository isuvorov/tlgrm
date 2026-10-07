import { homedir } from "node:os";
import type { Severity } from "../api/doctor.ts";
import type { AccountHealth, AccountStatus } from "../api/get-status.ts";
import { BIN_NAME } from "../constants.ts";
import { bold, cyan, dim, green, magenta, red, yellow } from "./logger.ts";

export function tildify(path: string, home: string = homedir()): string {
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Colour per account verdict; `orphaned` is the one that must shout. */
export function colorHealth(health: AccountHealth, text: string): string {
  switch (health) {
    case "alive":
      return green(text);
    case "orphaned":
      return red(text);
    case "stale-lock":
    case "no-session":
    case "stopped":
      return yellow(text);
    default:
      return dim(text);
  }
}

export const SEVERITY_ICON: Record<Severity, string> = {
  ok: "✓",
  warn: "!",
  error: "✗",
};

export function colorSeverity(severity: Severity, text: string): string {
  switch (severity) {
    case "ok":
      return green(text);
    case "warn":
      return yellow(text);
    default:
      return red(text);
  }
}

/** `account: message` with the account in bold and the verdict coloured. */
export function formatAccountStatus(status: AccountStatus): string[] {
  const lines = [
    `  ${bold(status.account)}  ${colorHealth(status.health, status.message)}`,
  ];
  if (status.advice) lines.push(`      ${dim("→")} ${dim(status.advice)}`);
  return lines;
}

export interface StartupBanner {
  version: string;
  url: string;
  token: string;
  /** True when the token was generated for this run rather than configured. */
  generated: boolean;
  tokenEnv: string;
  /** Absolute command + args that register this server over stdio. */
  stdio: { command: string; args: string[] };
  /** Non-zero when the requested port was busy and we walked forward. */
  requestedPort?: number;
  port: number;
}

export function configBlock(label: string, config: unknown): string[] {
  const lines = [dim(`  ── ${label} ──`)];
  for (const line of JSON.stringify(config, null, 2).split("\n")) {
    lines.push(`  ${dim(line)}`);
  }
  lines.push("");
  return lines;
}

/**
 * The registration for clients that can send headers, which is the better of
 * the two HTTP forms: the token stays out of the URL, out of shell history and
 * out of every request log that records paths. `/mcp/auth/<token>` exists only
 * for the clients that cannot — browsers and ChatGPT connectors among them.
 */
export function headerAuthConfig(url: string, token: string): unknown {
  return {
    mcpServers: {
      [BIN_NAME]: {
        type: "http",
        url: `${url}/mcp`,
        headers: { Authorization: `Bearer ${token}` },
      },
    },
  };
}

export interface StartupBannerOutput {
  text: string;
  /**
   * How many trailing lines are copy-paste config rather than live state.
   *
   * The request box draws over exactly these: once traffic starts, a screenful
   * of JSON you already pasted is worth less than twelve request lines.
   */
  configLines: number;
}

/**
 * The startup header, in the shape awesome-things uses: name and version, an
 * arrow list of the few URLs that matter, then copy-pasteable MCP config.
 *
 * The config blocks are the point. The reason to read this header at all is to
 * paste a working registration out of it; making the user assemble one from a
 * URL and a token by hand is how the broken variants get created.
 */
export function formatStartupBanner(banner: StartupBanner): StartupBannerOutput {
  const arrow = green(bold("➜"));
  const pad = (s: string) => s.padEnd(10);
  const mcpUrl = `${banner.url}/mcp/auth/${banner.token}`;
  const lines: string[] = [""];

  lines.push(`  ${bold(green(BIN_NAME))} ${dim(`v${banner.version}`)}`);
  lines.push("");

  if (banner.requestedPort !== undefined && banner.requestedPort !== banner.port) {
    lines.push(
      `  ${yellow("⚠")}  Port ${banner.requestedPort} busy, using ${bold(String(banner.port))}`,
    );
    lines.push("");
  }

  lines.push(`  ${arrow}  ${pad("WEB:")}  ${cyan(banner.url)}`);
  lines.push(`  ${arrow}  ${pad("API:")}  ${magenta(`${banner.url}/api`)}`);
  lines.push(
    `  ${arrow}  ${pad("Token:")}  ${yellow(banner.token)}${
      banner.generated ? ` ${dim(`(generated; set ${banner.tokenEnv} to pin it)`)}` : ""
    }`,
  );
  lines.push(`  ${arrow}  ${pad("MCP:")}  ${cyan(mcpUrl)}`);
  lines.push("");

  const config = [
    // One HTTP block, the header form. Every client that can reach loopback can
    // also set a header, so the token has no business being in the URL here —
    // the `/mcp/auth/<token>` route stays for the ones that cannot (a browser,
    // a ChatGPT connector), and the MCP row above is exactly that URL.
    ...configBlock(
      "MCP config (Localhost MCP)",
      headerAuthConfig(banner.url, banner.token),
    ),
    ...configBlock("MCP config (CLI)", {
      mcpServers: { [BIN_NAME]: banner.stdio },
    }),
  ];
  lines.push(...config);

  return { text: lines.join("\n"), configLines: config.length };
}

/**
 * Closest known command by edit distance — so a typo gets a suggestion instead
 * of a wall of help text.
 */
export function suggestCommand(input: string, commands: string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const command of commands) {
    const distance = editDistance(input, command);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = command;
    }
  }
  // Beyond a third of the word the "suggestion" is noise.
  const limit = Math.max(1, Math.floor(Math.max(input.length, 1) / 3) + 1);
  return bestDistance <= limit ? best : undefined;
}

function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  let previous = Array.from({ length: cols }, (_, i) => i);

  for (let i = 1; i < rows; i += 1) {
    const current = [i];
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
    }
    previous = current;
  }
  return previous[cols - 1] ?? 0;
}
