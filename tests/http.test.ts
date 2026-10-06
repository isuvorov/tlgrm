import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { isProbePath, startHttp } from "../src/http.ts";
import { TOKEN_ENV } from "../src/utils/auth.ts";
import type { Config } from "../src/utils/config.ts";
import { setColor } from "../src/utils/logger.ts";

setColor(false);

// One account, so the MCP endpoint can resolve a default without a query
// parameter. projectDir stays the real repo: the Telegram tool schemas are read
// from its node_modules.
const config: Config = {
  projectDir: process.cwd(),
  sessionBase: "/tmp/tlgrm-http-test",
  logBase: "/tmp/tlgrm-http-test-logs",
  accounts: ["http-test-account"],
  env: {},
};

const started = await startHttp({ config, port: 7860, token: "test-token" });
const base = `http://${started.host}:${started.port}`;

// closeAllConnections before close: fetch leaves keep-alive sockets behind, and
// a plain close() only stops new connections — the runner would then sit on a
// live event loop until it is killed.
after(() => {
  started.server.closeAllConnections();
  started.server.close();
});

/**
 * One JSON-RPC round trip over the MCP transport.
 *
 * The transport answers as `text/event-stream`, so the payload arrives in
 * `data:` lines rather than as the whole body.
 */
interface RpcReply {
  status: number;
  json: {
    result?: {
      serverInfo?: { name: string; version: string };
      tools?: Array<{ name: string }>;
      content?: Array<{ text: string }>;
    };
    error?: { code: number; message: string };
  } | null;
}

async function rpc(body: unknown): Promise<RpcReply> {
  const response = await fetch(`${base}/mcp/auth/test-token`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const data = text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("");
  return { status: response.status, json: data ? JSON.parse(data) : null };
}

describe("http surface", () => {
  test("/health needs no token and identifies the app", async () => {
    // probePort relies on `name` to tell our server from a stranger on the port.
    const response = await fetch(`${base}/health`);
    const body = (await response.json()) as { ok: boolean; name: string };
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.name, "tlgrm");
  });

  test("an uptime probe under /__up answers without a token, HEAD included", async () => {
    // The monitor appends its own service name to the path and reads only the
    // status code — a 401 there would be reported as an outage.
    const head = await fetch(`${base}/__up/things-lan-axxx-dev`, { method: "HEAD" });
    assert.equal(head.status, 200);

    const get = await fetch(`${base}/__up`);
    assert.equal(get.status, 200);
    assert.equal(((await get.json()) as { ok: boolean }).ok, true);

    // Only the read methods: a probe prefix must not become an open write path.
    const posted = await fetch(`${base}/__up/x`, { method: "POST" });
    assert.equal(posted.status, 401);
  });

  test("the same predicate gates the answer and the silence", () => {
    // A monitor polls every few seconds forever: logging that would bury every
    // real request. One predicate for both decisions so they cannot drift.
    assert.equal(isProbePath("/__up"), true);
    assert.equal(isProbePath("/__up/things-lan-axxx-dev"), true);
    // The prefix has to be a whole path segment, not just a string prefix.
    assert.equal(isProbePath("/__uptime"), false);
    assert.equal(isProbePath("/api/__up"), false);
  });

  test("/health tells a stranger it is alive and nothing else", async () => {
    // probePort only needs `name`; the pid and the log paths are for a second
    // `serve` run, which always holds the token.
    const anonymous = (await (await fetch(`${base}/health`)).json()) as Record<
      string,
      unknown
    >;
    assert.equal(anonymous.name, "tlgrm");
    assert.equal(anonymous.pid, undefined);
    assert.equal(anonymous.logs, undefined);

    const authed = (await (
      await fetch(`${base}/health`, { headers: { authorization: "Bearer test-token" } })
    ).json()) as { pid?: number; logs?: string[] };
    assert.equal(authed.pid, process.pid);
    assert.ok(authed.logs?.[0]?.endsWith("http-test-account/serve.log"));
  });

  test("/ serves the web client, not JSON", async () => {
    // The WEB: row of the startup banner points here; a JSON blob behind it
    // is the bug this test exists for.
    const response = await fetch(`${base}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    const html = await response.text();
    assert.ok(html.startsWith("<!DOCTYPE html>"));
    assert.ok(html.includes("/status"));
  });

  test("/api lists the routes without a token", async () => {
    const response = await fetch(`${base}/api`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { routes: Record<string, string> };
    assert.ok(Object.keys(body.routes).length > 0);
  });

  test("/auth serves a token form and sets a cookie for the right token", async () => {
    const form = await fetch(`${base}/auth`);
    assert.equal(form.status, 200);
    assert.ok((await form.text()).includes('name="token"'));

    // A browser cannot send an Authorization header on a navigation, so this
    // exchange is the only way the web client ever gets a credential.
    const accepted = await fetch(`${base}/auth`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: "test-token", next: "/" }).toString(),
      redirect: "manual",
    });
    assert.equal(accepted.status, 303);
    const cookie = accepted.headers.get("set-cookie") ?? "";
    assert.match(cookie, /^tlgrm_token=test-token;/);
    assert.match(cookie, /HttpOnly/);

    const rejected = await fetch(`${base}/auth`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: "wrong", next: "/" }).toString(),
      redirect: "manual",
    });
    assert.equal(rejected.status, 401);
    assert.equal(rejected.headers.get("set-cookie"), null);
  });

  test("the auth cookie authenticates an API call", async () => {
    const response = await fetch(`${base}/status`, {
      headers: { cookie: "tlgrm_token=test-token" },
    });
    assert.equal(response.status, 200);
  });

  test("an API route without a token is 401", async () => {
    const response = await fetch(`${base}/status`);
    assert.equal(response.status, 401);
  });

  test("a bearer header is accepted", async () => {
    const response = await fetch(`${base}/status`, {
      headers: { authorization: "Bearer test-token" },
    });
    assert.equal(response.status, 200);
  });

  test("an unknown route points at the index", async () => {
    const response = await fetch(`${base}/nope`, {
      headers: { authorization: "Bearer test-token" },
    });
    assert.equal(response.status, 404);
    const body = (await response.json()) as { see: string };
    assert.equal(body.see, "/api");
  });

  test("a wrong token on the MCP path is rejected", async () => {
    const response = await fetch(`${base}/mcp/auth/nope`);
    assert.equal(response.status, 401);
  });

  test("a busy port is walked past rather than fatal", async () => {
    const second = await startHttp({ config, port: started.port, token: "t2" });
    assert.equal(second.requestedPort, started.port);
    assert.ok(second.port > started.port);
    second.server.close();
  });

  test("a token is generated when none was configured", async () => {
    // TLGRM_TOKEN in the developer's own shell is exactly "configured", so the
    // assertion only means anything with the ambient value out of the way.
    const ambient = process.env[TOKEN_ENV];
    delete process.env[TOKEN_ENV];
    try {
      const third = await startHttp({ config, port: 7880 });
      assert.equal(third.generated, true);
      assert.ok(third.token.length >= 32);
      third.server.close();
    } finally {
      if (ambient !== undefined) process.env[TOKEN_ENV] = ambient;
    }
  });
});

describe("mcp over http", () => {
  test("initialize returns our server info", async () => {
    const init = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
    });
    assert.equal(init.status, 200);
    assert.equal(init.json?.result?.serverInfo?.name, "tlgrm");
  });

  test("tools/list advertises the Telegram tools next to the supervision ones", async () => {
    const list = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    assert.equal(list.status, 200);
    const names = (list.json?.result?.tools ?? []).map((t) => t.name);
    // The complaint this guards: a client used to see only the six local tools.
    assert.ok(names.length > 100, `expected the full set, got ${names.length}`);
    assert.ok(names.includes("telegram-send-message"));
    assert.ok(names.includes("telegram-read-messages"));
    assert.ok(names.includes("telegram-daemons-status"));
    assert.ok(names.includes("telegram-daemons-doctor"));
  });

  test("tools/call runs a local supervision tool", async () => {
    const called = await rpc({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "telegram-daemons-status", arguments: {} },
    });
    assert.equal(called.status, 200);
    assert.equal(typeof called.json?.result?.content?.[0]?.text, "string");
  });

  test('an empty ?account= means "not specified", not an account named ""', async () => {
    const response = await fetch(`${base}/mcp/auth/test-token?account=`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }),
    });
    // An empty account falls back to the single discovered one, so this is 200;
    // the ambiguous case needs two accounts and is covered in the CLI.
    assert.equal(response.status, 200);
  });

  test("a malformed body is a JSON-RPC parse error, not a crash", async () => {
    const response = await fetch(`${base}/mcp/auth/test-token`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: "{not json",
    });
    assert.equal(response.status, 400);
    const body = (await response.json()) as { error?: { code: number } };
    assert.equal(body.error?.code, -32700);
  });
});
