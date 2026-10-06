import { loadUserConfig } from "./load.ts";

/**
 * Side-effect import, first line of every entry point: the file has to be in
 * `process.env` before anything reads it, and `startHttp` reads the port and the
 * token straight out of the environment.
 */
try {
  for (const warning of loadUserConfig().warnings) console.error(`⚠  ${warning}`);
} catch (error) {
  // A broken config must not start a server with the wrong token — stop and say why.
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
