/**
 * Anything can be thrown or rejected in JS — including `undefined`.
 *
 * These helpers turn any value into something a human can read, so the server
 * never prints a bare "error: undefined" into the one log file that was
 * supposed to explain what went wrong.
 */

const MAX_STACK_LINES = 8;
const MAX_CAUSE_DEPTH = 3;

/** Short, single-line description — safe for HTTP responses and log lines. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name || "Error";
  if (typeof error === "string") return error || "Empty error string";
  if (error === undefined) return "undefined (thrown/rejected without a reason)";
  if (error === null) return "null (thrown/rejected without a reason)";
  if (typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
    try {
      return JSON.stringify(error) ?? String(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

/** Multi-line description with stack, error code, aggregated errors and causes. */
export function formatError(error: unknown): string {
  return formatErrorLines(error, 0).join("\n");
}

function formatErrorLines(error: unknown, depth: number): string[] {
  if (depth > MAX_CAUSE_DEPTH) return ["… (cause chain truncated)"];

  if (!(error instanceof Error)) {
    return [`${errorMessage(error)}  [typeof ${typeof error}]`];
  }

  const lines = [`${error.name}: ${errorMessage(error)}`];

  const code = (error as { code?: unknown }).code;
  if (code !== undefined) lines.push(`code: ${String(code)}`);

  if (error.stack) {
    const frames = error.stack
      .split("\n")
      .slice(1)
      .map((line) => line.trim())
      .filter(Boolean);
    lines.push(...frames.slice(0, MAX_STACK_LINES));
    if (frames.length > MAX_STACK_LINES) {
      lines.push(`… ${frames.length - MAX_STACK_LINES} more`);
    }
  }

  const aggregated = (error as { errors?: unknown }).errors;
  if (Array.isArray(aggregated)) {
    for (const inner of aggregated) {
      lines.push("contains:");
      lines.push(...formatErrorLines(inner, depth + 1).map((line) => `  ${line}`));
    }
  }

  const cause = (error as { cause?: unknown }).cause;
  if (cause !== undefined) {
    lines.push("caused by:");
    lines.push(...formatErrorLines(cause, depth + 1).map((line) => `  ${line}`));
  }

  return lines;
}

const ABORT_CODES = new Set([
  "ABORT_ERR",
  "ECONNABORTED",
  "ECONNRESET",
  "EPIPE",
  "ERR_STREAM_PREMATURE_CLOSE",
]);

const ABORT_PATTERNS = [
  /abort/i,
  /(connection|socket|stream|pipe|request)\s+(was\s+|has\s+been\s+)?(closed|reset|broken)/i,
  /closed the connection/i,
  /premature close/i,
  /broken pipe/i,
  /client (disconnected|went away)/i,
];

/**
 * True for the everyday "client hung up mid-response" errors.
 *
 * These are normal for SSE/MCP traffic and must never look like a crash — an
 * AI client closing a stream is not an incident.
 */
export function isClientAbort(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { name, code, message } = error as {
    name?: unknown;
    code?: unknown;
    message?: unknown;
  };
  if (name === "AbortError" || name === "TimeoutError") return true;
  if (typeof code === "string" && ABORT_CODES.has(code)) return true;
  if (typeof message !== "string") return false;
  return ABORT_PATTERNS.some((pattern) => pattern.test(message));
}
