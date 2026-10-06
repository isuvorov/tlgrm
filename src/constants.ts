/**
 * The CLI name and everything derived from it.
 *
 * Renaming the tool means editing BIN_NAME here plus `bin` and `name` in
 * package.json — nothing else. Environment variable names and every hint
 * printed to the user are derived from this constant.
 */
export const BIN_NAME = "tlgrm";

/** Shown by `--version`; kept in step with package.json by hand. */
export const VERSION = "0.0.2";

/** Prefix for this tool's own environment variables. */
export const ENV_PREFIX = BIN_NAME.toUpperCase();

/** The supervised package whose CLI we run in serve mode. */
export const PACKAGE_NAME = "@overpod/mcp-telegram";

/** File names the supervised package keeps inside each account directory. */
export const SESSION_FILE = "session";
export const LOCK_FILE = "daemon.lock";
export const SOCKET_FILE = "daemon.sock";

/**
 * Mode for the account directory.
 *
 * The socket itself is chmod'ed to 0600 by the package, but the directory it
 * sits in must not be world-readable either: it also holds the MTProto session
 * file, which is a full account credential.
 */
export const ACCOUNT_DIR_MODE = 0o700;

/**
 * The node binary used to run an owner. An absolute path is preferred over a
 * shimmed one so the child does not depend on how PATH happens to be set.
 */
export const NODE_BIN = "/opt/homebrew/bin/node";

/** Fallback node locations, used when NODE_BIN is missing. */
export const NODE_FALLBACKS = ["/usr/local/bin/node", "/usr/bin/node"];

/** How long to wait for the owner's socket before reporting "can't tell". */
export const PROBE_TIMEOUT_MS = 2000;

/** Budget for a graceful SIGTERM stop, after which SIGKILL follows. */
export const TERMINATE_TIMEOUT_MS = 10_000;

/** How long to wait for a live socket after starting an owner in the background. */
export const START_TIMEOUT_MS = 15_000;

/** Default port of the HTTP + MCP-over-HTTP server started by `serve`. */
export const DEFAULT_PORT = 7717;

/**
 * The server binds to loopback only by default: it drives Telegram accounts,
 * so it has no business being reachable from the network unless asked.
 */
export const DEFAULT_HOST = "127.0.0.1";
