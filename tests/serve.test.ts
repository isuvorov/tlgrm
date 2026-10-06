import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { serveAccounts } from "../src/api/serve.ts";
import type { Config } from "../src/utils/config.ts";
import { setColor } from "../src/utils/logger.ts";

setColor(false);

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * A stand-in for the supervised package: prints to both streams and stays up
 * until SIGTERM, which is all `serve` cares about.
 *
 * Using a fake rather than the real mcp-telegram keeps the test off the network
 * and off a real Telegram session, while still exercising the part that is ours:
 * spawning a child per account, prefixing its output, and tearing it down.
 */
const FAKE_CLI = `
console.log("[serve] IPC socket ready (fake)");
console.error("[serve] connected as @" + process.env.TELEGRAM_SESSION_PATH.split("/").at(-2));
process.on("SIGTERM", () => { console.error("[serve] Shutting down"); process.exit(0); });
setInterval(() => {}, 1000);
`;

function fixture(accounts: string[]): Config {
  const base = mkdtempSync(join(tmpdir(), "tlgrm-serve-"));
  dirs.push(base);

  const dist = join(base, "node_modules", "@overpod", "mcp-telegram", "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "cli.js"), FAKE_CLI);

  for (const account of accounts) {
    mkdirSync(join(base, account), { recursive: true });
    writeFileSync(join(base, account, "session"), "x");
  }

  return {
    projectDir: base,
    sessionBase: base,
    logBase: join(base, "logs"),
    accounts,
    apiId: "1",
    apiHash: "h",
    env: {},
  };
}

describe("serveAccounts", () => {
  test("starts one owner per account and stops them all on SIGINT", async () => {
    const config = fixture(["work", "personal"]);

    const running = serveAccounts({ config, tee: false, noHttp: true });
    // Give both children time to come up before asking for shutdown.
    const timer = setTimeout(() => process.kill(process.pid, "SIGINT"), 1500);
    const code = await running;
    clearTimeout(timer);

    assert.equal(code, 0);
  });

  test("an account without a session is skipped, not fatal", async () => {
    const config = fixture(["work"]);
    // A second account the fixture never gave a session file to.
    const withGhost: Config = { ...config, accounts: ["work", "ghost"] };

    const running = serveAccounts({ config: withGhost, tee: false, noHttp: true });
    const timer = setTimeout(() => process.kill(process.pid, "SIGINT"), 1500);
    const code = await running;
    clearTimeout(timer);

    // `work` still served, so the command succeeded.
    assert.equal(code, 0);
  });

  test("nothing to serve is an error, not a silent success", async () => {
    const config = fixture([]);
    const code = await serveAccounts({
      config: { ...config, accounts: ["ghost"] },
      tee: false,
      noHttp: true,
    });
    assert.equal(code, 1);
  });
});
