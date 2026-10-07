import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { parseArgs } from "../src/cli.ts";
import { VERSION } from "../src/constants.ts";

describe("parseArgs", () => {
  test("no command with no positionals — run() prints help", () => {
    const args = parseArgs([]);
    assert.equal(args.command, "");
    assert.deepEqual(args.accounts, []);
  });

  test("a command plus a list of accounts", () => {
    const args = parseArgs(["serve", "first", "second"]);
    assert.equal(args.command, "serve");
    assert.deepEqual(args.accounts, ["first", "second"]);
  });

  test("--json and --lines in both forms", () => {
    assert.equal(parseArgs(["logs", "--json"]).json, true);
    assert.equal(parseArgs(["logs", "--lines", "15"]).lines, 15);
    assert.equal(parseArgs(["logs", "-n", "7"]).lines, 7);
    assert.equal(parseArgs(["logs", "--lines=99"]).lines, 99);
  });

  test("a flag value does not leak into the account list", () => {
    const args = parseArgs(["logs", "work", "-n", "20"]);
    assert.deepEqual(args.accounts, ["work"]);
    assert.equal(args.lines, 20);
  });

  test("--no-color and --version are recognised", () => {
    assert.equal(parseArgs(["status", "--no-color"]).noColor, true);
    assert.equal(parseArgs(["status", "--plain"]).noColor, true);
    assert.equal(parseArgs(["status", "--version"]).version, true);
    assert.equal(parseArgs(["status", "-v"]).version, true);
  });

  test("an unknown flag is collected, not swallowed", () => {
    // Silently ignoring `--josn` ran the command as if nothing was passed,
    // which hid typos instead of reporting them.
    const args = parseArgs(["status", "--josn"]);
    assert.deepEqual(args.unknown, ["--josn"]);
    assert.deepEqual(args.accounts, []);
  });

  test("a bad --lines value is ignored instead of breaking the parse", () => {
    const args = parseArgs(["logs", "--lines", "zero"]);
    assert.equal(args.lines, undefined);
    assert.deepEqual(args.accounts, ["zero"]);
  });
});

describe("VERSION", () => {
  test("matches package.json — `npm run version:sync` fixes it", async () => {
    // The constant is a literal, so it can drift from the version a release
    // writes. semantic-release syncs it in its prepare step; this is the guard
    // for every edit in between, where `--version` would otherwise lie.
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
    ) as { version: string };
    assert.equal(VERSION, pkg.version);
  });
});
