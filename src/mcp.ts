#!/usr/bin/env node
import "./settings/autoload.ts";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BIN_NAME } from "./constants.ts";
import { createMcpServer } from "./mcp-server.ts";
import type { Config } from "./utils/config.ts";

/**
 * MCP over stdio — what an MCP client spawns when it is given a command.
 *
 * Returns a promise that only settles when the transport closes. The caller
 * must await it: `tlgrm mcp` used to `import()` this module and return, and the
 * CLI's `process.exit` then killed the server before it answered a single
 * request — the handshake hung with an empty stdout.
 */
export async function serveStdio(options: { config?: Config } = {}): Promise<number> {
  const { server, telegram } = await createMcpServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[${BIN_NAME}] MCP server on stdio`);
  if (telegram) {
    const where =
      telegram.accounts.length === 0
        ? "no accounts yet"
        : `accounts: ${telegram.accounts.join(", ")}${
            telegram.defaultAccount ? ` (default ${telegram.defaultAccount})` : ""
          }`;
    console.error(`[${BIN_NAME}] ${telegram.count} Telegram tools — ${where}`);
  }

  return new Promise<number>((resolve) => {
    transport.onclose = () => resolve(0);
    process.on("SIGINT", () => resolve(0));
    process.on("SIGTERM", () => resolve(0));
  });
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  serveStdio()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
