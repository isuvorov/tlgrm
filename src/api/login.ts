import { spawn } from "node:child_process";
import { BIN_NAME } from "../constants.ts";
import { type Config, loadConfig, requireCreds } from "../utils/config.ts";
import {
  ensureAccountDir,
  nodeBin,
  packageCliPath,
  sessionPath,
} from "../utils/paths.ts";
import { probeOwner } from "./probe-owner.ts";

export interface LoginOptions {
  account: string;
  config?: Config;
}

export interface LoginResult {
  account: string;
  ok: boolean;
  message: string;
}

/**
 * QR login for an account, into its own session.
 *
 * Login has to own the connection itself, so no live owner may be around: a
 * fresh authorization into the same session conflicts with that owner's
 * auth_key. The check is conservative — on `unknown` it refuses, because
 * breaking the session costs more than asking the human to re-check.
 *
 * stdio is inherited: the QR code is printed to the terminal to be scanned.
 */
export async function login(options: LoginOptions): Promise<LoginResult> {
  const { account } = options;
  const config = options.config ?? loadConfig();
  requireCreds(config);

  const owner = await probeOwner({ account, config });
  if (owner.state !== "dead") {
    const how = `${BIN_NAME} stop ${account}`;
    return {
      account,
      ok: false,
      message: `account ${account}: owner is ${owner.state} (${owner.reason}). Stop it before logging in: ${how}`,
    };
  }

  const session = sessionPath(config, account);
  ensureAccountDir(config, account);

  console.log(`Account: ${account}`);
  console.log(`Session: ${session}`);
  console.log("Scan the QR in Telegram: Settings > Devices > Link Desktop Device.\n");

  const code = await new Promise<number>((resolvePromise) => {
    const child = spawn(nodeBin(), [packageCliPath(config), "login"], {
      stdio: "inherit",
      cwd: config.projectDir,
      env: {
        ...process.env,
        ...config.env,
        TELEGRAM_API_ID: config.apiId,
        TELEGRAM_API_HASH: config.apiHash,
        TELEGRAM_SESSION_PATH: session,
      },
    });
    child.on("close", (exitCode) => resolvePromise(exitCode ?? 1));
    child.on("error", () => resolvePromise(1));
  });

  return {
    account,
    ok: code === 0,
    message:
      code === 0 ? `session written to ${session}` : `login exited with code ${code}`,
  };
}
