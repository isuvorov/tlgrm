import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { doctor } from "./api/doctor.ts";
import { listStatuses } from "./api/get-status.ts";
import { listOrphans } from "./api/list-orphans.ts";
import { startDaemon } from "./api/start-daemon.ts";
import { stopDaemon } from "./api/stop-daemon.ts";
import { tailLogs } from "./api/tail-logs.ts";
import { BIN_NAME, VERSION } from "./constants.ts";
import { registerTelegramTools } from "./telegram-tools.ts";
import { ACCOUNT_ENV, type Config, loadConfig } from "./utils/config.ts";

/**
 * The MCP tool registry, with no side effects on import.
 *
 * Kept separate from the stdio entry point on purpose: the HTTP transport also
 * needs these tools, and importing an entry point that starts a stdio server
 * would hijack the process.
 */
export interface CreateMcpServerOptions {
  config?: Config;
  /**
   * Account whose Telegram tools to expose. Defaults to the only discovered
   * account; with several, one must be named — the package's tools carry no
   * account dimension, so a server speaks for exactly one.
   */
  account?: string;
  /** Register supervision tools only, skipping the Telegram ones. */
  supervisionOnly?: boolean;
}

export async function createMcpServer(options: CreateMcpServerOptions = {}) {
  const config = options.config ?? loadConfig();
  const server = new McpServer({ name: BIN_NAME, version: VERSION });

  const accountArg = z.string().describe("Account name");
  const asText = (value: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  });

  server.registerTool(
    "telegram-daemons-status",
    {
      description:
        "Connection owner state for every account: alive, orphaned, stale lock or not running.",
      inputSchema: {},
    },
    async () => asText(await listStatuses({ config })),
  );

  server.registerTool(
    "telegram-daemons-doctor",
    {
      description:
        "Aggregate diagnosis: accounts, stray processes, client registration mistakes — and what to do about each.",
      inputSchema: {},
    },
    async () => asText(await doctor({ config })),
  );

  server.registerTool(
    "telegram-daemon-start",
    {
      description:
        "Start a detached owner for an account. Refuses to act when the owner state cannot be determined.",
      inputSchema: { account: accountArg },
    },
    async ({ account: name }) => asText(await startDaemon({ account: name, config })),
  );

  server.registerTool(
    "telegram-daemon-stop",
    {
      description: "Stop an account's owner.",
      inputSchema: { account: accountArg },
    },
    async ({ account: name }) => asText(await stopDaemon({ account: name, config })),
  );

  server.registerTool(
    "telegram-daemon-logs",
    {
      description: "Tail an account's owner log.",
      inputSchema: {
        account: accountArg,
        lines: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("How many lines, default 40"),
      },
    },
    async ({ account: name, lines }) =>
      asText(await tailLogs({ account: name, lines, config })),
  );

  server.registerTool(
    "telegram-daemons-orphans",
    {
      description:
        "Processes of the supervised package and how they relate to the lock files. Kills nothing.",
      inputSchema: {},
    },
    async () => asText(await listOrphans({ config })),
  );

  if (options.supervisionOnly) return { server, telegram: undefined };

  // One channel for every account: each Telegram tool takes an optional
  // `account` argument and the agent decides per call. Registering never fails
  // over account ambiguity — only a call that omits the account while several
  // exist does, and it says which ones are available.
  const telegram = await registerTelegramTools({
    server,
    config,
    defaultAccount: options.account,
  });
  return { server, telegram };
}
