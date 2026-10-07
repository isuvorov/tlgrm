# 📡 tlgrm

[![LSK.js](https://github.com/lskjs/presets/raw/main/docs/badge.svg)](https://github.com/lskjs)
[![Platform](https://img.shields.io/badge/platform-macOS-lightgrey.svg?logo=apple&logoColor=white)](#limitations)
[![Node](https://img.shields.io/badge/node-%3E%3D23.6-green.svg)](https://nodejs.org)
[![NPM version](https://badge.fury.io/js/tlgrm.svg)](https://www.npmjs.com/package/tlgrm)
[![NPM downloads](https://img.shields.io/npm/dw/tlgrm.svg)](https://www.npmjs.com/package/tlgrm)
[![Write us in Telegram](https://img.shields.io/badge/write%20us-0088CC?logo=telegram&logoColor=white)](https://t.me/isuvorov)

<div align="center">
  <h3><p><strong>📡 Run the Telegram connection owner in your terminal — start it, read the logs, Ctrl+C and it is gone 📡</strong></p></h3>
</div>

<img src="https://raw.githubusercontent.com/isuvorov/tlgrm/main/docs/logo.png" align="right" width="200" height="200" alt="tlgrm logo" />

**▶️ One command** — `tlgrm serve` brings up an owner per account and streams their logs <br/>
**👻 `daemon`** — `tlgrm daemon start|up|stop`: the server as a launchd LaunchAgent, up at login and after a crash <br/>
**🧟 Orphan detection** — finds the dead-but-locked owner that silently blocks an account <br/>
**🚦 Three-state liveness** — `alive` / `dead` / `unknown`, so a sandboxed probe never kills a healthy owner <br/>
**🩺 `doctor`** — names every real misconfiguration and how to fix it <br/>
**🎨 Coloured, prefixed output** — two accounts in one stream stay tellable apart <br/>
**📦 JS/TS API** — every operation is a typed function taking one options object <br/>
**🔑 Credential separation** — keys live only where the owner runs, never in the client <br/>

---

## What this is, and what it is not

`tlgrm` **supervises**; it is not a Telegram client. The Telegram tools themselves — messages, media, reactions, polls — come from [`@overpod/mcp-telegram`](https://www.npmjs.com/package/@overpod/mcp-telegram), which wraps GramJS/MTProto.

It exists because that package's connection owner dies with the editor session that started it and leaves a lock behind that blocks the account.

---

## Installation

```bash
npm i -g tlgrm
tlgrm login <account>
```

From a checkout — node runs the TypeScript sources directly since 23.6, the build to `lib/` is only for the published package:

```bash
pnpm install
cp .env.example .env          # fill in TELEGRAM_API_ID / TELEGRAM_API_HASH
node src/cli.ts login <account>
npm run link                  # optional: builds lib/ and puts `tlgrm` on PATH
```

---

## Usage

```bash
tlgrm serve                       # owners for every account, logs on screen, Ctrl+C stops them
tlgrm serve work                  # just one account
npm run dev:server                # the same, restarted on file changes

tlgrm status                      # who owns the connection
tlgrm doctor                      # diagnosis and fixes
tlgrm logs -n 40                  # tail an owner log after the fact
tlgrm orphans                     # package processes and their lock files
tlgrm login <account>             # QR login
tlgrm info                        # versions, session base, discovered accounts

tlgrm start|stop [account ...]    # background owner, when you do want it detached
tlgrm daemon start|up|stop|status # `server` under launchd: survives logout, crashes and reboots
```

Flags: `--json`, `--lines N` / `-n N`, `--no-color`, `--version`.

`serve` is the normal mode. The owners are child processes of that command: their output is its output and Ctrl+C takes them down with it. Nothing survives the terminal — to keep it running, use `tlgrm daemon start`: the same `server` as a launchd LaunchAgent (`~/Library/LaunchAgents/com.tlgrm.server.plist`), started at login and restarted after a crash, logging to `~/.local/share/tlgrm/logs/daemon.log`. `daemon up` rewrites the plist and restarts it (after an update or `link`), `daemon stop` stops it and removes the plist. Pin `token` in the config first, or every restart drops your MCP clients.

`start` / `stop` exist for the detached case: `start` spawns an owner and returns, `stop` signals it. No supervisor watches it, so after a crash you start it again yourself.

Without a terminal — output redirected to a file, cron, `nohup` — `serve` logs one `started` line (version, pid, URL, accounts, config file) and one `stopped` line when a signal arrives, instead of the banner and the live request box. A log file is read for what happened and when, and the banner carries the token in a pasteable config.

### As an MCP server

One channel for everything: the Telegram tools and the supervision tools on the
same server, with the account chosen per call.

**Over stdio:**

```json
{
  "mcpServers": {
    "tlgrm": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/path/to/tlgrm/src/cli.ts", "mcp"]
    }
  }
}
```

**Over HTTP, token in a header** — the form to prefer, and what `serve` prints
alongside the URL:

```json
{
  "mcpServers": {
    "tlgrm": {
      "type": "http",
      "url": "http://127.0.0.1:7717/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

**Over HTTP, token in the URL** — for clients that cannot set headers (browsers,
ChatGPT connectors), using the URL `serve` prints:

```json
{
  "mcpServers": {
    "tlgrm": { "type": "http", "url": "http://127.0.0.1:7717/mcp/auth/<token>" }
  }
}
```

The header form keeps the token out of the URL, out of shell history and out of
every log that records paths — `maskSecrets()` has to redact `/mcp/auth/<token>`
precisely because the path form leaks it otherwise.

That is 174 tools: 168 from the supervised package plus six of our own
(`telegram-daemons-status`, `-doctor`, `-orphans`, `telegram-daemon-start`,
`-stop`, `-logs`).

**Choosing the account.** Every proxied Telegram tool takes an extra optional
`account` argument, and the handler routes the call to that owner's socket:

```jsonc
{ "name": "telegram-send-message",
  "arguments": { "account": "work", "chatId": "me", "text": "hi" } }
```

With one account logged in the argument can be omitted. With several, omitting
it fails with the list of names rather than guessing — and `TLGRM_ACCOUNT` sets
a default if you would rather not repeat it.

The package's own tools carry no account dimension, which is why it needs one
server entry per account. We replace their handlers anyway, so adding the
parameter is the same edit — one entry covers every account.

### Using the package directly instead

If you would rather skip this wrapper on the client side, register the
supervised package itself — with **no credentials** and pointing at the copy
this repo pins:

```json
{
  "mcpServers": {
    "telegram-work": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/path/to/tlgrm/node_modules/@overpod/mcp-telegram/dist/cli.js"],
      "env": { "TELEGRAM_SESSION_PATH": "/Users/<you>/.mcp-telegram/work/session" }
    }
  }
}
```

- **The pinned path, not `npx`.** npx needs the network on every spawn and
  drifts from the version the owner runs; owner and client speak a private IPC
  protocol, so a mismatch breaks every tool call.
- **No `TELEGRAM_API_ID` / `TELEGRAM_API_HASH`.** Without them the process
  cannot become a working owner — `requireCreds()` exits — which is what keeps
  the connection in the owner you started.
- **One entry per account**, since those tools take no account argument.

A file inside this project cannot be `command`: a session sandboxed to another
folder fails to execute it with `EPERM` on `posix_spawn`. Passing it to an
interpreter as an *argument* works, which is the form above.

### As a JS/TS library

```ts
import { getStatus, serveAccounts, doctor } from './src/api.ts';

const status = await getStatus({ account: 'work' });
if (status.health === 'orphaned') await serveAccounts({ accounts: ['work'] });

const report = await doctor();
```

---

## Configuration

Settings live in **`~/.config/tlgrm/config.json`** (`$XDG_CONFIG_HOME` is honoured, `TLGRM_CONFIG` points elsewhere). Every key is the JSON face of an environment variable the code already reads, so the file is optional — nothing needs it.

```json
{
  "$schema": "https://unpkg.com/tlgrm/config.schema.json",
  "port": 7717,
  "token": "pin-it-so-clients-survive-a-restart",
  "account": "work",
  "telegram": {
    "apiId": 1234567,
    "apiHash": "0123456789abcdef0123456789abcdef"
  },
  "_note": "a key starting with _ or // is a comment: this one is ignored"
}
```

The `$schema` line gives editors completion and inline docs for every setting. JSON has no comments, so a key prefixed with `_` or `//` is treated as one — that is how a section gets switched off (`"_telegram": {...}`) without deleting it. Any *other* unknown key is still a typo and still an error.

**Precedence:** flags → environment → project `.env` → `config.json` → defaults. Credentials belong in one of the last two; `chmod 600` the config file, and `tlgrm` says so if you have not.

| Variable | Purpose | Default |
|---|---|---|
| `TLGRM_CONFIG` | Path of the config file itself | `~/.config/tlgrm/config.json` |
| `TELEGRAM_API_ID` | Telegram app id — owner only | — |
| `TELEGRAM_API_HASH` | Telegram app hash — owner only | — |
| `TELEGRAM_SESSION_PATH` | Session base **directory** | `~/.mcp-telegram` |
| `TELEGRAM_2FA_PASSWORD` | Two-factor password for QR login | — |
| `TELEGRAM_USE_WSS` | Use WSS on 443 instead of port 80 | — |
| `TELEGRAM_PROXY_*` | MTProto / SOCKS proxy settings | — |
| `TELEGRAM_LOG_LEVEL` | `none` … `debug` | — |
| `TLGRM_ACCOUNTS` | Explicit account list | discovered |
| `TLGRM_ACCOUNT` | Default account for MCP tool calls | the only one, if there is one |
| `TLGRM_MCP_CONFIGS` | Colon-separated MCP configs for `doctor` to inspect | common paths |
| `TLGRM_PORT` / `TLGRM_HOST` | Where the HTTP + MCP surface binds | `127.0.0.1:7717` |
| `TLGRM_TOKEN` | Bearer token for that surface | generated per run |
| `TLGRM_LOG_DIR` | Where owner logs are written | `~/.local/share/tlgrm/logs` |

Accounts are **discovered**: every subdirectory of the session base holding a `session` file counts. Set `TLGRM_ACCOUNTS` (or `accounts`) to override.

`TELEGRAM_USE_WSS` and `TELEGRAM_PROXY_*` cannot be combined: GramJS does not support SSL over a proxy and silently prefers the proxy.

`tlgrm info` prints which config file was read, the session base and the log base — the first thing to check when a setting looks ignored.

Logs land in `~/.local/share/tlgrm/logs/<account>/serve.log`, outside the checkout. `tlgrm logs` still reads the pre-XDG `<repo>/.sessions/<account>/serve.log` while nothing newer exists, so old history stays reachable.

---

## How it works

An MTProto session can have **exactly one connection owner**. Two owners on one session get `AUTH_KEY_DUPLICATED`, and an owner started inside an editor dies with it.

| Role | Who | What it holds |
|---|---|---|
| **Owner** (`serve`) | child of `tlgrm serve` | the single Telegram connection; listens on `<base>/<account>/daemon.sock` |
| **Client** | process spawned by your AI client | nothing; proxies calls over IPC and dies with the session |

The role is chosen once at startup, from whether `daemon.lock` is held by a live owner.

### The orphaned owner

A process started without a live owner becomes the owner. When the editor closes, the package tries to exit via `stdin`-end (`master.js:232-235`); when that does not fire, the process keeps running with an open Telegram connection. Its PID stays in `daemon.lock`, `kill -0` on it succeeds, the package concludes the owner is alive, and every new client connects to a socket nobody serves. The account is blocked for good.

So a live owner is whoever **actually accepts connections on the socket**, never the PID in the lock file. The check is valid for both modes: `master` and `serve` both open the socket through the shared `startOwner()` (`master.js:176-184`).

| Verdict | Meaning | What is permitted |
|---|---|---|
| `alive` | socket accepted the connection | connect as a client |
| `dead` | no socket, or connection refused | take the owner down and start |
| `unknown` | EPERM, timeout, garbage in place of the socket | **touch nothing** |

`unknown` is not a formality. The probe also runs from sandboxed sessions where connecting to a unix socket is denied; treating that as `dead` kills a healthy owner. `reapStaleOwner` refuses to act without an explicit `dead`.

| Module | Responsibility |
|---|---|
| `src/api.ts` | Public API — re-exports every operation and type |
| `src/cli.ts` | CLI (`tlgrm`) |
| `src/mcp.ts` | MCP server (stdio) |
| `src/api/serve.ts` | Foreground owners, one child per account |
| `src/api/probe-owner.ts` | Who owns the connection |
| `src/api/get-status.ts` | Per-account verdict and advice |
| `src/api/start-daemon.ts` | Detached owner |
| `src/api/stop-daemon.ts` | Stop an owner |
| `src/api/reap-stale-owner.ts` | Release a poisoned lock |
| `src/api/list-orphans.ts` | Package processes in the system |
| `src/api/tail-logs.ts` | Owner log tail |
| `src/api/doctor.ts` | Aggregate diagnosis |
| `src/settings/*` | `~/.config/tlgrm/config.json` — schema, loader, autoload |
| `src/utils/*` | config, paths, proc, socket, logger, format |

**Deeper:** [`docs/architecture.md`](docs/architecture.md) — who spawns whom, the four channels between supervisor and owner, the `node --watch` restart race, and the trust model.

---

## API Reference

Every operation takes a single options object plus an optional `config`, so a caller can reuse an already-loaded `.env` (and substitute it in tests).

- `serveAccounts({ accounts?, tee? })` → exit code; foreground, resolves on Ctrl+C
- `probeOwner({ account, timeoutMs? })` → `{ state, reason, pid, socket, lock }`
- `getStatus({ account })` → `{ health, ownerState, pid, advice, … }`
- `listStatuses()` — `getStatus` for every discovered account
- `startDaemon({ account, timeoutMs? })` → `{ outcome, pid, message }`
- `stopDaemon({ account })` → `{ stopped, killed, message }`
- `reapStaleOwner({ account })` → `{ reaped, terminatedPid, reason }`
- `login({ account })` → `{ ok, message }`; inherits stdio for the QR code
- `listOrphans()` → `{ processes, owners, unclaimed }`
- `tailLogs({ account, lines? })` → `{ path, exists, lines }`
- `doctor({ mcpConfigs? })` → `{ accounts, orphans, findings }`

Also exported: `loadConfig`, `discoverAccounts`, `parseEnvFile`, `resolveSessionBase`, `probeSocket`, `pidExists`, `readLockPid`, `listPackageProcesses`.

---

## Examples

Fix an account that stopped responding:

```bash
tlgrm doctor          # names the problem and the fix
tlgrm serve work      # takes down an orphaned owner, then serves
```

Report unhealthy accounts from a cron job:

```bash
tlgrm status --json | node -e '
  let d = ""; process.stdin.on("data", c => d += c).on("end", () => {
    const bad = JSON.parse(d).filter(s => s.health !== "alive");
    if (bad.length) console.error(bad.map(s => `${s.account}: ${s.message}`).join("\n"));
  });'
```

---

## Tests

```bash
npm test          # node --test tests/
```

Covered: the `.env` parser, account discovery, PID liveness including the EPERM case, lock-file reading, argument parsing, colour handling, and `serveAccounts` end to end against a fake supervised package — spawn per account, prefixed output, SIGINT teardown.

Covered too: MCP over HTTP — a real `initialize` / `tools/list` / `tools/call` handshake against the running server.

Not covered: MCP over stdio (verified by hand) and the probe's `alive` branch (a sandbox cannot listen on a unix socket).

---

## Development

```bash
npm run build      # no bundling — parses every source with node --check
npm run check      # build + types + lint + test
npm run dev        # tests, re-run on change
npm run dev:server # serve, restarted on change
npm run fix        # biome check --write
npm run types      # tsc --noEmit

npm run config:schema # regenerate config.schema.json from the zod schema
npm run version:sync  # copy package.json's version into src/constants.ts
```

**CI** (`.github/workflows/`) runs on macOS with pnpm and node 24 — `lts/*` is too old to execute the TypeScript sources. `test.yml` runs build, lint, types and tests on every pull request to `main`; `release.yml` repeats them on push to `main` and then runs `semantic-release`.

Releases are version + CHANGELOG + GitHub release + npm publish of the `tsdown` build in `lib/`, authenticated by npm trusted publishing (OIDC, `id-token: write`) with provenance — no `NPM_TOKEN`. `semantic-release` is not a devDependency: it is fetched by `npx` in CI only, so `pnpm-lock.yaml` stays installable with `--frozen-lockfile`. Its prepare step runs `version:sync`, because `VERSION` in `src/constants.ts` is a literal and would otherwise drift from the released version — a test guards the same thing in between releases.

---

## Limitations

- **macOS only** in practice: process and path assumptions are mac-shaped.
- **node >= 23.6** — in a checkout the TypeScript sources run directly; the npm package ships the build in `lib/`.
- **Nothing survives the terminal.** `serve` is foreground by design; there is no supervisor that restarts an owner after a crash or a reboot.
- **The Telegram IPC socket has no authentication.** Access control is POSIX permissions alone: the socket is `0600`, the account directory `0700`. Any process running as the same user can issue tool calls against the account. That is the supervised package's design.
- **`npm run dev:server` can leave an account unserved.** The watcher restarts the supervisor without waiting for the old owners to finish shutting down, so the new one sees a still-answering socket and skips the account (`already owned by PID … — skipping`). Check `tlgrm status` after a restart that printed it — [details](docs/architecture.md#3-the-node---watch-restart-race).
- `tlgrm` and the owner must resolve the **same version** of the supervised package.

---

## License

No `LICENSE` file is shipped yet.

---

**tlgrm** — _start it, watch it, Ctrl+C_ 📡
