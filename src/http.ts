import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { doctor } from "./api/doctor.ts";
import { listStatuses } from "./api/get-status.ts";
import { listOrphans } from "./api/list-orphans.ts";
import { startDaemon } from "./api/start-daemon.ts";
import { stopDaemon } from "./api/stop-daemon.ts";
import { tailLogs } from "./api/tail-logs.ts";
import { BIN_NAME, DEFAULT_HOST, DEFAULT_PORT, VERSION } from "./constants.ts";
import { createMcpServer } from "./mcp-server.ts";
import {
  authCookieHeader,
  checkAuth,
  generateToken,
  HOST_ENV,
  PORT_ENV,
  TOKEN_ENV,
  tokenMatches,
} from "./utils/auth.ts";
import { type Config, loadConfig } from "./utils/config.ts";
import { errorMessage, isClientAbort } from "./utils/errors.ts";
import { isInteractive, type LogExtra, logError, logRequest } from "./utils/logger.ts";
import { logPath } from "./utils/paths.ts";
import { MAX_PORT_ATTEMPTS } from "./utils/port.ts";
import { FAVICON_SVG, getAuthPage, getHomePage } from "./web.ts";

/**
 * The HTTP + MCP-over-HTTP surface, started by `serve` in the same process as
 * the owners.
 *
 * It is deliberately not a daemon: it lives and dies with the command that
 * printed its URL. Request lines go to stdout interleaved with the owner logs,
 * which is the whole point — one terminal, everything visible.
 */
export interface HttpOptions {
  port?: number;
  host?: string;
  token?: string;
  config?: Config;
}

type Handler = (params: {
  account?: string;
  query: URLSearchParams;
  config: Config;
}) => Promise<unknown>;

const ROUTES: Record<string, { method: string; handler: Handler }> = {
  "/status": { method: "GET", handler: ({ config }) => listStatuses({ config }) },
  "/doctor": { method: "GET", handler: ({ config }) => doctor({ config }) },
  "/orphans": { method: "GET", handler: ({ config }) => listOrphans({ config }) },
  "/logs": {
    method: "GET",
    handler: async ({ account, query, config }) => {
      if (!account) throw new Error("the account parameter is required");
      const lines = Number.parseInt(query.get("lines") ?? "", 10);
      return tailLogs({
        account,
        lines: Number.isInteger(lines) && lines > 0 ? lines : undefined,
        config,
      });
    },
  },
  "/start": {
    method: "POST",
    handler: async ({ account, config }) => {
      if (!account) throw new Error("the account parameter is required");
      return startDaemon({ account, config });
    },
  },
  "/stop": {
    method: "POST",
    handler: async ({ account, config }) => {
      if (!account) throw new Error("the account parameter is required");
      return stopDaemon({ account, config });
    },
  },
};

/** The prefix an uptime monitor pings; the suffix after it is the monitor's own name. */
export const PROBE_PREFIX = "/__up";

/**
 * Probe traffic is answered without auth and kept out of the request log: a
 * monitor polls forever, and those lines would bury every real request and spin
 * the log rotation for nothing. One predicate for both decisions, so they can
 * never drift apart.
 */
export function isProbePath(pathname: string): boolean {
  return pathname === PROBE_PREFIX || pathname.startsWith(`${PROBE_PREFIX}/`);
}

/** Route index, served at `/api` so the printed API url leads somewhere. */
function index() {
  return {
    name: BIN_NAME,
    version: VERSION,
    routes: {
      "GET /": "web client",
      "GET /health": "liveness, no token required",
      "GET|HEAD /__up/{anything}": "uptime probe, no token required",
      "GET /auth": "token form; sets the cookie the web client uses",
      "GET /status": "owner state per account",
      "GET /doctor": "aggregate diagnosis",
      "GET /orphans": "package processes and lock files",
      "GET /logs?account=&lines=": "tail an owner log",
      "POST /start?account=": "start a detached owner",
      "POST /stop?account=": "stop an owner",
      "GET /mcp/auth/{token}": "MCP over HTTP",
    },
  };
}

/** Read and parse a JSON request body; MCP speaks JSON-RPC over POST. */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString("utf-8");
  if (text.trim() === "") return undefined;
  return JSON.parse(text);
}

/** Read a urlencoded form body — the sign-in form is the only one. */
async function readFormBody(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return new URLSearchParams(Buffer.concat(chunks).toString("utf-8"));
}

/**
 * The JSON-RPC detail worth a column in the request log.
 *
 * Every MCP call hits the same `/mcp/auth/<token>` path, so without this the
 * log is a page of identical lines; the tool name and its arguments are the
 * only part that says what actually happened.
 */
function mcpLogExtra(body: unknown): LogExtra {
  if (!body || typeof body !== "object") return {};
  const { method, params } = body as {
    method?: unknown;
    params?: { name?: unknown; arguments?: unknown };
  };
  if (typeof method !== "string") return {};
  if (method !== "tools/call") return { toolName: method };
  return {
    toolName: typeof params?.name === "string" ? params.name : method,
    toolArgs:
      params?.arguments && typeof params.arguments === "object"
        ? (params.arguments as Record<string, unknown>)
        : undefined,
  };
}

/**
 * MCP over HTTP, one transport per request.
 *
 * Stateless (`sessionIdGenerator: undefined`) rather than keeping a session map:
 * every tool here is a short request/response that reads state from disk, so
 * there is nothing worth carrying between calls — and no session table to leak
 * when a client disappears.
 */
async function handleMcp(params: {
  req: IncomingMessage;
  res: ServerResponse;
  config: Config;
  started: number;
  url: URL;
}): Promise<void> {
  const { req, res, config, started, url } = params;

  const method = req.method ?? "?";
  let extra: LogExtra = {};
  const logLine = (status: number, toolError?: string) =>
    logRequest({
      method,
      pathname: url.pathname,
      status,
      durationMs: Date.now() - started,
      ...extra,
      ...(toolError ? { toolError } : {}),
    });

  let body: unknown;
  try {
    body = req.method === "POST" ? await readJsonBody(req) : undefined;
    extra = mcpLogExtra(body);
  } catch (error) {
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32700, message: "Parse error" },
      id: null,
    });
    res.writeHead(400, { "content-type": "application/json" });
    res.end(payload);
    return logLine(400, errorMessage(error));
  }

  const { server } = await createMcpServer({ config });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  // The transport closes on response end; closing the server with it keeps the
  // per-request pair from leaking listeners.
  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
    logLine(res.statusCode);
  } catch (error) {
    // A client hanging up mid-stream is routine for MCP proxies: it belongs in
    // the request line as an ERR, not in a stack trace that reads like a crash.
    if (!isClientAbort(error)) logError("MCP request failed", error);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: errorMessage(error) }));
    }
    logLine(500, errorMessage(error));
  }
}

export function createHttpServer(options: HttpOptions = {}): Server {
  const config = options.config ?? loadConfig();
  const token = options.token;

  return createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "?";

    const log = (status: number) => {
      if (isProbePath(url.pathname)) return;
      logRequest({
        method,
        pathname: url.pathname,
        status,
        durationMs: Date.now() - started,
        search: url.search || undefined,
      });
    };

    const send = (status: number, body: unknown) => {
      const payload = JSON.stringify(body, null, 2);
      res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(payload),
      });
      res.end(payload);
      log(status);
    };

    const sendHtml = (status: number, html: string) => {
      res.writeHead(status, {
        "content-type": "text/html; charset=utf-8",
        "content-length": Buffer.byteLength(html),
      });
      res.end(html);
      log(status);
    };

    // The web client, its icon, health and the route index need no token: they
    // leak nothing but route names, and whatever the page fetches is checked
    // below like any other call.
    if (url.pathname === "/" && method === "GET") {
      return sendHtml(200, getHomePage());
    }
    if (url.pathname === "/favicon.ico" && method === "GET") {
      res.writeHead(200, {
        "content-type": "image/svg+xml",
        "cache-control": "max-age=86400",
      });
      res.end(FAVICON_SVG);
      return log(200);
    }
    const liveness = () => ({ ok: true, name: BIN_NAME, version: VERSION });

    // HEAD as well as GET: uptime monitors ping with HEAD and read nothing but
    // the status code. Node drops the body on a HEAD itself, so one branch
    // serves both.
    //
    // The pid and the log paths go only to a caller holding the token: a second
    // `serve` run uses them to report the instance that owns the port, while an
    // anonymous probe learns nothing beyond "alive".
    if (url.pathname === "/health") {
      const authed = checkAuth({
        authorization: req.headers.authorization,
        cookie: req.headers.cookie,
        expected: token,
      }).ok;
      return send(
        200,
        authed
          ? {
              ...liveness(),
              pid: process.pid,
              tty: isInteractive,
              logs: config.accounts.map((account) => logPath(config, account)),
            }
          : liveness(),
      );
    }

    // `/__up/<whatever>`: the suffix is the monitor's own service name, never
    // ours, so anything under the prefix answers. A 401 here reads as an
    // outage, and the reply says nothing beyond "it is alive".
    if (url.pathname === "/__up" || url.pathname.startsWith("/__up/")) {
      if (method === "GET" || method === "HEAD") {
        return send(200, liveness());
      }
    }

    if (url.pathname === "/api") {
      return send(200, index());
    }

    // ── Sign-in: how a browser gets a credential it can actually carry ──
    if (url.pathname === "/auth" && method === "GET") {
      return sendHtml(200, getAuthPage(url.searchParams.get("next") ?? "/"));
    }
    if (url.pathname === "/auth" && method === "POST") {
      const form = await readFormBody(req);
      const next = form.get("next") ?? "/";
      const safeNext = next.startsWith("/") ? next : "/";
      if (!token || !tokenMatches(form.get("token") ?? "", token)) {
        return sendHtml(401, getAuthPage(safeNext, "Wrong token"));
      }
      res.writeHead(303, { location: safeNext, "set-cookie": authCookieHeader(token) });
      res.end();
      return log(303);
    }

    const auth = checkAuth({
      authorization: req.headers.authorization,
      cookie: req.headers.cookie,
      pathname: url.pathname,
      expected: token,
    });
    if (!auth.ok) {
      return send(401, { error: "unauthorized" });
    }

    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/auth/")) {
      return handleMcp({ req, res, config, started, url });
    }

    const route = ROUTES[url.pathname];
    if (!route) return send(404, { error: "not found", see: "/api" });
    if (route.method !== method) return send(405, { error: `${route.method} required` });

    try {
      const result = await route.handler({
        account: url.searchParams.get("account") ?? undefined,
        query: url.searchParams,
        config,
      });
      return send(200, result);
    } catch (error) {
      return send(400, { error: errorMessage(error) });
    }
  });
}

/**
 * Where the server would bind, before it tries.
 *
 * Exported because `serve` has to probe that exact port for an instance of ours
 * before binding, and a second copy of this resolution order is how the probe
 * and the bind end up looking at different ports.
 */
export function resolveBind(options: { port?: number; host?: string } = {}): {
  port: number;
  host: string;
} {
  const envPort = Number.parseInt(process.env[PORT_ENV] ?? "", 10);
  return {
    port: options.port ?? (Number.isInteger(envPort) ? envPort : DEFAULT_PORT),
    host: options.host ?? process.env[HOST_ENV] ?? DEFAULT_HOST,
  };
}

export interface StartedHttp {
  server: Server;
  port: number;
  requestedPort: number;
  host: string;
  token: string;
  generated: boolean;
}

/**
 * Bind the server, walking forward when the port is taken.
 *
 * Bind first and interpret the failure afterwards: probing before binding races
 * with anything shutting down on that port, and a busy port is a nuisance
 * rather than a reason to refuse to start.
 */
export async function startHttp(options: HttpOptions = {}): Promise<StartedHttp> {
  const config = options.config ?? loadConfig();
  const { port: requestedPort, host } = resolveBind(options);

  const configured = options.token ?? process.env[TOKEN_ENV];
  const generated = !configured;
  const token = configured ?? generateToken();

  const server = createHttpServer({ ...options, config, token });

  // A dead socket must never take the supervisor down with it: the owners it
  // watches are children of this process.
  server.on("clientError", (error, socket) => {
    if (!isClientAbort(error)) logError("Client connection error", error);
    socket.destroy();
  });

  for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt += 1) {
    const candidate = requestedPort + attempt;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        server.once("error", onError);
        server.listen(candidate, host, () => {
          server.off("error", onError);
          resolve();
        });
      });
      return { server, port: candidate, requestedPort, host, token, generated };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      if (attempt === MAX_PORT_ATTEMPTS - 1) throw error;
    }
  }

  throw new Error(
    `no free port in ${requestedPort}..${requestedPort + MAX_PORT_ATTEMPTS}`,
  );
}
