import { BIN_NAME, DEFAULT_HOST } from "../constants.ts";

export const MAX_PORT_ATTEMPTS = 10;

/**
 * Who, if anyone, holds a port.
 *
 * `ours` matters most: another instance on the same port is not an error to
 * crash on, it means the thing the user wanted is already running.
 */
export type PortOwner = "ours" | "other" | "free";

export async function probePort(
  port: number,
  host: string = DEFAULT_HOST,
): Promise<PortOwner> {
  try {
    const response = await fetch(`http://${host}:${port}/health`, {
      signal: AbortSignal.timeout(1000),
    });
    const data = (await response.json().catch(() => null)) as { name?: string } | null;
    return data?.name === BIN_NAME ? "ours" : "other";
  } catch {
    // Nothing answered. Either the port is free, or something is listening but
    // not speaking HTTP — `listen` settles that in a moment either way.
    return "free";
  }
}
