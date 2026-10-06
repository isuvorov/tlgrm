import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { pidExists, readLockPid } from "../src/utils/proc.ts";

describe("pidExists", () => {
  test("our own process exists", () => {
    assert.equal(pidExists(process.pid), true);
  });

  test("PID 1 exists even though we may not signal it (EPERM != death)", () => {
    // Exactly the mistake that let a lock be held by a foreign PID: EPERM has
    // to mean "the process is there", or the wrapper deletes someone else's
    // lock and starts a second owner on the same session.
    assert.equal(pidExists(1), true);
  });

  test("garbage values are not processes", () => {
    assert.equal(pidExists(0), false);
    assert.equal(pidExists(-5), false);
    assert.equal(pidExists(1.5), false);
  });
});

describe("readLockPid", () => {
  const dir = mkdtempSync(join(tmpdir(), "tlgrm-lock-"));

  test("no file -> undefined", () => {
    assert.equal(readLockPid(join(dir, "missing.lock")), undefined);
  });

  test("reads the PID, tolerating whitespace and a trailing newline", () => {
    const path = join(dir, "ok.lock");
    writeFileSync(path, " 4242\n");
    assert.equal(readLockPid(path), 4242);
  });

  test("non-PID content -> undefined", () => {
    const path = join(dir, "bad.lock");
    writeFileSync(path, "not a number");
    assert.equal(readLockPid(path), undefined);
  });

  test("zero is rejected: kill(0) would hit our own process group", () => {
    const zero = join(dir, "zero.lock");
    writeFileSync(zero, "0");
    assert.equal(readLockPid(zero), undefined);
  });
});
