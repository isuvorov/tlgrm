import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  discoverAccounts,
  loadConfig,
  parseEnvFile,
  resolveLogBase,
  resolveSessionBase,
} from "../src/utils/config.ts";

describe("parseEnvFile", () => {
  test("reads KEY=VALUE, skipping comments and blank lines", () => {
    const env = parseEnvFile(
      ["# a comment", "", "TELEGRAM_API_ID=123", "  TELEGRAM_API_HASH=abc  "].join("\n"),
    );
    assert.deepEqual(env, { TELEGRAM_API_ID: "123", TELEGRAM_API_HASH: "abc" });
  });

  test("strips both kinds of quotes", () => {
    const env = parseEnvFile(['A="double"', "B='single'"].join("\n"));
    assert.equal(env.A, "double");
    assert.equal(env.B, "single");
  });

  test("keeps = signs inside the value", () => {
    assert.equal(parseEnvFile("TOKEN=a=b=c").TOKEN, "a=b=c");
  });

  test("ignores lines without a key", () => {
    assert.deepEqual(parseEnvFile("=no-key\njust-text"), {});
  });
});

describe("resolveSessionBase", () => {
  test("defaults to ~/.mcp-telegram", () => {
    assert.equal(resolveSessionBase(undefined), join(homedir(), ".mcp-telegram"));
    assert.equal(resolveSessionBase(""), join(homedir(), ".mcp-telegram"));
  });

  test("trims trailing slashes: in .env this is a directory, not a file", () => {
    assert.equal(resolveSessionBase("/tmp/sessions/"), "/tmp/sessions");
    assert.equal(resolveSessionBase("/tmp/sessions///"), "/tmp/sessions");
  });
});

describe("resolveLogBase", () => {
  test("defaults under XDG_DATA_HOME, never inside the checkout", () => {
    // Logs in <repo>/.sessions tied a user's history to one clone of the repo.
    assert.equal(
      resolveLogBase({}, "/home/x"),
      join("/home/x", ".local", "share", "tlgrm", "logs"),
    );
    assert.equal(
      resolveLogBase({ XDG_DATA_HOME: "/data" }, "/home/x"),
      join("/data", "tlgrm", "logs"),
    );
  });

  test("TLGRM_LOG_DIR wins outright and keeps no suffix", () => {
    assert.equal(resolveLogBase({ TLGRM_LOG_DIR: "/var/log/tlgrm/" }), "/var/log/tlgrm");
  });
});

describe("loadConfig precedence", () => {
  test("a project .env beats a value that only came from the config file", () => {
    // Order: flags > env > .env > ~/.config/tlgrm/config.json > defaults. A global
    // file silently overriding the .env next to the code is the surprise this
    // guards against.
    const dir = mkdtempSync(join(tmpdir(), "tlgrm-precedence-"));
    writeFileSync(join(dir, ".env"), "TELEGRAM_API_ID=from-dotenv\n");

    const fromFile = loadConfig({
      projectDir: dir,
      processEnv: { TELEGRAM_API_ID: "from-config-json" },
      userConfigKeys: new Set(["TELEGRAM_API_ID"]),
    });
    assert.equal(fromFile.apiId, "from-dotenv");

    // The same value in the real environment still wins — only the config-file
    // provenance is demoted.
    const fromEnv = loadConfig({
      projectDir: dir,
      processEnv: { TELEGRAM_API_ID: "from-shell" },
      userConfigKeys: new Set(),
    });
    assert.equal(fromEnv.apiId, "from-shell");
  });
});

describe("discoverAccounts", () => {
  test("finds only directories that actually hold a session file", () => {
    // Discovery replaces a hardcoded list: account names are personal data and
    // a list in code drifts the moment someone logs in or out.
    const base = mkdtempSync(join(tmpdir(), "tlgrm-discover-"));
    mkdirSync(join(base, "with-session"));
    writeFileSync(join(base, "with-session", "session"), "x");
    mkdirSync(join(base, "empty-dir"));
    writeFileSync(join(base, "loose-file"), "x");

    assert.deepEqual(discoverAccounts(base), ["with-session"]);
  });

  test("missing base is not an error", () => {
    assert.deepEqual(discoverAccounts(join(tmpdir(), "tlgrm-does-not-exist")), []);
  });

  test("result is sorted, so output order is stable", () => {
    const base = mkdtempSync(join(tmpdir(), "tlgrm-discover-"));
    for (const name of ["zebra", "alpha", "middle"]) {
      mkdirSync(join(base, name));
      writeFileSync(join(base, name, "session"), "x");
    }
    assert.deepEqual(discoverAccounts(base), ["alpha", "middle", "zebra"]);
  });
});
