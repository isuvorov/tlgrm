import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { probeSocket } from "../src/utils/socket.ts";

/**
 * The probe must tell "dead" apart from "could not find out": the first verdict
 * makes the wrapper kill the lock holder, so conflating them kills a healthy
 * daemon.
 *
 * The `alive` branch cannot be covered here — the sandbox forbids listening on
 * a unix socket. It is verified by hand from a regular terminal against a live
 * daemon: `tlgrm status`.
 */
const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tlgrm-socket-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("probeSocket", () => {
  test("no socket file -> dead", async () => {
    const result = await probeSocket({ socketPath: join(tempDir(), "daemon.sock") });
    assert.equal(result.state, "dead");
    assert.match(result.reason, /no socket file/);
  });

  test("a regular file in place of the socket -> unknown, not dead", async () => {
    // Garbage where the socket should be does not mean there is no owner; the
    // verdict has to stay cautious, or the wrapper starts killing on any
    // connect error it does not recognise.
    const path = join(tempDir(), "daemon.sock");
    writeFileSync(path, "not a socket");
    const result = await probeSocket({ socketPath: path, timeoutMs: 500 });
    assert.equal(result.state, "unknown");
  });

  test("the verdict is always one of the three", async () => {
    const result = await probeSocket({ socketPath: join(tempDir(), "x.sock") });
    assert.ok(["alive", "dead", "unknown"].includes(result.state));
  });
});
