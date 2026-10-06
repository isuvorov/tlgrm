# Architecture: processes, channels, trust

Companion to [**How it works**](../README.md#how-it-works) in the README. That
section answers *what the roles are*; this one answers *who spawns whom*, *over
which wires they talk*, and *what actually protects the account*.

---

## 1. Who spawns what

Owners are spawned by this supervisor, never by the AI client. There are exactly
two spawn sites, and the difference between them is the whole foreground /
background story:

| | `serveAccounts()` — `src/api/serve.ts` | `startDaemon()` — `src/api/start-daemon.ts` |
|---|---|---|
| Trigger | `tlgrm serve` | `tlgrm start`, `POST /start?account=` |
| `detached` | no | **yes**, plus `child.unref()` |
| `stdio` | `["ignore", "pipe", "pipe"]` | `["ignore", logFd, logFd]` |
| Output goes to | this terminal, prefixed, teed to `<logBase>/<account>/serve.log` | straight into the log file |
| Lifetime | dies with the command | outlives its parent |
| Supervision | Ctrl+C takes everything down together | none; after a crash you start it again |

Both run the **supervised package's** CLI, not our code:

```js
spawn(nodeBin(), [packageCliPath(config), "serve"], { … })
```

`packageCliPath()` (`src/utils/paths.ts`) resolves the copy pinned in this
repo's `node_modules` first and a Homebrew-global install second. Owner and
client speak a private IPC protocol, so the two sides must be the same build —
see the [pinned-path note](../README.md#using-the-package-directly-instead).

`nodeBin()` prefers an absolute interpreter over whatever `PATH` happens to
hold, so a child does not inherit the shell's accidents.

The process tree under `tlgrm serve` with two accounts:

```
60683  node --watch src/cli.ts serve     ← watcher (only under `npm run dev:server`)
└ 75300  node src/cli.ts serve           ← supervisor: HTTP + MCP live HERE
  ├ 75301  mcp-telegram serve            ← owner, account A
  └ 75302  mcp-telegram serve            ← owner, account B
```

The HTTP and MCP surface is **not** a separate process: `startHttp()` runs in
the supervisor (`src/http.ts`), binds `127.0.0.1:7717` by default and walks
forward on `EADDRINUSE`. It dies with the command that printed its URL.

---

## 2. The four channels

Four independent wires, and they do not overlap. Confusing them is how the
earlier bugs happened.

| # | Channel | Direction | Carries | Where |
|---|---|---|---|---|
| 1 | `stdout` / `stderr` pipes | owner → supervisor | log lines | `serve.ts`, the `pipe()` helper |
| 2 | POSIX signals | supervisor → owner | `SIGTERM`, then `SIGKILL` after `TERMINATE_TIMEOUT_MS` | `serve.ts` `waitForShutdown()`, `utils/proc.ts` `terminate()` |
| 3 | **Unix socket** | any client → owner | every Telegram tool call | `<base>/<account>/daemon.sock` |
| 4 | `daemon.lock` | read-only hint | the owner's PID | `utils/proc.ts` `readLockPid()` |

### Channel 1 — log pipes

Lines are reassembled from chunks and emitted through `logAbove()`, never
`write()`: once the request box is drawn, a raw `println` from a child lands
inside the frame and smears it. Each line is also teed to
`<logBase>/<account>/serve.log` — `~/.local/share/tlgrm/logs/<account>/serve.log`
unless `TLGRM_LOG_DIR` says otherwise — because after the terminal closes the
file is the only record left. It used to be `<repo>/.sessions/`, which tied a
user's history to one checkout; `tailLogs()` still reads the old path while
nothing newer exists.

Off a terminal there is no box and no banner: `serve` logs a `started` event and,
on a signal, a `stopped` one (`formatEvent()` in `utils/logger.ts`). A file is
read for what happened and when, and the banner carries the token.

### Channel 2 — signals

`SIGTERM` is **forwarded deliberately** rather than letting children die with
the parent: the owner has a `gracefulExit` handler that disconnects from
Telegram, releases the lock and removes the socket. Skipping it leaves the next
run to clean up a poisoned lock. `SIGKILL` follows only after the graceful
budget, so a wedged owner cannot hold the terminal hostage.

### Channel 3 — the socket, and the point worth remembering

**The supervisor does not talk to its children as children.** Tool calls go
through the supervised package's own `IpcClient`, connecting to the socket
exactly the way an unrelated process would (`src/telegram-tools.ts`):

```js
new IpcClient({ connectFn: () => connect(socketPath(config, account)) })
```

Parenthood is irrelevant on this wire. That is precisely what lets **one**
process speak for **all** accounts: the package resolves the socket from
`TELEGRAM_SESSION_PATH` at call time, and overriding `connectFn` retargets it
per call. Hence the extra optional `account` argument on every proxied tool,
and hence a single MCP entry instead of one per account.

End to end, a tool call:

```
AI client
  → HTTP  127.0.0.1:7717/mcp/auth/<token>        (bearer / path token / cookie)
  → MCP server in the supervisor process
  → IpcClient
  → unix socket  ~/.mcp-telegram/<account>/daemon.sock
  → owner process
  → MTProto → Telegram
```

Clients are created lazily, cached per account, and dropped on disconnect
(`setOnDisconnect`), so a restarted owner is picked up without restarting the
supervisor.

### Channel 4 — the lock file is *not* a source of truth

Liveness is decided by whether the socket answers, never by the PID. The
three-state verdict and the reasoning behind it live in the README
([The orphaned owner](../README.md#the-orphaned-owner)). Two details worth
keeping in view here:

- `probeSocket()` maps `ENOENT` / `ECONNREFUSED` → `dead`, and
  `EPERM` / `EACCES` / timeout → `unknown`.
- `pidExists()` mirrors that asymmetry: `kill(pid, 0)` failing with `EPERM`
  means **alive but not ours to signal**, not dead. Treating it as dead deletes
  someone else's lock and starts a second owner — `AUTH_KEY_DUPLICATED`.

Side effect of an honest probe: a live daemon logs `client connected /
disconnected` on every `status`, `doctor` and `serve`. That is the price of not
guessing from a PID.

---

## 3. The `node --watch` restart race

Known, expected, and worth recognising on sight. Under `npm run dev:server`:

```
Restarting 'src/cli.ts serve'
alexgreekov    already owned by PID 72156 — skipping
myasinbro      already owned by PID 72157 — skipping
```

What happened, in order:

1. A file changed; the watcher sent `SIGTERM` to the supervisor.
2. `onSignal()` forwarded `SIGTERM` to the owners and gave them up to
   `TERMINATE_TIMEOUT_MS` to disconnect from Telegram cleanly.
3. **The watcher did not wait for the grandchildren.** It printed `Restarting`
   and started a fresh supervisor immediately.
4. The new supervisor probed the sockets. The old owners were still finishing
   their graceful shutdown, so the sockets still answered → verdict `alive` →
   `skipping`.

This is the duplicate-owner guard doing its job, not a failure: starting a
second owner on a live MTProto session is exactly the case the probe exists to
prevent.

**The consequence to watch for.** If an old owner finishes dying *after* the new
supervisor already skipped it, that account ends up with **no owner at all**
until the next restart. The accounts look configured, `serve` printed no error,
and nothing is serving them.

Mitigations, cheapest first:

- Run `serve` without `--watch` and restart it by hand when supervising for
  real; keep `--watch` for the HTTP/MCP layer only.
- Check `tlgrm status` after a restart that printed `skipping`.
- If this becomes a nuisance, retry the probe in `serveAccounts()` — on an
  `alive` verdict, re-probe a few times a second apart before giving up, so a
  dying owner is waited out instead of mistaken for a healthy one.

A related case with the same shape: if the supervisor is `SIGKILL`ed or crashes,
its owners are **not** detached but are reparented to `init` and keep running
with the Telegram connection open. They become the orphans that `tlgrm orphans`
lists and `reapStaleOwner()` clears — but only once the socket says `dead`.

---

## 4. Trust and security model

### What protects what

| Asset | Where | Protection | Worth knowing |
|---|---|---|---|
| MTProto session | `<base>/<account>/session` | file `0600`, base dir `0700` | **This file is full account access** — not a password, a ready key. No SMS, no 2FA prompt for whoever holds it |
| IPC socket | `<base>/<account>/daemon.sock` | file `0600` | No authentication whatsoever. Reaching the socket = all Telegram tools |
| API id / hash | `.env` | gitignored; passed only to owners | Clients get none, by design |
| HTTP surface | `127.0.0.1:7717` | bearer token, `timingSafeEqual` | `/`, `/favicon.ico`, `/health`, `/__up/*`, `/api`, `/auth` are open; they leak only route names |
| Browser session | cookie | `HttpOnly; SameSite=Strict` | Strict is what closes CSRF on `POST /start` and `/stop` |

### Done right, keep it that way

- **Loopback by default** (`DEFAULT_HOST`), because this surface drives Telegram
  accounts.
- **Token masked in logs** (`maskSecrets()` in `utils/logger.ts`). This matters
  more than it looks: the MCP transport carries the credential in the path
  (`/mcp/auth/<token>`), so an unmasked request log would write a working
  credential into a file.
- **Constant-time token comparison**, with the length check done separately
  because `timingSafeEqual` throws on mismatched buffers.
- **Killing requires an explicit `dead`** (`reapStaleOwner()`); `unknown` means
  hands off.
- **Session directory created `0700`** (`ensureAccountDir()`), not the `0755`
  that `mkdir -p` would give it.

### Known risks

1. **Any process running as you can read the session file** — a postinstall
   script, any agent with filesystem access. `0600` stops other users, not your
   own software. Property of the supervised package, inherited here.
2. **The socket has no auth.** Same blast radius as the session file, via a
   different door; POSIX permissions are the entire access control.
3. **`TLGRM_HOST=0.0.0.0` turns this into a public control panel** for your
   Telegram accounts — plain HTTP, no TLS, one bearer token. The default is
   correct; the knob is sharp.
4. **The token is regenerated on every start** unless `TLGRM_TOKEN` is set
   (`startHttp()`). Not a hole, but under `--watch` every restart invalidates it
   and breaks connected MCP clients. Pin it as `token` in
   `~/.config/tlgrm/config.json` — `applyUserConfig()` warns unless that file is
   `chmod 600`.
5. **Account subdirectories on disk may be `0755`** — the package creates them,
   and `ensureAccountDir()` only sets the mode when it creates the directory
   itself; it does not repair existing ones. The `0700` base is what saves this
   today. A `chmodSync` on the existing-directory path would be cheap insurance.
6. **Stray credentials at the base root.** A `session` / `daemon.lock` /
   `daemon.sock` trio directly in `<base>/` predates the per-account layout.
   `discoverAccounts()` ignores it, so it is invisible to every command here,
   but the file is still a live account credential. Audit it; delete it if it is
   a leftover.
7. **Deep coupling to the package's private surface** —
   `dist/client.js`, `dist/tools/index.js`, and patching
   `server._registeredTools`. Not a security issue but a hazard: the version is
   pinned and a breaking rename surfaces as a load error, yet every upgrade of
   `@overpod/mcp-telegram` is a de-mining exercise.

---

## 5. Invariants to preserve

Anything that changes the files above should still be true afterwards:

- `unknown` is never folded into `dead`. The first version of the probe was a
  boolean and killed healthy owners.
- Nothing is terminated, and no lock is deleted, without an explicit `dead`.
- `EPERM` from `kill(pid, 0)` means alive.
- No credential reaches a log line unmasked.
- The default bind address stays loopback.
- Owners receive `SIGTERM` before `SIGKILL`, so `gracefulExit` gets to run.
- One owner per MTProto session. Every guard here exists for this single
  sentence.
