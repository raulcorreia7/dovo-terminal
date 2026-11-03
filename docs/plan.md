# Plan: one machine, many machines, one orchestrator

**Mode:** sequential · **Evidence boundary:** repository-informed. Nothing here has
been run against a live Dovo runtime or across real machines. This revision
follows an isolated two-reviewer adversarial review; its adjudication is in
[plan-review.md](plan-review.md).

## Goal and non-goals

**Goal.** Work on this machine; then across several machines; then hand a goal to
an orchestrator that spreads it over the machines and reports one result. The
terminal is the only control surface. Everything else is managed machinery that
works without attention.

**Non-goals.** A hosted service owned by this project. A new network protocol.
Replacing the Dovo runtime. Multi-tenant SaaS. A custom broker, VPN, or registry.

## Rules the whole plan obeys

1. **TUI first.** Every capability is reachable from the terminal UI. CLI
   commands (`doctor`, `prune`) are thin wrappers for cron, not a second surface.
2. **Loopback and multi-machine are one system.** A machine is a URL; `127.0.0.1`
   is a URL. With one machine nothing extra is needed (no ssh, mesh or token
   exchange). **Every step is validated twice: against one loopback machine and
   against two.** A multi-machine change that breaks the loopback path fails.
3. **Reuse before building.** ssh, a self-hosted mesh, the official A2A SDK,
   `gh`. Self-managed and simple beat feature-rich.
4. **Anything that can run code is authenticated, scoped, and on loopback by
   default.**
5. **The terminal knows only `RuntimeClient`.** New reach is an adapter.
6. **macOS and Linux, both, from the start.** Windows is out of scope. Every
   step is validated on both (CI runs a macOS and a Linux job), and nothing
   assumes `/proc`, `systemd` or GNU tool flags without a macOS equivalent named
   in the step. See "Platform notes".
7. **Unattended machinery reports; it does not ask.** Problems show as a status
   with a next step, never as a log to read.

## What exists today

| Capability                                                                                                                                                           | State                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| One machine, themes, project tree, harness and model choice, invite/devices, Teams notices, `gh` notes, key overrides                                                | Built, tested against the demo runtime only                                                                     |
| Several machines: `dovo --all`, managed `ssh -L` tunnels (`--ssh`), shell key (`s`), service click-through (`o`), Machines screen (`m`), `dovo doctor`, `dovo prune` | Built and unit-tested; the ssh and `lsof` paths were exercised with stubs, **not against real remote machines** |
| A2A worker (`dovo serve --a2a`): persistent state, message-id dedupe, allowlist, concurrency cap, stored and rotatable token                                         | Built and tested in-process                                                                                     |
| A2A client adapter (`--agent` profiles) with origin pinning                                                                                                          | Built and tested in-process                                                                                     |
| Orchestrator (`dovo orchestrate`): validated bounded plans, per-worker serialisation, hop limit, cancellation, never answers approvals                               | Built and tested with scripted and in-process workers                                                           |
| Runbooks                                                                                                                                                             | Written, **never run on a clean machine**                                                                       |
| S0: behaviour against a live Dovo runtime, and on macOS                                                                                                              | **Not done** (no runtime or Mac available while building)                                                       |

Known defects in what exists (confirmed by review, fixed in the named step):

- The A2A-task to Dovo-task map lives in memory, and nothing deduplicates a
  re-delivered message, so a restart or retry creates a second Dovo task (S4).
- Any caller with the token may name any `projectId` and `providerId` in message
  metadata (S4).
- A follow-up A2A message is sent as chat text; it cannot answer an approval, so
  an `input-required` task cannot be satisfied over A2A at all (S3, decision D6).
- The agent card advertises `http://<listen-host>:<port>`, declares no security
  scheme, and has no setting for a public base URL (S4).
- `cancelTask` reports `contextId: ""` and swallows a failed stop (S4).

## Decisions and assumptions

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                 | State                                                               |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| D1  | Reach between machines: ssh (`-L`, and `-R` from a worker behind NAT to a small VPS) first; a self-hosted mesh when a team joins or many machines sit behind NAT                                                                                                                                                                                                                                                                         | proposed                                                            |
| D2  | Orchestration protocol: A2A via `@a2a-js/sdk`                                                                                                                                                                                                                                                                                                                                                                                            | proposed                                                            |
| D3  | No registry service: workers are a list of agent-card URLs in the saved profiles                                                                                                                                                                                                                                                                                                                                                         | proposed                                                            |
| D4  | zod and WebSocket stay                                                                                                                                                                                                                                                                                                                                                                                                                   | measured, [ADR 0001](decisions/0001-transport-and-control-plane.md) |
| D5  | The orchestrator's planner is a Dovo harness running with read-only permission and no tools that change files                                                                                                                                                                                                                                                                                                                            | **unvalidated assumption**                                          |
| D6  | Approvals are answered only in the terminal. The orchestrator surfaces them and never answers one. Over A2A an approval is an explicit, typed message, not chat text                                                                                                                                                                                                                                                                     | proposed                                                            |
| D7  | One writer per project at a time: the orchestrator holds a lock per project and branch                                                                                                                                                                                                                                                                                                                                                   | proposed                                                            |
| D8  | A2A task store: SQLite through **Drizzle ORM** and `better-sqlite3` (WAL, one writer process per file, one store per process). Tables are TypeScript (`packages/a2a/src/schema.ts`); migrations are generated by `drizzle-kit`, not hand-written. Drizzle's drivers are swappable, so libSQL or Turso can replace the driver later without touching callers. Shared or multi-process storage means Postgres, which Drizzle also supports | built                                                               |
| A1  | Model-catalog, device and invite response shapes match what the client parses                                                                                                                                                                                                                                                                                                                                                            | **unvalidated**                                                     |
| A2  | The runtime's "available" harness flag means usable, not merely installed                                                                                                                                                                                                                                                                                                                                                                | **unvalidated**                                                     |
| A3  | The runtime may already expose the ports a task started (the contract mentions a `terminals` capability)                                                                                                                                                                                                                                                                                                                                 | **unknown, resolved in S0**                                         |

## Security model

| Threat                                                      | Control                                                                                                                                                                                  |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anyone who reaches a worker's A2A port runs agents          | Bearer token on every call except the public card; loopback by default; one token per worker, stored in the 0600 config; rotated by a command (S4)                                       |
| One shared bearer is owner-level everywhere                 | Per-worker allowlist of projects and providers; metadata outside it is ignored (S4)                                                                                                      |
| Token over plain HTTP between machines                      | Tokens cross machines only inside ssh or a mesh; the terminal refuses a non-loopback `http://` worker URL that is not behind either (S3)                                                 |
| Timing / guessing                                           | 24 random bytes; constant-time compare (built)                                                                                                                                           |
| A card's `url` points somewhere else                        | The client replaces the card's URL with the configured one before building the transport; a test feeds a hostile card (S3)                                                               |
| A worker's reply contains instructions for the orchestrator | Worker output is data. It is shown and summarised; it never becomes a planner instruction without a human step (D6, S5)                                                                  |
| Planner runs with broad rights                              | D5: read-only planner; its plan is validated and bounded before anything dispatches (S5)                                                                                                 |
| Secrets in the config (tokens, Teams webhook)               | Mode 0600 re-applied on every save (built); backup before overwrite (built); the A2A token is printed once at start and is never logged                                                  |
| Click-through becomes a port forwarder                      | Only ports the worker listed, re-checked at forward time (process id and start time); remote side must be loopback; local side binds `127.0.0.1` only (S2b)                              |
| A task serves attacker content on a local origin            | Forward is opened on demand, never automatically; the terminal shows process name, folder and port first (S2b)                                                                           |
| Shell key as an injection path                              | The ssh host comes only from the saved profile, never from runtime data; a value starting with `-` is rejected; the project path is shell-quoted; the command is passed after `--` (S2c) |
| Public exposure of the orchestrator                         | Only behind a reverse proxy with TLS; workers never directly                                                                                                                             |

## Platform notes (macOS and Linux)

| Concern                                  | Linux                                  | macOS                                                | Plan                                                                                                                                   |
| ---------------------------------------- | -------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Listening ports and their owners (S2b)   | `ss -ltnp`, `/proc`                    | no `/proc`; `lsof`                                   | Use `lsof -nP -iTCP -sTCP:LISTEN` and `lsof -p <pid> -d cwd` on both (check it exists on Linux, fall back to `ss`); no `/proc` parsing |
| ssh control socket path (S2)             | 108-byte socket path limit             | 104-byte limit                                       | `ControlPath` uses ssh's short hashed token (`%C`) under a short directory, never a long project path                                  |
| Opening a link (S2b)                     | `xdg-open`                             | `open`                                               | One function picks by `process.platform`; prints the URL when neither works or the terminal is remote                                  |
| Run unattended (S7)                      | systemd unit                           | launchd plist                                        | Runbooks give both with the same command line                                                                                          |
| Terminal features                        | varies                                 | Terminal.app has no OSC 8 links and only 256 colours | pi-tui already downgrades colour; the URL is always also shown as text                                                                 |
| Native dependency for the A2A store (S4) | prebuilt binaries                      | prebuilt for arm64 and x64                           | Verify prebuilds on both before choosing the driver                                                                                    |
| File permissions                         | POSIX                                  | POSIX                                                | Same 0600 handling                                                                                                                     |
| Config location                          | `~/.config`, honours `XDG_CONFIG_HOME` | `~/.config`                                          | One path on both (built); runtime discovery already checks macOS `Application Support`                                                 |

The test suite passes on macOS in CI (Node 22.19, 22, 24). What that does not
cover is `lsof`, `ssh` and the browser opener running on a real Mac against real
processes and machines; that remains unverified.

## Ordered steps

A step does not start before its dependencies are validated. Every step lists
**validation** as the single-machine run and the two-machine run (Rule 2).

### S0 — Ground the assumptions

- **Outcome:** Real responses from a live runtime for `agents/models`,
  `agents/availability`, devices, `pair/code`, and whether it exposes ports
  (A3), stored as fixtures with tokens and personal data redacted. A written
  answer to A2. Tolerant parsers replaced by exact schemas where shapes are known.
- **Owner:** `packages/client` (`test/runtime-contract.ts`, fixtures).
- **Depends on:** a running Dovo runtime and its owner token. **Fallback if none
  is available:** the steps below proceed against the demo runtime and are marked
  "unverified against Dovo" in their outcome.
- **Validation:** contract test passes against the fixtures; a redaction check
  fails the build if a fixture contains a token-shaped string.

### S1 — Machines screen and `dovo doctor`

- **Outcome:** A `Machines` view in the terminal showing, per machine,
  reachability, token, expected harnesses present, models listed, A2A card,
  tunnel, ports, GitHub, Teams and theme status. `dovo doctor` is the same checks
  for cron, non-zero exit on failure, naming the next step. `--deep` sends a
  one-line prompt per harness, is opt-in, and is never the default in a timer.
- **Owner:** `packages/cli` (`src/doctor.ts`), `packages/tui` (Machines screen).
- **Depends on:** S0.
- **Validation:** a stub client per pass/fail row; demo runtime run; wrong token
  and stopped runtime each give a named next step; one machine and two.

### S2 — Managed ssh tunnels

- **Outcome:** A profile may name `ssh: user@host`. The client starts
  `ssh -N -L` **with `ControlMaster=auto`, `ControlPath` and `ControlPersist`**,
  keepalive, reconnects with backoff, closes on exit, and refuses to start when
  the local port is taken. The status dot shows it. A worker behind NAT uses
  `-R` to a VPS.
- **Owner:** `packages/cli` (`src/tunnel.ts`), config schema.
- **Depends on:** nothing.
- **Validation:** stub spawner tests for start, drop, reconnect, port clash,
  exit; the host-value rule (no leading `-`); one manual run over real ssh.

### S2b — Click-through to running services

- **Outcome:** On a task or project row the terminal lists the web services its
  work folder serves (`:3000 vite`, `:8080 api`). One key opens one: this machine
  opens `http://127.0.0.1:<port>`; a remote machine over ssh first adds a
  forward for that single port through the control socket; a mesh opens the mesh
  address when the service listens there, else forwards. Links are also written
  as terminal hyperlinks (OSC 8). If the terminal itself runs over ssh or
  headless (`SSH_CONNECTION` set, no display), it prints the URL instead of
  trying to open a browser on the wrong machine.
- **Owner:** worker side `packages/server` (`GET /ports`, authenticated with the
  worker's token, reachable through the same tunnel as the runtime); client side
  `packages/client` (`RuntimeClient.listPorts`, optional) and `packages/cli`
  (forward and open); `packages/tui` (list and key).
- **Depends on:** S0 (A3: use the runtime's own port data if it has it), S2.
  For tasks started by the orchestrator, **S3**: the port list comes from the
  worker that ran the task.
- **Validation:** `/proc` join on fixture trees (including another user's
  process and a Docker-published port, both reported as unknown owner); a test
  that nothing outside the re-validated list can be forwarded; one machine and two.
- **Stated limits:** Linux workers and same-user processes only in the first
  version. A frontend hard-coded to `localhost:8080` works only if that local
  port is free; two machines that both serve `:3000` cannot both be forwarded to
  `:3000`: the second is reported as a clash, never remapped silently. Dev servers
  that check `Host` or bind only a non-loopback interface may refuse the tunnelled
  request.

### S2c — Shell key

- **Outcome:** A key on a project or task row opens an interactive shell **in
  that project's folder on that project's machine**, then returns to the same
  place in the terminal when the shell exits. On this machine it runs the user's
  `$SHELL`; on a remote machine it runs the system `ssh -t` through the S2 control
  socket, so it opens instantly and shares the tunnel.
- **Owner:** `packages/cli` (`src/shell.ts`); `packages/tui` (the key, and
  suspend/resume of the screen around the child process).
- **Depends on:** S2.
- **Validation:** unit tests for the quoting of paths containing spaces, quotes,
  `$`, backticks and newlines; a test that a host starting with `-` is rejected;
  a manual run local and over real ssh that the terminal state is restored after
  exit and after the shell is killed.

### S3 — A2A client adapter and approval path

- **Outcome:** A federation `Machine` that talks to a worker through the SDK's
  `ClientFactory`, mapping the `RuntimeClient` calls A2A can express and
  reporting the rest as unsupported (never silently empty). The card's URL is
  replaced by the configured one before connecting. A typed approval message
  (D6) so an `input-required` task can be answered from the terminal.
- **Owner:** `packages/a2a` (`src/client.ts`, executor handling of the approval
  message); federation uses it through `RuntimeClient` only.
- **Depends on:** S0; and O1 resolved (below), because the adapter can only offer
  what the orchestrator surface offers.
- **Validation:** in-process pair (adapter against the A2A server over the demo
  client): create, follow, cancel, input-required then approve, unreachable,
  hostile card; one machine and two.

### S4 — Worker hardening

- **Outcome:** A2A task state persists in SQLite through Drizzle (D8; its driver is a native
  dependency and must be chosen deliberately). The A2A-task to Dovo-task map and a
  message-id table are persisted **before** the Dovo task is created, or the
  create is keyed, so a crash cannot leave a duplicate. Per-worker allowlist of
  projects and providers. Card declares the bearer scheme and uses a configured
  public base URL. `cancelTask` reports the real context id and surfaces a failed
  stop. Concurrent-task cap, per-call timeout, request size limit. A token
  rotation command and a stored per-worker token.
- **Owner:** `packages/a2a`, `packages/cli` (rotation).
- **Depends on:** S3.
- **Validation:** restart test (task and mapping survive); duplicate-message
  test (one Dovo task); crash-between-create-and-persist test; allowlist test
  (metadata outside it ignored); flood test at the cap; rotation test.

### S5 — Orchestrator

- **Outcome:** An A2A agent that takes a goal, asks the planner (D5) for a JSON
  plan, validates and bounds it, dispatches subtasks, follows them, and returns
  one result. v0 delegates to one named worker; fan-out and dependencies follow
  only after v0 is validated.
- **Owner:** `packages/orchestrator` (new): planner prompt, plan schema,
  dispatcher, per-project lock (D7).
- **Depends on:** S3, S4.
- **Validation:** scripted-worker tests for success; one worker failing; one
  offline; one needing input (surfaced, never auto-answered); cancellation
  reaching every subtask; **a failed subtask is not retried automatically if it
  may have had side effects**; restart with no duplicate subtasks; the
  orchestrator listing itself or another orchestrator as a worker is rejected
  (loop and depth cap); a plan over the size or cost cap is rejected before
  dispatch; two plans touching one project are serialised; invalid planner JSON
  fails readably.

### S6 — Cleanup (`dovo prune`, in the Machines screen too)

- **Outcome:** Deletes **archived** tasks older than a given age, per named
  machine; dry run by default and it lists what will go and where; `--yes`
  deletes; it never spans machines unless each is named.
- **Owner:** `packages/cli`, `packages/tui`.
- **Depends on:** nothing.
- **Validation:** the dry run never deletes; one machine and two; only archived
  tasks are touched.

### S7 — Runbooks

- **Outcome:** Tested runbooks: personal (a VPS plus ssh or mesh) and team (mesh
  with sign-on); systemd units for a worker and the orchestrator; a timer that
  runs `dovo doctor` (without `--deep`) and posts failures to Teams.
- **Owner:** `docs/`.
- **Depends on:** S1–S5.
- **Validation:** each runbook executed once, from its text alone, on a
  machine built from a recorded image or script so the run can be repeated.

## Failure modes and recovery

| Failure                         | Behaviour                                                                  | Recovery                                              |
| ------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------- |
| A machine is down               | Federation skips it and shows the rest                                     | Reconnects on the next refresh                        |
| Tunnel drops                    | Backoff reconnect; the dot changes                                         | Machines screen names it                              |
| Worker restarts mid-task        | Task and mapping restored from the store; the Dovo task may have continued | Re-read the real status; never re-create              |
| Orchestrator restarts           | Same                                                                       | Subtasks re-followed by key, not re-created           |
| Config unreadable               | Kept as `.bak`; defaults used until fixed                                  | Restore the `.bak`                                    |
| Planner returns nonsense        | Task fails with the validation error                                       | Edit the goal or pick another planner                 |
| Duplicate delivery              | Same message id returns the same task                                      | None                                                  |
| Token leaked                    | Rotate that worker's token (S4); update the profile                        | The rotation command                                  |
| Forward port already in use     | Reported with the machine that holds it                                    | Stop the other forward, or open it on its own machine |
| Two plans want the same project | Second waits on the lock                                                   | Cancel one                                            |

## Rollout and rollback

Each stage ships behind its own flag or screen, off by default. Rollback is not
using it. No stage changes stored data in a form the previous one cannot read;
the A2A store is new and separate. Config writes keep a backup. The loopback path
is re-run after every stage (Rule 2).

## Open questions

- **O1.** What does the orchestrator offer the terminal beyond "delegate and
  follow"? A2A has no list-projects or read-history call. Either extend with
  custom skills, or the terminal keeps a second, direct read path to each
  machine. Blocks S3.
- **O3.** Is a mesh acceptable, or must everything work over ssh alone?
- **O4.** Port clashes across machines: "first forward wins, clash reported", or
  per-machine remapping (which breaks hard-coded frontends)?
