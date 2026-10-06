import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BIN_NAME, ENV_PREFIX, SESSION_FILE } from "../constants.ts";
import { appliedKeys } from "../settings/load.ts";

/** Name of the variable holding the account list — derived from the CLI name. */
export const ACCOUNTS_ENV = `${ENV_PREFIX}_ACCOUNTS`;

/** Which single account an MCP server speaks for. */
export const ACCOUNT_ENV = `${ENV_PREFIX}_ACCOUNT`;

/** Where owner logs are written, when the default is not wanted. */
export const LOG_DIR_ENV = `${ENV_PREFIX}_LOG_DIR`;

export interface Config {
  /** Repository root; .env lives next to it. */
  projectDir: string;
  /** Session base directory, with one subdirectory per account. */
  sessionBase: string;
  /** Log base directory, with one subdirectory per account. */
  logBase: string;
  accounts: string[];
  apiId?: string;
  apiHash?: string;
  /** Everything read from .env — passed through to the daemon child process. */
  env: Record<string, string>;
  /**
   * Why .env could not be read, when the file exists. Not an error: the
   * credentials may well come from the environment instead,
   * but it is worth reporting in doctor.
   */
  envError?: string;
}

export interface LoadConfigOptions {
  projectDir?: string;
  /** Overrides process.env — for tests. */
  processEnv?: Record<string, string | undefined>;
  /** Which env names came from the config file — for tests; see appliedKeys(). */
  userConfigKeys?: ReadonlySet<string>;
}

/**
 * Parse .env with no dependencies: KEY=VALUE, `#` starts a comment, quotes are
 * stripped.
 *
 * Hand-rolled instead of dotenv for a reason: the npm registry is not reachable
 * from this machine's sandbox, and the format here is exactly what a human
 * types by hand.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Session base from TELEGRAM_SESSION_PATH.
 *
 * An easy trap: in this wrapper's .env the variable means a DIRECTORY, while
 * the supervised package expects a path to the session FILE. Only the base
 * lives here; paths.ts builds the file path by appending <account>/session.
 */
export function resolveSessionBase(value?: string): string {
  const base = value && value !== "" ? value : join(homedir(), ".mcp-telegram");
  return base.replace(/\/+$/, "");
}

/**
 * `~/.local/share/tlgrm/logs`, not a directory inside the repository.
 *
 * Logs used to land in `<repo>/.sessions/`, which tied a user's data to a
 * checkout: a second clone could not read them and `rm -rf` on the repo took
 * them with it. XDG_DATA_HOME is where everything else in this setup keeps
 * state, and `TLGRM_LOG_DIR` overrides it outright.
 */
export function resolveLogBase(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  const explicit = env[LOG_DIR_ENV];
  if (explicit && explicit !== "") return explicit.replace(/\/+$/, "");
  const data = env.XDG_DATA_HOME || join(home, ".local", "share");
  return join(data, BIN_NAME, "logs");
}

function defaultProjectDir(): string {
  // src/utils/config.ts -> src/utils -> src -> repository root
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/**
 * Accounts found on disk: every subdirectory of the session base that holds a
 * session file.
 *
 * Discovery rather than a hardcoded list — account names are personal data and
 * have no business sitting in the source tree, and a list in code drifts from
 * reality the moment someone logs in or out.
 */
export function discoverAccounts(sessionBase: string): string[] {
  if (!existsSync(sessionBase)) return [];
  try {
    return readdirSync(sessionBase, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => existsSync(join(sessionBase, name, SESSION_FILE)))
      .sort();
  } catch {
    // An unreadable base is not fatal: an explicit account argument still works.
    return [];
  }
}

export function loadConfig(options: LoadConfigOptions = {}): Config {
  const projectDir = options.projectDir ?? defaultProjectDir();
  const processEnv = options.processEnv ?? process.env;

  // An unreadable .env must not take every command down: permissions can drift
  // while the credentials still arrive from the environment. Throwing here
  // would lose both status and doctor — precisely the commands used to find
  // that kind of breakage.
  const envPath = join(projectDir, ".env");
  let fileEnv: Record<string, string> = {};
  let envError: string | undefined;
  if (existsSync(envPath)) {
    try {
      fileEnv = parseEnvFile(readFileSync(envPath, "utf-8"));
    } catch (error) {
      envError = (error as Error).message;
    }
  }

  // The environment wins over .env, so a caller and tests can override it —
  // except for a value the environment only has because ~/.config/tlgrm/config.json
  // was copied into it: a project .env is the more specific of the two, so for
  // those names it wins. Full order: flags > env > .env > config.json > defaults.
  const fromConfigFile = options.userConfigKeys ?? appliedKeys();
  const merged: Record<string, string> = { ...fileEnv };
  for (const [key, value] of Object.entries(processEnv)) {
    if (value === undefined) continue;
    if (fileEnv[key] !== undefined && fromConfigFile.has(key)) continue;
    merged[key] = value;
  }

  const sessionBase = resolveSessionBase(merged.TELEGRAM_SESSION_PATH);
  const logBase = resolveLogBase(merged);

  const accountsRaw = merged[ACCOUNTS_ENV];
  const accounts =
    accountsRaw && accountsRaw.trim() !== ""
      ? accountsRaw
          .split(/[\s,]+/)
          .map((a) => a.trim())
          .filter((a) => a !== "")
      : discoverAccounts(sessionBase);

  return {
    projectDir,
    sessionBase,
    logBase,
    accounts,
    apiId: merged.TELEGRAM_API_ID || undefined,
    apiHash: merged.TELEGRAM_API_HASH || undefined,
    env: fileEnv,
    envError,
  };
}

export function requireCreds(config: Config): void {
  if (!config.apiId || !config.apiHash) {
    throw new Error(
      `Missing TELEGRAM_API_ID / TELEGRAM_API_HASH (neither in the environment nor in ${join(config.projectDir, ".env")}). Template: cp .env.example .env`,
    );
  }
}
