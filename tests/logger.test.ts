import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import {
  colorStatus,
  formatEvent,
  formatRequestLine,
  maskSecrets,
  padVisible,
  setColor,
  stripAnsi,
  visibleLength,
} from "../src/utils/logger.ts";

afterEach(() => setColor(false));

describe("colour switching", () => {
  test("off by default in tests, so assertions compare plain text", () => {
    setColor(false);
    assert.equal(colorStatus(200), "200");
  });

  test("on produces escape codes that stripAnsi removes again", () => {
    setColor(true);
    const colored = colorStatus(500);
    assert.notEqual(colored, "500");
    assert.equal(stripAnsi(colored), "500");
  });
});

describe("visibleLength and padVisible", () => {
  test("escape codes do not count towards width", () => {
    setColor(true);
    const colored = colorStatus(200);
    assert.equal(visibleLength(colored), 3);
    // Padding a coloured string must align by visible width, or columns drift.
    assert.equal(visibleLength(padVisible(colored, 10)), 10);
  });
});

describe("maskSecrets", () => {
  test("the MCP path token never reaches a log line", () => {
    setColor(false);
    assert.equal(maskSecrets("/mcp/auth/s3cr3t"), "/mcp/auth/…");
    assert.equal(maskSecrets("/logs?token=s3cr3t&lines=5"), "/logs?token=…&lines=5");
  });
});

describe("formatRequestLine", () => {
  const base = { method: "POST", status: 200, durationMs: 3 };

  test("the time, method, path, status and duration line up in columns", () => {
    setColor(false);
    const line = formatRequestLine({ ...base, pathname: "/health", pathWidth: 12 });
    assert.match(line, /^\d\d:\d\d:\d\d POST {4}\/health {6}200 {2}3ms$/);
  });

  test("an MCP call is logged as its tool name, not as the token path", () => {
    // Every MCP request hits /mcp/auth/<token>, so the raw path is both a
    // credential and useless as a label.
    setColor(false);
    const line = formatRequestLine({
      ...base,
      pathname: "/mcp/auth/s3cr3t",
      toolName: "telegram-daemons-status",
      toolArgs: { account: "work", lines: 5 },
    });
    assert.ok(line.includes("/mcp/telegram-daemons-status {account:work,lines:5}"));
    assert.ok(!line.includes("s3cr3t"));
  });

  test("an MCP call with no parsed tool shows a placeholder path", () => {
    setColor(false);
    const line = formatRequestLine({ ...base, pathname: "/mcp/auth/s3cr3t" });
    assert.ok(line.includes("/mcp/..."));
    assert.ok(!line.includes("s3cr3t"));
  });

  test("a tool error replaces the status column with ERR", () => {
    setColor(false);
    const line = formatRequestLine({
      ...base,
      pathname: "/mcp",
      toolName: "telegram-daemons-start",
      toolError: "AUTH_KEY_DUPLICATED",
    });
    assert.ok(line.includes("ERR"));
    assert.ok(!line.includes("200"));
  });

  test("an over-long path is truncated to the column width", () => {
    setColor(false);
    const line = formatRequestLine({
      ...base,
      pathname: `/${"x".repeat(80)}`,
      pathWidth: 10,
    });
    assert.ok(line.includes(`${"/".padEnd(1)}${"x".repeat(8)}…`));
  });

  test("the query string is shown for a plain route", () => {
    setColor(false);
    const line = formatRequestLine({
      ...base,
      method: "GET",
      pathname: "/logs",
      search: "?account=work&lines=5",
    });
    assert.ok(line.includes("/logs?account=work&lines=5"));
  });
});

describe("formatEvent", () => {
  const at = new Date(2026, 9, 6, 18, 42, 38);

  test("time, name and the details that are not empty", () => {
    // The off-terminal face of the banner: a log file is read for what happened
    // and when, and `started` carrying a token in a pasteable config is not that.
    setColor(false);
    const line = formatEvent("started", ["v0.1.0", "pid 42", "", "accounts work"], at);
    assert.equal(line, "18:42:38 started v0.1.0 · pid 42 · accounts work");
  });

  test("the name column is padded, so two event kinds line up", () => {
    setColor(false);
    const started = formatEvent("started", ["@"], at);
    const stopped = formatEvent("up", ["@"], at);
    assert.equal(started.indexOf("@"), stopped.indexOf("@"));
  });
});
