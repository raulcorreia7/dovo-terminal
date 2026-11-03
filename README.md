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
pnpm install    # deps only; pnpm's version comes from packageManager
pnpm add -g ./packages/cli   # registers the dovo command globally
dovo --local    # connect to the Dovo runtime on this machine
```

`--local` uses the runtime in one process — no server hop. A dev runtime
started from the dovo-studio source is discovered automatically; for anything
else point at it explicitly under [Connecting](#connecting-to-a-real-dovo-runtime).
No runtime nearby? See the whole app offline with `dovo --demo`.

### Connecting to a real Dovo runtime

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

On the task list. Projects hold their tasks; fold one away and it stays out of the way.

| key       | what it does                                                                         |
| --------- | ------------------------------------------------------------------------------------ |
| `↑` / `↓` | move                                                                                 |
| `enter`   | open a task; on a project, fold or unfold it                                         |
| `←` / `→` | fold / unfold the project (`←` on a task folds its project)                          |
| `/`       | search every project (`esc` clears)                                                  |
| `n`       | new task: project, agent, model (if it has any), then write it                       |
| `d` / `D` | archive (reversible) / delete (permanent) — both confirm                             |
| `s`       | open a shell in the project's folder, on the machine it lives on                     |
| `o`       | open a web service the project is running (forwarded over ssh if remote)             |
| `m`       | machines: is everything working?                                                     |
| `t`       | choose a colour theme                                                                |
| `i`       | invite a device: shows a code, approve or deny who is waiting, revoke paired devices |
| `r`       | refresh                                                                              |
| `?`       | key reference                                                                        |
| `ctrl+q`  | quit                                                                                 |

In a task: `esc` goes back, `a` answers a pending approval, `ctrl+c` stops the run.

## Several machines

`dovo add <name> <url> --token <t> [--ssh user@host]` saves a machine. With
`--ssh` the terminal keeps an `ssh -L` tunnel to it for you. `dovo --all` opens
every saved machine as one workspace: project names carry the machine, e.g.
`website (laptop)`, and a task runs on the machine its project lives on. A machine
that is down is skipped instead of failing the others.

Machines can also be A2A workers (`--agent`), see below. Step-by-step setup is in
[docs/runbooks/personal.md](docs/runbooks/personal.md); running things unattended
is in [docs/runbooks/unattended.md](docs/runbooks/unattended.md).

## Checking and cleaning up

`m` in the terminal, or `dovo doctor` (exit 1 on a failure, for cron), checks each
machine (add `--deep` to also ask each expected agent a one-line question, which spends model budget): reachable, expected agents present (`"expect": ["codex","opencode"]` in
the config), tunnel up, A2A card reachable. `dovo prune --older 30d` lists archived
tasks older than that; add `--yes` to delete them. Deleting is per machine: `--yes` with `--all` is refused, name one with `--profile`.

## GitHub

Set `"github": true` in the config to show each project's pull request and
checks on its row (`PR #12 ✓`, `✗` failed, `…` running). It runs the `gh` CLI
in the project's folder, so it needs `gh` signed in and a local checkout. Off by
default; read-only.

## Other agents (A2A)

`dovo serve --a2a <port>` serves the runtime as an [A2A](https://a2a-protocol.org)
agent, using the official SDK. The agent card is public; every call that runs work
needs `Authorization: Bearer <token>` (`dovo a2a-token`, rotate with `--rotate`).
It listens on loopback only. Task state is kept in a database next to the config,
so a restart does not lose or duplicate work, and `a2aAllow` in the config limits
which projects and agents callers may use.

`dovo orchestrate [port] --worker <name>` (or `--planner <profile>`) serves an
**orchestrator**: send it a goal and it plans steps, runs them on your saved A2A
workers (`dovo add <name> <url> --agent --token <t>`), and reports one result.
It never answers an approval for you and does not retry a failed step. Its plan and each step are saved as it goes, so if the orchestrator restarts, sending the same goal again carries on where it stopped.

## Changing keys

List keys can be replaced in the config by action name:

```json
{ "keys": { "new": "c", "archive": "x" } }
```

Actions: `new refresh theme invite search help archive delete unfold fold`. The
help screen (`?`) always shows the keys in effect.

## Teams notifications

Set `teamsWebhook` in `~/.config/dovo-terminal/config.json`, or the
`DOVO_TEAMS_WEBHOOK` environment variable, to an https Teams webhook URL. It
posts when a task needs your input and when a run finishes, from `dovo` and
`dovo serve`. Posting is best effort and never interrupts the app.

## Agents and models

The new-task screen lists every agent profile and every harness the runtime
reports as available — Codex, Claude, OpenCode, Pi and the rest of the
runtime's provider list. A harness that offers more than one model asks which
to use (`default` lets the harness choose); one without a catalog goes straight
to the prompt. What appears is decided by the runtime, so a harness the runtime
cannot drive does not show up here.

## Themes

`t` on the task list opens the picker; the choice is saved. `--theme <name>`
picks one for a single run. The default, `auto`, follows the terminal's
light/dark scheme.

Presets: Dovo and Dovo Light, Dracula, Nord, Gruvbox (dark, light), Solarized
(dark, light), Catppuccin (Mocha, Latte), Tokyo Night, One Dark, High Contrast,
and a colour-blind-safe Okabe-Ito palette. `NO_COLOR` turns colour off.

Your own themes are JSON files in `~/.config/dovo-terminal/themes/`; the file
name is the theme name. List only what differs from the theme it `extends`
(default `dovo`):

```json
{ "extends": "nord", "colors": { "accent": "#ff8800" } }
```

Roles: `text muted dim accent user ok warn error border code`, each `#rrggbb`.
A file with a misspelt role or a bad colour is skipped, and the status bar says so.

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

## Layout

A pnpm workspace. Design tokens and the UI's visual rules are in [DESIGN.md](DESIGN.md); the open architecture decision is in [docs/decisions](docs/decisions/0001-transport-and-control-plane.md). Each package lists its dependencies in its own
`package.json`; an import a package does not declare fails to resolve, so the
arrows below are enforced, not conventional.

| package             | owns                                                       | depends on       |
| ------------------- | ---------------------------------------------------------- | ---------------- |
| `packages/protocol` | wire schemas, sync frames, the `RuntimeClient` interface   | —                |
| `packages/client`   | adapters: real Dovo runtime, offline demo, server loopback | protocol         |
| `packages/server`   | the local runtime server for any `RuntimeClient`           | protocol         |
| `packages/tui`      | screens, transcript items, theme                           | protocol         |
| `packages/cli`      | the `dovo` command: config, wiring, smoke and integration  | all of the above |

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
