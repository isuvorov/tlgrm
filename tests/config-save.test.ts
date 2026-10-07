import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { saveUserConfig } from "../src/settings/load.ts";
import { fromEnvironment, toEnvironment } from "../src/settings/schema.ts";

describe("fromEnvironment", () => {
  test("is the inverse of toEnvironment", () => {
    const env = {
      TLGRM_PORT: "7718",
      TLGRM_TOKEN: "t0k",
      TLGRM_ACCOUNTS: "work personal",
      TELEGRAM_API_ID: "123",
      TELEGRAM_API_HASH: "abc",
      TELEGRAM_USE_WSS: "true",
    };
    const config = fromEnvironment(env);
    assert.deepEqual(config, {
      port: 7718,
      token: "t0k",
      accounts: ["work", "personal"],
      telegram: { apiId: 123, apiHash: "abc", useWss: true },
    });
    const back = Object.fromEntries(toEnvironment(config).map((e) => [e.name, e.value]));
    assert.equal(back.TLGRM_ACCOUNTS, "work personal");
    assert.equal(back.TELEGRAM_API_HASH, "abc");
  });

  test("ignores empty and unrelated variables", () => {
    assert.deepEqual(
      fromEnvironment({ TELEGRAM_API_ID: "", PATH: "/bin", TLGRM_PORT: "x" }),
      {},
    );
  });
});

describe("saveUserConfig", () => {
  test("writes the environment over the existing file, owner-only", () => {
    const path = join(mkdtempSync(join(tmpdir(), "tlgrm-save-")), "config.json");
    writeFileSync(path, JSON.stringify({ port: 7000, telegram: { logLevel: "warn" } }));
    const saved = saveUserConfig({ TELEGRAM_API_ID: "42", TLGRM_TOKEN: "pin" }, path);
    const written = JSON.parse(readFileSync(path, "utf-8"));
    assert.equal(written.port, 7000);
    assert.equal(written.token, "pin");
    assert.deepEqual(written.telegram, { logLevel: "warn", apiId: 42 });
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(saved.keys.sort(), ["TELEGRAM_API_ID", "TLGRM_TOKEN"]);
  });
});
