import { connect } from "node:net";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as zm from "zod/mini";
import { PACKAGE_NAME } from "./constants.ts";
import { ACCOUNT_ENV, type Config } from "./utils/config.ts";
import { socketPath } from "./utils/paths.ts";

/**
 * The supervised package's internals, imported by path.
 *
 * Its `exports` map only publishes `.`, `./service` and `./manifest`, so the
 * tool registry and the IPC client are reached through the file path instead.
 * That is a deliberate coupling to a private surface: the alternative is
 * reimplementing 181 tool schemas, and the version is pinned in this repo, so a
 * breaking rename shows up as a load error here rather than as silent drift.
 */
function packageModule(config: Config, file: string): string {
  return join(config.projectDir, "node_modules", PACKAGE_NAME, "dist", file);
}

interface IpcClientLike {
  connect(): Promise<boolean>;
  call(tool: string, args: unknown): Promise<unknown>;
  setOnDisconnect(cb: () => void): void;
}

interface RegisteredTool {
  inputSchema?: { shape?: Record<string, unknown> };
  handler: (args: Record<string, unknown>, extra?: unknown) => unknown;
}

export interface TelegramToolsResult {
  /** How many Telegram tools were registered. */
  count: number;
  /** Accounts the tools can address. */
  accounts: string[];
  /** Used when a call does not name an account. */
  defaultAccount?: string;
}

/**
 * Register the package's Telegram tools on our server, forwarding every call to
 * the owner of the account the call names.
 *
 * One MCP channel for every account. Each proxied tool gets an extra optional
 * `account` argument and the handler routes to that owner's socket, so an agent
 * picks the account per call instead of the human wiring one server entry per
 * account. With a single account the argument can be omitted entirely.
 *
 * The schema extension is what makes this possible: the package's own tools
 * have no account dimension, but we already replace their handlers, so adding
 * one parameter is the same edit.
 */
export async function registerTelegramTools(params: {
  server: McpServer;
  config: Config;
  /** Accounts to expose; defaults to every discovered one. */
  accounts?: string[];
  defaultAccount?: string;
}): Promise<TelegramToolsResult> {
  const { server, config } = params;
  const accounts = params.accounts?.length ? params.accounts : config.accounts;
  const defaultAccount =
    params.defaultAccount ??
    process.env[ACCOUNT_ENV] ??
    (accounts.length === 1 ? accounts[0] : undefined);

  const { IpcClient } = (await import(packageModule(config, "client.js"))) as {
    IpcClient: new (opts?: { connectFn?: typeof connect }) => IpcClientLike;
  };
  const { registerTools } = (await import(packageModule(config, "tools/index.js"))) as {
    registerTools: (server: McpServer, telegram: unknown) => void;
  };
  const { TelegramService } = (await import(
    packageModule(config, "telegram-client.js")
  )) as { TelegramService: new (apiId: number, apiHash: string) => unknown };

  // Credentials are not needed: the dummy service only supplies tool schemas,
  // and every actual call is forwarded to the owner that holds the connection.
  registerTools(server, new TelegramService(0, ""));

  // One client per account, connected on first use and dropped when its socket
  // closes, so a restarted owner is picked up without restarting us.
  const clients = new Map<string, IpcClientLike>();

  const ipcFor = async (account: string): Promise<IpcClientLike> => {
    const existing = clients.get(account);
    if (existing) return existing;

    const socket = socketPath(config, account);
    // The package resolves the socket from TELEGRAM_SESSION_PATH at call time.
    // Overriding connectFn targets the account we were asked for instead, so
    // one process can speak for all of them.
    const candidate = new IpcClient({
      connectFn: (() => connect(socket)) as unknown as typeof connect,
    });
    if (!(await candidate.connect())) {
      throw new Error(
        `cannot reach the owner of "${account}" at ${socket} — start it with \`tlgrm serve\``,
      );
    }
    candidate.setOnDisconnect(() => clients.delete(account));
    clients.set(account, candidate);
    return candidate;
  };

  const resolveAccount = (named: unknown): string => {
    if (typeof named === "string" && named !== "") {
      if (!accounts.includes(named)) {
        throw new Error(
          `unknown account "${named}" — available: ${accounts.join(", ") || "none"}`,
        );
      }
      return named;
    }
    if (defaultAccount) return defaultAccount;
    throw new Error(
      accounts.length === 0
        ? "no accounts found — run `tlgrm login <account>` first"
        : `name the account: one of ${accounts.join(", ")} (pass it as the "account" argument)`,
    );
  };

  const accountArg = zm.optional(
    zm.string().register(zm.globalRegistry, {
      description:
        accounts.length > 1
          ? `Which Telegram account to act as: ${accounts.join(", ")}`
          : "Which Telegram account to act as; optional while there is only one",
    }),
  );

  const registry = (
    server as unknown as { _registeredTools: Record<string, RegisteredTool> }
  )._registeredTools;

  let count = 0;
  for (const [name, tool] of Object.entries(registry)) {
    // Our own supervision tools run locally and already take an account where
    // it matters; only the package's go over IPC.
    if (!name.startsWith("telegram-") || name.startsWith("telegram-daemon")) continue;

    // A tool the package registered with no parameters at all — `telegram-status`,
    // `-login`, `-logout` — still needs the account dimension, and skipping it
    // here broke them twice over: the client saw no `account` field to fill, and
    // the SDK picks the calling convention from `inputSchema` at call time
    // (`handler(extra)` instead of `handler(args, extra)`), so the argument
    // could not have arrived even if it had been sent. Giving such a tool a
    // schema of its own fixes the advertisement and the convention together.
    const schema = tool.inputSchema;
    Object.assign(tool, {
      // zod 4 mini has no `.extend` method; the functional form is the API.
      inputSchema: schema
        ? zm.extend(schema as never, { account: accountArg })
        : zm.object({ account: accountArg }),
    });

    Object.assign(tool, {
      handler: async (args: Record<string, unknown> = {}) => {
        const { account, ...rest } = args;
        const target = resolveAccount(account);
        return (await ipcFor(target)).call(name, rest);
      },
    });
    count += 1;
  }

  return { count, accounts, defaultAccount };
}
