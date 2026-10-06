import { existsSync, readFileSync } from "node:fs";
import { type Config, loadConfig } from "../utils/config.ts";
import { legacyLogPath, logPath } from "../utils/paths.ts";

export interface TailLogsOptions {
  account: string;
  lines?: number;
  config?: Config;
}

export interface LogTail {
  account: string;
  path: string;
  exists: boolean;
  lines: string[];
}

export async function tailLogs(options: TailLogsOptions): Promise<LogTail> {
  const { account, lines = 40 } = options;
  const config = options.config ?? loadConfig();
  // The current path first; the pre-XDG one only when nothing was written to the
  // new place yet, so an old history stays readable without hiding a fresh log.
  const current = logPath(config, account);
  const legacy = legacyLogPath(config, account);
  const path = existsSync(current) || !existsSync(legacy) ? current : legacy;

  if (!existsSync(path)) {
    return { account, path, exists: false, lines: [] };
  }

  // These logs are tens of kilobytes; reading the whole file is cheaper than
  // shelling out to tail.
  const text = readFileSync(path, "utf-8");
  const all = text.split("\n");
  // The last element is whatever follows the final newline.
  if (all.at(-1) === "") all.pop();

  return { account, path, exists: true, lines: all.slice(-lines) };
}
