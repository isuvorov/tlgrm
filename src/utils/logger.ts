/**
 * ANSI helpers and the request log box for the CLI output.
 *
 * Hand-rolled rather than chalk/picocolors: the npm registry is unreachable from
 * this machine's sandbox, and the whole need here is nine escape codes.
 */

import { formatError } from "./errors.ts";

// The request box repaints itself with cursor moves — only usable on a real TTY.
const isTty = Boolean(process.stdout.isTTY) && process.env.TERM !== "dumb";

/** True when stdout is a terminal: spinners and cursor tricks are safe. */
export const isInteractive = isTty;

/**
 * Colour is a separate question from "is this a TTY". `serve` tees every line
 * into `<logBase>/<account>/serve.log` — no TTY there, so no cursor tricks — but
 * that file is read back through `logs` in a terminal, where ANSI is exactly
 * what you want. `FORCE_COLOR` turns it on, `NO_COLOR` always wins.
 */
export const useColor = process.env.NO_COLOR
  ? false
  : process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== "0"
    ? true
    : isTty;

let colorEnabled = useColor;

/** `--no-color` and tests flip this; everything below honours it immediately. */
export function setColor(enabled: boolean): void {
  colorEnabled = enabled;
}

export function colorIsEnabled(): boolean {
  return colorEnabled;
}

const wrap = (open: string, close: string) => (s: string) =>
  colorEnabled ? `${open}${s}${close}` : s;

export const bold = wrap("\x1b[1m", "\x1b[22m");
export const dim = wrap("\x1b[2m", "\x1b[22m");
export const red = wrap("\x1b[31m", "\x1b[39m");
export const green = wrap("\x1b[32m", "\x1b[39m");
export const yellow = wrap("\x1b[33m", "\x1b[39m");
export const blue = wrap("\x1b[34m", "\x1b[39m");
export const magenta = wrap("\x1b[35m", "\x1b[39m");
export const cyan = wrap("\x1b[36m", "\x1b[39m");
export const gray = wrap("\x1b[90m", "\x1b[39m");

export function stripAnsi(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape codes
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Visible width, ignoring escape codes — needed to pad coloured columns. */
export function visibleLength(s: string): number {
  return stripAnsi(s).length;
}

/** Pad to `width` counting only visible characters. */
export function padVisible(s: string, width: number): string {
  return s + " ".repeat(Math.max(0, width - visibleLength(s)));
}

export function colorStatus(status: number): string {
  if (status < 300) return green(String(status));
  if (status < 400) return cyan(String(status));
  if (status < 500) return yellow(String(status));
  return red(String(status));
}

export function colorMethod(method: string): string {
  switch (method) {
    case "GET":
      return green(method);
    case "POST":
      return cyan(method);
    case "PUT":
      return yellow(method);
    case "PATCH":
      return magenta(method);
    case "DELETE":
      return red(method);
    case "OPTIONS":
      return dim(method);
    default:
      return method;
  }
}

/**
 * A log line must never carry the bearer token.
 *
 * The MCP transport puts the token in the path (`/mcp/auth/<token>`), so an
 * unmasked request log would print a working credential into a file.
 */
export function maskSecrets(text: string): string {
  return text
    .replace(/([?&](?:token|authtoken|api_?key)=)[^&\s]+/gi, "$1…")
    .replace(/(\/auth\/)[^/\s?]+/gi, "$1…");
}

// ── Request log box ─────────────────────────────────────────────
const BOX_ROWS = 12;
const MIN_INNER_W = 64;
const MAX_INNER_W = 140;
// fixed parts: time(8) + sp + method(7) + sp + sp + status(3) + sp*2 + dur(~6)
const FIXED_COLS = 29;

/** What a request carries beyond method/path/status — mostly MCP detail. */
export interface LogExtra {
  search?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolError?: string;
}

export interface RequestLineOptions extends LogExtra {
  method: string;
  pathname: string;
  status: number;
  durationMs: number;
  pathWidth?: number;
}

function compactArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    parts.push(`${key}:${typeof value === "string" ? value : JSON.stringify(value)}`);
  }
  return parts.length ? `{${parts.join(",")}}` : "";
}

/**
 * Column width for the path, derived from the terminal.
 *
 * An MCP line carries a tool name and its arguments, which runs past any fixed
 * narrow width and gets truncated into uselessness. Fixed parts of the line
 * (time, method, status, duration) take about 30 columns; the rest is the path.
 */
function defaultPathWidth(): number {
  const columns = process.stdout.columns ?? 110;
  return Math.min(110, Math.max(52, columns - 30));
}

/**
 * One aligned request line: `18:42:38 GET  /health  200  0ms`.
 *
 * Local 24-hour time rather than an ISO stamp: these lines are read by a human
 * watching a terminal, and the date is the same for every line on screen.
 *
 * An MCP call is rewritten to `/mcp/<tool> {args}`. The raw path is
 * `/mcp/auth/<token>` for every single call, which tells the reader nothing;
 * the tool name is the only part worth a column.
 */
export function formatRequestLine(options: RequestLineOptions): string {
  const {
    method,
    pathname,
    status,
    durationMs,
    pathWidth = defaultPathWidth(),
    search,
    toolName,
    toolArgs,
    toolError,
  } = options;

  const time = dim(new Date().toLocaleTimeString("en-GB", { hour12: false }));
  const paddedMethod = colorMethod(method.padEnd(7));

  let shown = pathname;
  const isMcp = pathname === "/mcp" || pathname.startsWith("/mcp/auth/");
  if (isMcp && toolName) {
    shown = `/mcp/${toolName}`;
    const args = toolArgs ? compactArgs(toolArgs) : "";
    if (args) shown += ` ${args}`;
  } else if (isMcp && pathname.startsWith("/mcp/auth/")) {
    shown = "/mcp/...";
  } else if (search) {
    shown += search;
  }

  shown = maskSecrets(shown);
  if (shown.length > pathWidth) shown = `${shown.slice(0, pathWidth - 1)}…`;

  const duration = `${durationMs}ms`;
  const coloredDuration =
    durationMs < 10 ? dim(duration) : durationMs < 100 ? yellow(duration) : red(duration);
  const shownStatus = toolError ? red("ERR") : colorStatus(status);

  return `${time} ${paddedMethod} ${shown.padEnd(pathWidth)} ${shownStatus}  ${coloredDuration}`;
}

/**
 * The live box of the last {@link BOX_ROWS} requests.
 *
 * It repaints in place rather than scrolling: a supervisor terminal also
 * carries the owner logs, and letting request noise push those off the screen
 * is how you lose the line that actually mattered.
 */
class RequestBox {
  private lines: string[] = [];
  private eraseLines: number;
  private boxDrawn = false;
  private innerW: number;
  private maxPath: number;

  constructor(eraseLines: number) {
    this.eraseLines = eraseLines;
    const cols = process.stdout.columns || 80;
    this.innerW = Math.min(MAX_INNER_W, Math.max(MIN_INNER_W, cols - 6));
    this.maxPath = this.innerW - FIXED_COLS;
  }

  log(options: Omit<RequestLineOptions, "pathWidth">) {
    this.lines.push(formatRequestLine({ ...options, pathWidth: this.maxPath }));
    if (this.lines.length > BOX_ROWS) this.lines.shift();
    if (this.boxDrawn) {
      this.redraw();
    } else {
      this.drawInitial();
    }
  }

  /** Print arbitrary lines (owner logs, errors) above the box without breaking it. */
  printAbove(lines: string[]) {
    if (!this.boxDrawn) {
      for (const line of lines) process.stdout.write(`${line}\n`);
      return;
    }
    const boxHeight = BOX_ROWS + 2; // borders included
    // Cursor sits right below the box: go up, wipe it, print, then redraw it.
    process.stdout.write(`\x1b[${boxHeight}A`);
    for (let i = 0; i < boxHeight; i++) process.stdout.write("\x1b[2K\n");
    process.stdout.write(`\x1b[${boxHeight}A`);
    for (const line of lines) process.stdout.write(`${line}\x1b[K\n`);
    this.drawFrame();
    this.redraw();
  }

  private drawFrame() {
    const label = "── Requests ";
    const topFill = "─".repeat(this.innerW + 2 - label.length);
    process.stdout.write(`  ${dim(`┌${label}${topFill}┐`)}\n`);
    for (let i = 0; i < BOX_ROWS; i++) {
      process.stdout.write(`  ${dim("│")} ${" ".repeat(this.innerW)} ${dim("│")}\n`);
    }
    process.stdout.write(`  ${dim(`└${"─".repeat(this.innerW + 2)}┘`)}\n`);
  }

  private drawInitial() {
    // Erase the config blocks by moving up and overwriting them.
    if (this.eraseLines > 0) {
      process.stdout.write(`\x1b[${this.eraseLines}A`);
    }
    this.drawFrame();
    const leftover = this.eraseLines - (BOX_ROWS + 2);
    for (let i = 0; i < leftover; i++) {
      process.stdout.write("\x1b[2K\n");
    }
    if (leftover > 0) {
      process.stdout.write(`\x1b[${leftover}A`);
    }
    this.boxDrawn = true;
    this.redraw();
  }

  private redraw() {
    // Move cursor up: BOX_ROWS content + 1 bottom border
    process.stdout.write(`\x1b[${BOX_ROWS + 1}A`);
    for (let i = 0; i < BOX_ROWS; i++) {
      const line = this.lines[i] || "";
      process.stdout.write(
        `\r  ${dim("│")} ${padVisible(line, this.innerW)} ${dim("│")}\x1b[K\n`,
      );
    }
    process.stdout.write(`\r  ${dim(`└${"─".repeat(this.innerW + 2)}┘`)}\x1b[K\n`);
  }
}

let requestBox: RequestBox | null = null;

/**
 * Start repainting requests into a box, overwriting `eraseLines` of banner.
 *
 * A no-op off a TTY: in a log file the box would be a few hundred redraws of
 * the same frame, so those runs keep plain scrolling lines.
 */
export function beginRequestBox(eraseLines: number): void {
  requestBox = isTty ? new RequestBox(eraseLines) : null;
}

/** Drop the box — used by tests and before the process prints its last words. */
export function endRequestBox(): void {
  requestBox = null;
}

/** Print to stdout, stripping colour when the destination is not a terminal. */
export function write(line: string): void {
  console.log(colorEnabled ? line : stripAnsi(line));
}

export function writeError(line: string): void {
  console.error(colorEnabled ? line : stripAnsi(line));
}

/**
 * Print lines that are not requests (owner output, warnings) without tearing
 * the box apart. Plain `write` when no box is up.
 */
export function logAbove(lines: string | string[]): void {
  const list = (Array.isArray(lines) ? lines : [lines]).map((line) =>
    colorEnabled ? line : stripAnsi(line),
  );
  if (requestBox) {
    requestBox.printAbove(list);
    return;
  }
  for (const line of list) console.log(line);
}

export function logRequest(options: Omit<RequestLineOptions, "pathWidth">): void {
  if (requestBox) {
    requestBox.log(options);
    return;
  }
  // Piped to a file / a pane: no cursor tricks, but keep ANSI when asked for.
  write(formatRequestLine({ ...options, pathWidth: 80 }));
}

/**
 * One line per lifecycle event, for the runs nobody is watching.
 *
 * A log file is read for what happened and when; the startup banner is setup
 * help for a person at a terminal, it repaints itself and it carries the token
 * in a pasteable config — none of which belongs in a file.
 */
export function formatEvent(
  name: string,
  details: string[],
  now: Date = new Date(),
): string {
  const time = dim(now.toLocaleTimeString("en-GB", { hour12: false }));
  const text = details.filter(Boolean).join(dim(" · "));
  return `${time} ${bold(cyan(name.padEnd(7)))} ${text}`;
}

export function logEvent(name: string, ...details: string[]): void {
  logAbove(formatEvent(name, details));
}

/**
 * Log an error without ever throwing from the logger itself and without
 * corrupting the request box. Errors are what the reader came here for.
 */
export function logError(label: string, error: unknown): void {
  try {
    const lines = [
      `  ${red("✗")} ${bold(label)}`,
      ...formatError(error)
        .split("\n")
        .map((line) => `    ${dim(line)}`),
    ];
    if (requestBox) {
      requestBox.printAbove(lines.map((line) => (colorEnabled ? line : stripAnsi(line))));
      return;
    }
    for (const line of lines) writeError(line);
  } catch {
    console.error(`${label}:`, error);
  }
}
