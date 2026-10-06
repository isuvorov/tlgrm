import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { BIN_NAME, ENV_PREFIX } from "../constants.ts";
import {
  stripCommentKeys,
  toEnvironment,
  type UserConfig,
  userConfigSchema,
} from "./schema.ts";

export const CONFIG_ENV = `${ENV_PREFIX}_CONFIG`;

/** `$TLGRM_CONFIG`, then the XDG config dir — the same place `gh` or `starship` use. */
export function configPath(
  home: string = homedir(),
  env: Record<string, string | undefined> = process.env,
): string {
  const explicit = env[CONFIG_ENV];
  if (explicit) return explicit;
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), BIN_NAME, "config.json");
}

export function parseUserConfig(text: string, path: string): UserConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${String(error)}`);
  }
  const result = userConfigSchema.safeParse(stripCommentKeys(raw));
  if (!result.success) {
    throw new Error(`${path} is invalid:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export interface AppliedConfig {
  path: string;
  /** The file was there and parsed. */
  loaded: boolean;
  /** Env names that took their value from the file — see appliedKeys(). */
  keys: string[];
  warnings: string[];
}

/**
 * Copy the file into `process.env`, never over a variable the environment
 * already has: flags > env > file > .env > defaults. Everything downstream
 * keeps reading `process.env` and needs to know nothing about a config file.
 */
export function applyUserConfig(
  env: Record<string, string | undefined> = process.env,
  path: string = configPath(homedir(), env),
): AppliedConfig {
  const applied: AppliedConfig = { path, loaded: false, keys: [], warnings: [] };
  if (!existsSync(path)) return applied;

  const config = parseUserConfig(readFileSync(path, "utf-8"), path);
  applied.loaded = true;

  // Same rule as ssh: a file holding a bearer token and an api hash must not be
  // readable by anyone else on the machine.
  const mode = statSync(path).mode & 0o777;
  if (mode & 0o077) {
    applied.warnings.push(
      `${path} is readable by other users (mode ${mode.toString(8)}) and holds credentials — run "chmod 600 ${path}".`,
    );
  }

  for (const { name, value } of toEnvironment(config)) {
    if (env[name]) continue;
    env[name] = value;
    applied.keys.push(name);
  }
  return applied;
}

let current: AppliedConfig | undefined;

/** Applied once per process, by `settings/autoload.ts` and nothing else. */
export function loadUserConfig(): AppliedConfig {
  current ??= applyUserConfig();
  return current;
}

/**
 * Which variables came from the config file rather than from the real
 * environment.
 *
 * `loadConfig()` needs the difference: a project `.env` is more specific than
 * one global file in `~/.config`, so for these names — and only these — the
 * `.env` value wins. Empty until an entry point has autoloaded, which is what
 * keeps the user's own config out of every test that reads `loadConfig()`.
 */
export function appliedKeys(): ReadonlySet<string> {
  return new Set(current?.keys ?? []);
}
