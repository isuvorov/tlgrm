import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { reapStaleOwner } from "../src/api/reap-stale-owner.ts";
import type { Config } from "../src/utils/config.ts";

const ACCOUNT = "test-account";

function fixture(): Config {
  const base = mkdtempSync(join(tmpdir(), "tlgrm-reap-"));
  mkdirSync(join(base, ACCOUNT), { recursive: true });
  return {
    projectDir: base,
    sessionBase: base,
    logBase: join(base, "logs"),
    accounts: [ACCOUNT],
    apiId: "1",
    apiHash: "x",
    env: {},
  };
}

describe("reapStaleOwner", () => {
  test("a stale lock is released: PID gone, no socket", async () => {
    const config = fixture();
    // A PID that certainly does not exist: kill -0 yields ESRCH.
    writeFileSync(join(config.sessionBase, ACCOUNT, "daemon.lock"), "999999");

    const result = await reapStaleOwner({ account: ACCOUNT, config });
    assert.equal(result.reaped, true);
    assert.equal(result.terminatedPid, undefined);
  });

  test("a live PID is left alone unless the verdict is dead", async () => {
    // The project's central guard: on any verdict other than dead, killing is
    // forbidden. Here the socket is a regular file, so the verdict is unknown,
    // while the lock is held by our own, certainly live process.
    const config = fixture();
    const dir = join(config.sessionBase, ACCOUNT);
    writeFileSync(join(dir, "daemon.lock"), String(process.pid));
    writeFileSync(join(dir, "daemon.sock"), "not a socket");

    const result = await reapStaleOwner({ account: ACCOUNT, config });
    assert.equal(result.reaped, false);
    assert.match(result.reason, /not declared dead/);
    // And we are still alive — i.e. we did not kill ourselves.
    assert.equal(pidAlive(process.pid), true);
  });
});

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
