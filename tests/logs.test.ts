import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { tailLogs } from "../src/api/tail-logs.ts";
import type { Config } from "../src/utils/config.ts";
import { legacyLogPath, logPath } from "../src/utils/paths.ts";

const ACCOUNT = "work";

function fixture(): Config {
  const root = mkdtempSync(join(tmpdir(), "tlgrm-logs-"));
  return {
    projectDir: join(root, "repo"),
    sessionBase: join(root, "sessions"),
    logBase: join(root, "data", "logs"),
    accounts: [ACCOUNT],
    env: {},
  };
}

function write(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

describe("tailLogs", () => {
  test("reads the XDG path, not a directory inside the checkout", async () => {
    const config = fixture();
    write(logPath(config, ACCOUNT), "new line\n");

    const tail = await tailLogs({ account: ACCOUNT, config });
    assert.equal(tail.path, logPath(config, ACCOUNT));
    assert.deepEqual(tail.lines, ["new line"]);
  });

  test("falls back to the pre-XDG path when nothing was written to the new one", async () => {
    // Months of history sit in <repo>/.sessions after the move; showing an empty
    // file instead would read as "the owner never logged anything".
    const config = fixture();
    write(legacyLogPath(config, ACCOUNT), "old line\n");

    const tail = await tailLogs({ account: ACCOUNT, config });
    assert.equal(tail.path, legacyLogPath(config, ACCOUNT));
    assert.deepEqual(tail.lines, ["old line"]);
  });

  test("a fresh log wins over the legacy one, never hidden by it", async () => {
    const config = fixture();
    write(legacyLogPath(config, ACCOUNT), "old line\n");
    write(logPath(config, ACCOUNT), "new line\n");

    const tail = await tailLogs({ account: ACCOUNT, config });
    assert.deepEqual(tail.lines, ["new line"]);
  });

  test("no log at all reports the current path, not the legacy one", async () => {
    const config = fixture();
    const tail = await tailLogs({ account: ACCOUNT, config });
    assert.equal(tail.exists, false);
    assert.equal(tail.path, logPath(config, ACCOUNT));
  });
});
