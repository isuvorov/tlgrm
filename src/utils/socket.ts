import { connect } from "node:net";
import { PROBE_TIMEOUT_MS } from "../constants.ts";

/**
 * State of the connection owner — THREE values, and they must never be merged.
 *
 * `dead` is the only verdict that justifies killing a lock holder and starting
 * a daemon. `unknown` means "could not find out", and treating it as `dead`
 * kills a healthy daemon, causing exactly the outage this check exists to
 * prevent. The first version of this probe was a boolean and did just that.
 */
export type OwnerState = "alive" | "dead" | "unknown";

export interface ProbeResult {
  state: OwnerState;
  /** Human-readable reason behind the verdict; surfaces in status and doctor. */
  reason: string;
}

export interface ProbeSocketOptions {
  socketPath: string;
  timeoutMs?: number;
}

/**
 * Whether anyone answers on the unix socket — the only honest owner check.
 *
 * Why not the PID from the lock file: a process left over from a closed Claude
 * Code session still occupies its PID (`kill -0` succeeds) but no longer serves
 * the socket. Such a lock looks forever held by a live owner: the daemon never
 * starts and clients connect into the void.
 *
 * The check is valid for BOTH owner modes: master (stdio) and serve (daemon)
 * both open the socket through the shared startOwner() — master.js:176-184 in
 * the package.
 *
 * Side effect: a live daemon logs "client connected / client disconnected" on
 * every probe. That is the price of not guessing from a PID.
 */
export function probeSocket(options: ProbeSocketOptions): Promise<ProbeResult> {
  const { socketPath, timeoutMs = PROBE_TIMEOUT_MS } = options;

  return new Promise((resolvePromise) => {
    let settled = false;
    const socket = connect(socketPath);

    const finish = (state: OwnerState, reason: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolvePromise({ state, reason });
    };

    // Connection accepted but silent — the owner exists, it is merely busy.
    // That is not "dead".
    socket.setTimeout(timeoutMs, () =>
      finish("unknown", `no answer within ${timeoutMs}ms`),
    );

    socket.on("connect", () => finish("alive", "socket accepted the connection"));

    socket.on("error", (error: NodeJS.ErrnoException) => {
      switch (error.code) {
        case "ENOENT":
          return finish("dead", "no socket file");
        case "ECONNREFUSED":
          return finish("dead", "connection refused — nobody is listening");
        // EPERM/EACCES — a sandbox denied access to the socket (typical for the
        // Bash tool inside a Claude Code session). That says nothing about the
        // owner, so it must not count as death.
        case "EPERM":
        case "EACCES":
          return finish("unknown", `socket access denied (${error.code})`);
        default:
          return finish("unknown", `connect failed: ${error.code ?? error.message}`);
      }
    });
  });
}
