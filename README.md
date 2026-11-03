# dovo-terminal

Dovo Studio in a terminal window. It is a full client for a running [Dovo Studio](https://github.com/dovocode/dovo-studio) runtime: same server, same tasks, no Electron and no browser.

With `dovo` you can:

- browse every task with its live status, in one filterable list
- open a task and watch the run stream: your messages, the agent's answers, tool activity
- answer approval and question prompts without leaving the keyboard
- send follow-ups, stop a run mid-flight, archive (`d`) or delete (`D`) tasks
- create tasks against any project and agent the runtime knows

## Requirements

- Node 22.19 or newer on the machine where you run `dovo`. Check with `node --version`. There is no build step.
- A running Dovo runtime: the desktop app, a Dovo server, or the runtime from source (below).

## Run

```sh
npm install -g .    # installs the dovo command
dovo                # finds the runtime, opens the task list
```

A green dot in the header means the runtime is reached. Nothing else to configure on the machine that runs the runtime.

### Getting a runtime

**Dovo desktop app.** Start Dovo Studio. Its runtime is discovered instantly.

**A Dovo server elsewhere.** Pair once, then keep the address in a profile:

```sh
dovo add studio http://10.0.0.5:8787
dovo token <device-token> --profile studio   # token from a pairing code (POST /api/pair/code) or the owner token
dovo --profile studio
```

After `dovo add`, plain `dovo` uses that profile.

**From the dovo-studio source.** Needs Node 24.11+, pnpm 12+, git:

```sh
git clone https://github.com/dovocode/dovo-studio
cd dovo-studio
pnpm install
```

On Linux the mobile package postinstall fails because it downloads iOS and Android binaries. If that happens, finish the install without scripts and build the assets the root script expects:

```sh
pnpm install --ignore-scripts
node scripts/prepare-pty.mjs && node scripts/build-browser-viewer.mjs && node scripts/build-mcp-apps.mjs
pnpm dev:api                     # builds the runtime packages
```

`pnpm dev:api` prints a Vite+ banner but does not start the API itself. If you want the server, run:

```sh
pnpm --filter @dovo/api dev      # prints: Dovo runtime listening on 127.0.0.1:8789
```

The dev runtime keeps data in `~/.dovo-dev` and prefers port 8789. Production uses `~/.dovo` and port 8787. `dovo` searches both.

## How the address and token are found

In order, first match wins:

1. `--url` and `--token` flags, for one run only
2. a saved profile (`dovo add`, `dovo token`; stored at `~/.config/dovo-terminal/config.json`)
3. the `DOVO_OWNER_TOKEN` or `DOVO_TOKEN` environment variable
4. local discovery: `runtime-connection.json` (the runtime publishes it when it binds a port) or an `owner-token` file in `$DOVO_DATABASE_PATH`'s directory, `$DOVO_DATA_ROOT`, `~/.dovo`, `~/.dovo/desktop`, `~/.dovo-dev`, or the desktop app's config directory

Discovery ignores connection files whose recorded pid is dead. All requests carry `Authorization: Bearer <token>`. Only `/health` is public.

## Keys

| key              | action                                                   |
| ---------------- | -------------------------------------------------------- |
| `↑` `↓`, or type | browse tasks, filter the list                            |
| `/`              | filter box (`esc` clears it)                             |
| `enter`          | open a task, choose an option                            |
| type + `enter`   | send a message to the open task                          |
| `a`              | answer the pending approval or question                  |
| `n`              | new task: pick project, agent, write the prompt          |
| `d`              | archive the selected task (reversible, restores in Dovo) |
| `D`              | delete the selected task permanently                     |
| `r`              | refresh lists                                            |
| `?`              | show all shortcuts                                       |
| `esc`            | back, dismiss                                            |
| `ctrl+c`         | stop the running task                                    |
| `ctrl+q`         | quit                                                     |

Status marks in the list: `●` running, `●` waiting for your answer, `○` idle, `✗` error. A run that pauses on an approval shows `press a to choose` in the task view.

## No runtime reachable

`dovo` still opens. The header shows the failing address. Press `r` when the server is up. To walk through the whole interface against a scripted fake runtime, with no server at all:

```sh
npm run demo
```

## Flags

```text
dovo [options]
dovo add <name> <url> [--token <token>]
dovo token <token> [--profile <name>]

  --url <url>        runtime address for this run
  --token <token>    device token for this run
  --profile <name>   use a saved runtime profile
  --demo             offline demo against a scripted runtime
  -h, --help         usage
```

## Troubleshooting

| symptom                             | fix                                                                                                 |
| ----------------------------------- | --------------------------------------------------------------------------------------------------- |
| header dot red, lists empty         | start the runtime, or point elsewhere: `dovo add studio http://host:port`                           |
| 401 or permission errors            | the token belongs to another runtime; generate a pairing code and run `dovo token ...`              |
| list empty but connected            | the runtime has no projects yet; add one in Dovo desktop or web, tasks need a repo and an agent     |
| dev runtime not found               | check `ls ~/.dovo-dev`; if `runtime-connection.json` is missing, the server never finished starting |
| `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` | Node is older than 22.19; install a newer one                                                       |

## Architecture

```text
TUI (tui/) ── RuntimeClient ── RemoteRuntime ── HTTP + /ws/sync ──┐
                        (the only seam; typed, validated)         │
                                                    local runtime server (server/)
                                                                  │
                                                    RuntimeClient again, backed by:
                                                    DovoRuntime ── real Dovo Studio
                                                    DemoRuntime ── scripted (client/demo.ts)
```

One interface (`RuntimeClient`), validated types (`protocol/`, zod at every
JSON boundary), and a local server that re-exposes any backend on loopback.
The TUI cannot tell whether a server hop exists; `openRuntime` decides that,
and `dovo serve` runs the server alone. The real client mirrors Dovo's own
shape: wire schemas (`client/dovo-wire.ts`), the `/ws/sync` channel
(`client/dovo-sync.ts`), snapshot scopes (`client/dovo-read.ts`), pure
snapshot/delta → view mapping (`client/dovo-map.ts`, `client/dovo-view.ts`);
the demo's scripted fiction is data in `client/demo-script.ts`. Deviations
from Dovo's wire format are confined to one adapter and documented in
[docs/local-runtime-protocol.md](docs/local-runtime-protocol.md); the audited
upstream contract is [docs/dovo-api-contract.md](docs/dovo-api-contract.md).

## Development

```sh
npm run verify        # typecheck + UI smoke test + runtime contract test
npm run typecheck     # tsc, strictest flags, src and test
npm run smoke         # drives the real TUI headless against a demo runtime
npm run test:runtime  # checks wire traffic against a fake Dovo server
npm test              # node:test suites: local server protocol + client/server integration
```

## Credits and maintainer

Dovo Studio — the runtime, the protocol this client speaks, and the Dovo name
— belongs to the [dovocode/dovo-studio](https://github.com/dovocode/dovo-studio)
project, which maintains it. This repository is an independent terminal client
for that runtime; it is not a fork and carries no Dovo source code. Terminal
rendering (differential, flicker-free) is provided by
[pi-tui](https://github.com/earendil-works/pi/tree/main/packages/tui).
