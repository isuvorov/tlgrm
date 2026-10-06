import { z } from "zod";
import { BIN_NAME, DEFAULT_HOST, DEFAULT_PORT, ENV_PREFIX } from "../constants.ts";

const port = z.number().int().min(1).max(65535);

/** `TLGRM_*` — this tool's own variables, all derived from the one constant. */
const ownEnv = {
  port: `${ENV_PREFIX}_PORT`,
  host: `${ENV_PREFIX}_HOST`,
  token: `${ENV_PREFIX}_TOKEN`,
  account: `${ENV_PREFIX}_ACCOUNT`,
  accounts: `${ENV_PREFIX}_ACCOUNTS`,
  mcpConfigs: `${ENV_PREFIX}_MCP_CONFIGS`,
  logDir: `${ENV_PREFIX}_LOG_DIR`,
} as const;

/**
 * `~/.config/tlgrm/config.json`. Every key is the JSON face of an environment
 * variable the code already reads, so `toEnvironment()` is the whole
 * integration — nothing downstream needs to know a file exists.
 *
 * The split mirrors who owns the name: `TLGRM_*` at the top level, and the
 * `TELEGRAM_*` variables the supervised package reads under `telegram`.
 */
export const userConfigSchema = z
  .object({
    $schema: z.string().optional().describe("JSON Schema for editor autocompletion"),
    port: port
      .optional()
      .describe(`HTTP + MCP port (${ownEnv.port}). Default ${DEFAULT_PORT}`),
    host: z
      .string()
      .min(1)
      .optional()
      .describe(`Interface to bind (${ownEnv.host}). Default ${DEFAULT_HOST}`),
    token: z
      .string()
      .min(1)
      .optional()
      .describe(
        `Bearer token for the HTTP API and MCP (${ownEnv.token}). Generated per run when unset`,
      ),
    account: z
      .string()
      .min(1)
      .optional()
      .describe(
        `Account an MCP call defaults to (${ownEnv.account}). Only needed with several`,
      ),
    accounts: z
      .array(z.string().min(1))
      .min(1)
      .optional()
      .describe(
        `Explicit account list (${ownEnv.accounts}), replacing discovery from the session base`,
      ),
    mcpConfigs: z
      .array(z.string().min(1))
      .min(1)
      .optional()
      .describe(`MCP client configs for \`doctor\` to inspect (${ownEnv.mcpConfigs})`),
    logDir: z
      .string()
      .min(1)
      .optional()
      .describe(
        `Where owner logs are written (${ownEnv.logDir}). Default ~/.local/share/${BIN_NAME}/logs`,
      ),
    telegram: z
      .object({
        apiId: z
          .union([z.string().min(1), z.number().int().positive()])
          .optional()
          .describe("Telegram app id (TELEGRAM_API_ID) — needed by the owner only"),
        apiHash: z
          .string()
          .min(1)
          .optional()
          .describe("Telegram app hash (TELEGRAM_API_HASH) — needed by the owner only"),
        sessionPath: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Session base DIRECTORY, one subdirectory per account (TELEGRAM_SESSION_PATH). Default ~/.mcp-telegram",
          ),
        twoFactorPassword: z
          .string()
          .min(1)
          .optional()
          .describe("Two-factor password for QR login (TELEGRAM_2FA_PASSWORD)"),
        useWss: z
          .boolean()
          .optional()
          .describe(
            "Connect over WSS on 443 instead of port 80 (TELEGRAM_USE_WSS). Cannot be combined with a proxy",
          ),
        logLevel: z
          .enum(["none", "error", "warn", "info", "debug"])
          .optional()
          .describe("GramJS log level (TELEGRAM_LOG_LEVEL)"),
      })
      .strict()
      .optional()
      .describe("Settings read by @overpod/mcp-telegram itself"),
  })
  .strict();

export type UserConfig = z.infer<typeof userConfigSchema>;

/**
 * JSON has no comments, so a key starting with `_` (or `//`, the npm
 * convention) is one: `"_telegram": {...}` switches a section off, `"_note":
 * "..."` explains a value. Any other unknown key is still a typo and still an
 * error — the schema stays strict.
 */
export const COMMENT_KEY = /^(_|\/\/)/;

export function stripCommentKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripCommentKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !COMMENT_KEY.test(key))
      .map(([key, inner]) => [key, stripCommentKeys(inner)]),
  );
}

/** Let editors accept the comment keys too, wherever the schema forbids unknown properties. */
function allowCommentKeys(node: unknown): void {
  if (!node || typeof node !== "object") return;
  const schema = node as Record<string, unknown>;
  if (schema.additionalProperties === false) {
    schema.patternProperties = { [COMMENT_KEY.source]: {} };
  }
  for (const inner of Object.values(schema)) allowCommentKeys(inner);
}

/**
 * One environment variable per setting.
 *
 * A list is joined the way the reader splits it: accounts on whitespace, MCP
 * config paths on `:`, since a path may contain a space but never a colon.
 */
export function toEnvironment(
  config: UserConfig,
): Array<{ name: string; value: string }> {
  const entries: Array<{ name: string; value: string }> = [];
  const add = (name: string, value: string | number | boolean | undefined) => {
    if (value === undefined) return;
    entries.push({ name, value: String(value) });
  };

  add(ownEnv.port, config.port);
  add(ownEnv.host, config.host);
  add(ownEnv.token, config.token);
  add(ownEnv.account, config.account);
  add(ownEnv.accounts, config.accounts?.join(" "));
  add(ownEnv.mcpConfigs, config.mcpConfigs?.join(":"));
  add(ownEnv.logDir, config.logDir);

  add("TELEGRAM_API_ID", config.telegram?.apiId);
  add("TELEGRAM_API_HASH", config.telegram?.apiHash);
  add("TELEGRAM_SESSION_PATH", config.telegram?.sessionPath);
  add("TELEGRAM_2FA_PASSWORD", config.telegram?.twoFactorPassword);
  // GramJS reads the presence of the variable, so `false` must leave it unset.
  if (config.telegram?.useWss) add("TELEGRAM_USE_WSS", "1");
  add("TELEGRAM_LOG_LEVEL", config.telegram?.logLevel);
  return entries;
}

/** What `config.schema.json` contains — generated, never hand-edited. */
export function configJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(userConfigSchema, { io: "input" });
  allowCommentKeys(schema);
  return {
    ...schema,
    $id: `https://unpkg.com/${BIN_NAME}/config.schema.json`,
    title: `${BIN_NAME} config`,
  };
}
