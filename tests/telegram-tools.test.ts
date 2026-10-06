import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createMcpServer } from "../src/mcp-server.ts";
import { loadConfig } from "../src/utils/config.ts";
import { setColor } from "../src/utils/logger.ts";

setColor(false);

interface RegisteredTool {
  inputSchema?: { shape?: Record<string, unknown> };
  handler: (args: Record<string, unknown>, extra?: unknown) => unknown;
}
interface Registry {
  _registeredTools: Record<string, RegisteredTool>;
}

const real = loadConfig();
const twoAccounts = { ...real, accounts: ["work", "personal"] };

describe("telegram tool registry", () => {
  test("exposes the package's tools, not just the supervision ones", async () => {
    // The failure this guards: a client connected and found only the six
    // supervision tools, which is indistinguishable from "this build has none".
    const { server, telegram } = await createMcpServer({ config: twoAccounts });
    const names = Object.keys((server as unknown as Registry)._registeredTools);

    assert.ok(telegram !== undefined);
    assert.ok(telegram.count > 100, `expected the full tool set, got ${telegram.count}`);
    assert.ok(names.includes("telegram-send-message"));
    assert.ok(names.includes("telegram-read-messages"));
    assert.ok(names.includes("telegram-daemons-status"));
  });

  test("every proxied tool takes an account argument", async () => {
    // One channel for all accounts: the agent picks per call instead of the
    // human wiring one server entry per account.
    const { server } = await createMcpServer({ config: twoAccounts });
    const registry = (server as unknown as Registry)._registeredTools;

    // Every one of them, not a hand-picked pair: the three tools the package
    // registers with no parameters at all (telegram-status, -login, -logout)
    // used to be skipped, which left them permanently asking for an account
    // they had no field to receive.
    const proxied = Object.keys(registry).filter(
      (name) => name.startsWith("telegram-") && !name.startsWith("telegram-daemon"),
    );
    assert.ok(proxied.length > 100);
    for (const name of proxied) {
      const shape = registry[name]?.inputSchema?.shape ?? {};
      assert.ok("account" in shape, `${name} has no account argument`);
    }
    // The original arguments survive the extension.
    assert.ok("chatId" in (registry["telegram-send-message"]?.inputSchema?.shape ?? {}));
  });

  test("supervision tools are left alone", async () => {
    const { server } = await createMcpServer({ config: twoAccounts });
    const shape =
      (server as unknown as Registry)._registeredTools["telegram-daemons-status"]
        ?.inputSchema?.shape ?? {};
    assert.ok(!("account" in shape));
  });

  test("an omitted account with several of them names the choices", async () => {
    const { server } = await createMcpServer({ config: twoAccounts });
    const tool = (server as unknown as Registry)._registeredTools[
      "telegram-get-chat-folders"
    ];
    assert.ok(tool);
    await assert.rejects(
      () => Promise.resolve(tool.handler({})),
      /name the account: one of work, personal/,
    );
  });

  test("an unknown account is rejected before any connection attempt", async () => {
    const { server } = await createMcpServer({ config: twoAccounts });
    const tool = (server as unknown as Registry)._registeredTools[
      "telegram-get-chat-folders"
    ];
    assert.ok(tool);
    await assert.rejects(
      () => Promise.resolve(tool.handler({ account: "nope" })),
      /unknown account "nope" — available: work, personal/,
    );
  });

  test("a parameterless tool routes by account like any other", async () => {
    // telegram-status, the regression this test exists for: the package
    // registers it with no parameters, so it used to reject every call with
    // "name the account" while offering no account field to name one in.
    const { server } = await createMcpServer({ config: twoAccounts });
    const tool = (server as unknown as Registry)._registeredTools["telegram-status"];
    assert.ok(tool);
    assert.ok("account" in (tool.inputSchema?.shape ?? {}));
    // Reaches the IPC step naming the account we passed, rather than failing
    // on a missing one.
    await assert.rejects(
      () => Promise.resolve(tool.handler({ account: "work" })),
      /owner of "work"/,
    );
  });

  test("a single account becomes the default, so the argument is optional", async () => {
    const { server, telegram } = await createMcpServer({
      config: { ...real, accounts: ["solo"] },
    });
    assert.equal(telegram?.defaultAccount, "solo");

    const tool = (server as unknown as Registry)._registeredTools[
      "telegram-get-chat-folders"
    ];
    assert.ok(tool);
    // Reaches the IPC step and fails there, naming the account — proof that the
    // default was applied rather than the call being rejected up front.
    await assert.rejects(() => Promise.resolve(tool.handler({})), /owner of "solo"/);
  });

  test("supervisionOnly keeps the server to the six local tools", async () => {
    const { server, telegram } = await createMcpServer({
      config: real,
      supervisionOnly: true,
    });
    const names = Object.keys((server as unknown as Registry)._registeredTools);
    assert.equal(telegram, undefined);
    assert.equal(names.length, 6);
  });
});
