import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  formatBytes,
  formatStartupBanner,
  suggestCommand,
  tildify,
} from "../src/utils/format.ts";
import { setColor } from "../src/utils/logger.ts";

setColor(false);

describe("tildify", () => {
  test("shortens a path under the home directory", () => {
    assert.equal(
      tildify("/Users/x/Library/Logs/a.log", "/Users/x"),
      "~/Library/Logs/a.log",
    );
  });

  test("leaves anything outside home alone", () => {
    assert.equal(tildify("/var/log/a.log", "/Users/x"), "/var/log/a.log");
  });
});

describe("formatBytes", () => {
  test("bytes, kilobytes, megabytes", () => {
    assert.equal(formatBytes(0), "0 B");
    assert.equal(formatBytes(512), "512 B");
    assert.equal(formatBytes(2048), "2 KB");
    assert.equal(formatBytes(5 * 1024 * 1024), "5.0 MB");
  });
});

describe("suggestCommand", () => {
  const commands = ["status", "doctor", "start", "logs", "info", "daemon"];

  test("a one-letter typo gets the right suggestion", () => {
    // The case that prompted this: `tlgrm infp` printed the whole help text.
    assert.equal(suggestCommand("infp", commands), "info");
    assert.equal(suggestCommand("statu", commands), "status");
    assert.equal(suggestCommand("doctro", commands), "doctor");
  });

  test("nonsense gets no suggestion rather than a random one", () => {
    assert.equal(suggestCommand("zzzzzzzzzz", commands), undefined);
  });

  test("an exact command suggests itself", () => {
    assert.equal(suggestCommand("logs", commands), "logs");
  });
});

describe("formatStartupBanner", () => {
  const banner = {
    version: "0.1.0",
    url: "http://127.0.0.1:7717",
    token: "tok",
    generated: false,
    tokenEnv: "TLGRM_TOKEN",
    stdio: { command: "/opt/homebrew/bin/node", args: ["/x/src/cli.ts", "mcp"] },
    port: 7717,
  };

  test("prints the URL rows and every copy-pasteable config", () => {
    // Also the regression guard for a missing import: this function is only
    // ever called from `serve`, so a broken reference used to surface as a
    // crash at runtime rather than a failing test.
    const { text } = formatStartupBanner(banner);
    assert.ok(text.includes("tlgrm v0.1.0"));
    assert.ok(text.includes("WEB:"));
    assert.ok(text.includes("http://127.0.0.1:7717/api"));
    assert.ok(text.includes("/mcp/auth/tok"));
    assert.ok(text.includes("MCP config (Localhost MCP)"));
    assert.ok(text.includes("MCP config (CLI)"));
  });

  test("the HTTP config sends the token as a header, not in the URL", () => {
    // Locally every client can set a header, so the pasteable block never puts a
    // working credential in a URL — the clickable MCP row above it still does,
    // for the clients that cannot.
    const { text } = formatStartupBanner(banner);
    assert.ok(text.includes('"Authorization": "Bearer tok"'));
    assert.ok(text.includes('"url": "http://127.0.0.1:7717/mcp"'));
    assert.ok(!text.includes('"url": "http://127.0.0.1:7717/mcp/auth/tok"'));
  });

  test("a generated token says so, a pinned one does not", () => {
    assert.ok(
      formatStartupBanner({ ...banner, generated: true }).text.includes("generated"),
    );
    assert.ok(!formatStartupBanner(banner).text.includes("generated"));
  });

  test("a port walk is announced", () => {
    const moved = formatStartupBanner({
      ...banner,
      requestedPort: 7717,
      port: 7718,
    }).text;
    assert.ok(moved.includes("Port 7717 busy, using 7718"));
  });

  test("configLines counts exactly the trailing config block lines", () => {
    // The request box moves the cursor up by this number to draw over them —
    // an off-by-one here corrupts the screen instead of failing loudly.
    const { text, configLines } = formatStartupBanner(banner);
    const lines = text.split("\n");
    const firstConfig = lines.findIndex((line) =>
      line.includes("MCP config (Localhost MCP)"),
    );
    assert.ok(firstConfig > 0);
    assert.equal(configLines, lines.length - firstConfig);
  });
});
