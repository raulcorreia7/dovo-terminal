# dovo-terminal

[![CI](https://github.com/raulcorreia7/dovo-terminal/actions/workflows/ci.yml/badge.svg)](https://github.com/raulcorreia7/dovo-terminal/actions/workflows/ci.yml)

Dovo Studio in a terminal window. Same server, same tasks, same approvals —
no Electron and no browser.

You can browse every task with live status, watch a run stream (your
messages, the agent's replies, tool activity), answer approval and question
prompts, send follow-ups, stop a run mid-flight, and create tasks against any
project and agent the runtime knows.

## Requirements

- Node 22.19 or newer (`node --version`). There is no build step.
- A running Dovo runtime: the desktop app, a Dovo server, or a runtime from
  source — or none, for the built-in demo.

## Quick start

```sh
git clone https://github.com/raulcorreia7/dovo-terminal
cd dovo-terminal
corepack enable && pnpm install    # pnpm version comes from packageManager
pnpm link --global .               # installs the `dovo` command
dovo --demo                        # full app against a scripted runtime, offline
```

That opens the task list immediately. `?` shows all keys; `ctrl+q` quits.

### With a real Dovo runtime

```sh
dovo add studio http://127.0.0.1:3000 --token <your-token>
dovo --profile studio
```

Tokens come from Dovo: pair the device, or reuse the owner token from
`~/.dovo/owner-token` / `runtime-connection.json`. A dev runtime started from
the dovo-studio source is discovered automatically from `~/.dovo-dev` — no
profile or token needed:

```sh
dovo                # finds a running dev runtime on its own
```

Multiple runtimes can be saved; `--profile <name>` picks one, and the first
saved profile is the default.

## Commands

| command                             | effect                                            |
| ----------------------------------- | ------------------------------------------------- |
| `dovo`                              | connect (saved profile or discovered dev runtime) |
| `dovo --demo`                       | run against the scripted offline runtime          |
| `dovo --url <url> --token <t>`      | connect once, saving nothing                      |
| `dovo add <name> <url> --token <t>` | remember a runtime as a profile                   |
| `dovo token <t> [--profile p]`      | attach a token to a profile                       |
| `dovo serve [--port <n>]`           | expose the backend as an HTTP/WS server on :8790  |
| `dovo --server <url>`               | use a `dovo serve` that is already running        |

`--local` skips the local server hop entirely and uses the runtime in-process;
the TUI behaves identically on every route.

## Keys

| key       | what it does                                             |
| --------- | -------------------------------------------------------- |
| `↑` / `↓` | browse the list; typing filters it                       |
| `/`       | filter box (`esc` clears)                                |
| `enter`   | open a task / choose an item                             |
| `esc`     | back / dismiss                                           |
| `a`       | answer the pending approval or question                  |
| `n`       | new task: pick a project, then an agent, then write it   |
| `d` / `D` | archive (reversible) / delete (permanent) — both confirm |
| `r`       | refresh lists                                            |
| `ctrl+c`  | stop the running task (or go back)                       |
| `?`       | key reference                                            |
| `ctrl+q`  | quit                                                     |

## Troubleshooting

| symptom                             | fix                                                                                                |
| ----------------------------------- | -------------------------------------------------------------------------------------------------- |
| red dot, empty lists                | start the runtime, or point elsewhere: `dovo add studio http://host:port`                          |
| 401 or permission errors            | the token belongs to another runtime; pair again and `dovo token …`                                |
| connected, but list is empty        | the runtime has no projects yet; add one in Dovo desktop or web                                    |
| dev runtime not found               | check `ls ~/.dovo-dev`; `runtime-connection.json` missing means the server never finished starting |
| `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` | Node is older than 22.19; install a newer one                                                      |

## How it works

One typed interface (`RuntimeClient`) separates the TUI from the backend;
`openRuntime` decides whether a server hop exists, and the TUI cannot tell.
Every JSON boundary validates against a zod schema. The real client mirrors
Dovo's own protocol shape — wire schemas, the `/ws/sync` channel, snapshot
scopes, pure delta→view mapping — so deviations from the upstream API stay
confined to one auditable adapter.

- [docs/dovo-api-contract.md](docs/dovo-api-contract.md) — the upstream HTTP/WS contract, audited against dovo-studio.
- [docs/local-runtime-protocol.md](docs/local-runtime-protocol.md) — what this project's own server exposes and where it differs.

## Development

```sh
pnpm run verify        # lint + typecheck + tests + contract test + UI smoke
pnpm run smoke         # drive the real TUI headless against the demo runtime
pnpm test              # unit and client/server integration suites
pnpm run test:runtime  # check wire traffic against a fake Dovo server
```

Node ≥ 22.19 runs the TypeScript sources directly; the repo is the runtime —
there is no build. Every push and pull request runs `pnpm run verify` on
Node 22.19, 22.x, and 24.x ([.github/workflows/ci.yml](.github/workflows/ci.yml)).

## License and credits

This client's code is licensed under the MIT license — see
[LICENSE](LICENSE).

Dovo Studio — the runtime, its protocol, and the Dovo name — is the work of
[Dominic Vonk](https://github.com/DominicVonk) /
[dovocode/dovo-studio](https://github.com/dovocode/dovo-studio), with full
credit and thanks. Dovo carries no open-source license; all rights to it are
reserved by its author. This repository is an independent terminal client, is
not a fork, and contains no Dovo source code. Terminal rendering
(differential, flicker-free) is provided by
[pi-tui](https://github.com/earendil-works/pi/tree/main/packages/tui)
by Mario Zechner (MIT).
