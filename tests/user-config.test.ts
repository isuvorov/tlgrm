import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  applyUserConfig,
  CONFIG_ENV,
  configPath,
  parseUserConfig,
} from "../src/settings/load.ts";
import { configJsonSchema, toEnvironment } from "../src/settings/schema.ts";

function configFile(json: unknown, mode = 0o600): string {
  const dir = mkdtempSync(join(tmpdir(), "tlgrm-config-"));
  const path = join(dir, "config.json");
  writeFileSync(path, typeof json === "string" ? json : JSON.stringify(json));
  chmodSync(path, mode);
  return path;
}

describe("configPath", () => {
  test("XDG first, the conventional ~/.config second", () => {
    assert.equal(
      configPath("/home/x", {}),
      join("/home/x", ".config", "tlgrm", "config.json"),
    );
    assert.equal(
      configPath("/home/x", { XDG_CONFIG_HOME: "/cfg" }),
      join("/cfg", "tlgrm", "config.json"),
    );
  });

  test("TLGRM_CONFIG overrides both — this is what keeps tests off the real file", () => {
    assert.equal(
      configPath("/home/x", { [CONFIG_ENV]: "/tmp/other.json" }),
      "/tmp/other.json",
    );
  });
});

describe("parseUserConfig", () => {
  test("a valid file parses, with the $schema key allowed", () => {
    const config = parseUserConfig(
      JSON.stringify({ $schema: "./config.schema.json", port: 8080, token: "t" }),
      "x",
    );
    assert.equal(config.port, 8080);
    assert.equal(config.token, "t");
  });

  test("broken JSON names the file instead of throwing a bare SyntaxError", () => {
    assert.throws(
      () => parseUserConfig("{nope", "/cfg/config.json"),
      /\/cfg\/config\.json is not valid JSON/,
    );
  });

  test("an unknown key is a typo, not something to ignore silently", () => {
    assert.throws(() => parseUserConfig(JSON.stringify({ porr: 1 }), "x"), /invalid/);
  });

  test("a wrong type is rejected with the path to it", () => {
    assert.throws(
      () => parseUserConfig(JSON.stringify({ telegram: { apiHash: 7 } }), "x"),
      /telegram.*apiHash/s,
    );
  });

  test("_ and // prefixed keys are comments, at any depth", () => {
    // JSON has no comments: this is how a section gets switched off without
    // deleting it, and the schema still refuses a real typo.
    const config = parseUserConfig(
      JSON.stringify({
        "//": "my notes",
        _port: 9999,
        telegram: { _apiId: "off", apiHash: "h" },
      }),
      "x",
    );
    assert.equal(config.port, undefined);
    assert.equal(config.telegram?.apiHash, "h");
    assert.equal((config.telegram as Record<string, unknown>).apiId, undefined);
  });
});

describe("toEnvironment", () => {
  test("every setting becomes the variable the code already reads", () => {
    const entries = toEnvironment({
      port: 7000,
      token: "tok",
      accounts: ["work", "personal"],
      mcpConfigs: ["/a/b.json", "/c/d.json"],
      telegram: { apiId: 42, apiHash: "h", useWss: true },
    });
    const map = Object.fromEntries(entries.map(({ name, value }) => [name, value]));
    assert.equal(map.TLGRM_PORT, "7000");
    assert.equal(map.TLGRM_TOKEN, "tok");
    // Joined the way each reader splits it: accounts on whitespace, paths on ":".
    assert.equal(map.TLGRM_ACCOUNTS, "work personal");
    assert.equal(map.TLGRM_MCP_CONFIGS, "/a/b.json:/c/d.json");
    assert.equal(map.TELEGRAM_API_ID, "42");
    assert.equal(map.TELEGRAM_USE_WSS, "1");
  });

  test("useWss false leaves the variable unset — GramJS reads its presence", () => {
    const entries = toEnvironment({ telegram: { useWss: false } });
    assert.equal(entries.length, 0);
  });
});

describe("applyUserConfig", () => {
  test("a missing file is not an error", () => {
    const applied = applyUserConfig({}, "/nonexistent/tlgrm.json");
    assert.equal(applied.loaded, false);
    assert.deepEqual(applied.keys, []);
  });

  test("values land in the environment and are reported", () => {
    const path = configFile({ port: 7001, telegram: { apiHash: "h" } });
    const env: Record<string, string | undefined> = {};
    const applied = applyUserConfig(env, path);

    assert.equal(applied.loaded, true);
    assert.equal(env.TLGRM_PORT, "7001");
    assert.equal(env.TELEGRAM_API_HASH, "h");
    assert.deepEqual(applied.keys.sort(), ["TELEGRAM_API_HASH", "TLGRM_PORT"]);
  });

  test("never over a variable the environment already has", () => {
    // The file is the weakest source: a flag or an export must keep winning.
    const path = configFile({ port: 7001 });
    const env: Record<string, string | undefined> = { TLGRM_PORT: "9000" };
    const applied = applyUserConfig(env, path);

    assert.equal(env.TLGRM_PORT, "9000");
    assert.deepEqual(applied.keys, []);
  });

  test("a world-readable config holding credentials is called out", () => {
    const path = configFile({ token: "secret" }, 0o644);
    const applied = applyUserConfig({}, path);
    assert.equal(applied.warnings.length, 1);
    assert.match(applied.warnings[0] ?? "", /chmod 600/);
  });

  test("mode 600 draws no warning", () => {
    const applied = applyUserConfig({}, configFile({ token: "secret" }, 0o600));
    assert.deepEqual(applied.warnings, []);
  });
});

describe("config.schema.json", () => {
  test("is in step with the zod schema — regenerate with npm run config:schema", () => {
    const onDisk = readFileSync(
      new URL("../config.schema.json", import.meta.url),
      "utf-8",
    );
    assert.equal(onDisk, `${JSON.stringify(configJsonSchema(), null, 2)}\n`);
  });

  test("lets an editor accept the comment keys too", () => {
    // Without this an editor would underline "_port" as a forbidden property,
    // which is exactly the key a user reaches for to switch a setting off.
    const schema = configJsonSchema() as { patternProperties?: Record<string, unknown> };
    assert.ok(schema.patternProperties?.["^(_|\\/\\/)"]);
  });
});
