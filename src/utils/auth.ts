import { randomBytes, timingSafeEqual } from "node:crypto";
import { BIN_NAME, ENV_PREFIX } from "../constants.ts";

export const TOKEN_ENV = `${ENV_PREFIX}_TOKEN`;
export const PORT_ENV = `${ENV_PREFIX}_PORT`;
export const HOST_ENV = `${ENV_PREFIX}_HOST`;

/** A fresh bearer token, printed on startup when none was configured. */
export function generateToken(): string {
  return randomBytes(24).toString("base64url");
}

/**
 * Constant-time token comparison.
 *
 * Lengths are compared separately: timingSafeEqual throws on buffers of
 * different length instead of returning false.
 */
export function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function readBearer(header?: string | null): string | undefined {
  if (!header) return undefined;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim();
}

/**
 * Token embedded in the path, the way MCP-over-HTTP clients pass it.
 *
 * An MCP client configuration carries only a URL, with no place for a header,
 * so the transport URL is `/mcp/auth/<token>`.
 */
export function readPathToken(pathname: string): string | undefined {
  const match = pathname.match(/^\/mcp\/auth\/([^/]+)\/?$/);
  return match?.[1];
}

export const AUTH_COOKIE = `${BIN_NAME}_token`;

/** Reads one cookie without pulling in a parser — values here are base64url. */
export function readCookie(
  header: string | null | undefined,
  name: string,
): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return decodeURIComponent(part.slice(eq + 1).trim()) || undefined;
  }
  return undefined;
}

/** `Set-Cookie` for the browser session. HttpOnly: page JS can never read it back. */
export function authCookieHeader(
  token: string,
  maxAgeSeconds = 60 * 60 * 24 * 30,
): string {
  return `${AUTH_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Strict`;
}

export interface AuthCheck {
  ok: boolean;
  /** Reason for the rejection — for the log, not for the client. */
  reason?: string;
}

/**
 * This surface controls Telegram accounts, so the token is mandatory. It is
 * accepted as a bearer header, as the path segment used by MCP-over-HTTP, or
 * as the cookie the web client gets from `/auth`.
 *
 * The cookie exists because a browser cannot set an Authorization header on a
 * plain navigation — without it the web client would have to carry the token
 * in every URL, which puts a working credential in the history and the logs.
 */
export function checkAuth(options: {
  authorization?: string | null;
  cookie?: string | null;
  pathname?: string;
  expected?: string;
}): AuthCheck {
  const { authorization, cookie, pathname, expected } = options;
  if (!expected) return { ok: false, reason: `${TOKEN_ENV} is not set` };

  const provided =
    readBearer(authorization) ??
    (pathname ? readPathToken(pathname) : undefined) ??
    readCookie(cookie, AUTH_COOKIE);
  if (!provided)
    return { ok: false, reason: "no bearer header, cookie, or token in the path" };
  if (!tokenMatches(provided, expected)) return { ok: false, reason: "token mismatch" };
  return { ok: true };
}
