# 0001 — Transport, control plane and A2A

**State:** proposed · **Owner:** Raul Correia · **Accepted:** not yet

## Decision needed

How the terminal client reaches work that runs on other machines: which wire
protocol, where orchestration lives, and how agents talk to each other. The
aim is a faster protocol than WebSocket, a thin client, and workers that can
run a harness on any machine.

## Evidence

- The seam already exists. The TUI sees only `RuntimeClient`
  (`packages/protocol/src/runtime-client.ts`); every transport is an adapter
  behind it. A new transport is a new adapter, not a rewrite.
- Two hops use WebSocket today. Both carry small JSON frames: one task event
  or status change per frame.
  1. TUI ↔ the embedded local server (`packages/client/src/loopback.ts`).
  2. This client ↔ the Dovo runtime (`/ws/sync`, `packages/client/src/dovo-sync.ts`).
- Hop 2 is Dovo's protocol. The client cannot change it
  ([contract](../dovo-api-contract.md)). Only hop 1, and any new hop between
  our own components, can use a different protocol.
- `--local` already removes hop 1 completely (no server, in-process).
- Measured (Node 26, loopback, 160-byte frames, 5,000 round trips):

  | Path                                 | p50    | p99    |
  | ------------------------------------ | ------ | ------ |
  | Frame echo, WebSocket over TCP       | 68 µs  | 231 µs |
  | Frame echo, Unix socket              | 23 µs  | 61 µs  |
  | `listTasks` in-process (`--local`)   | 3 µs   | 12 µs  |
  | `listTasks` over the loopback server | 429 µs | 1.7 ms |

  A Unix socket is about 3× faster than WebSocket, and both are tens of
  microseconds against a screen that redraws every 16 ms. The transport is not
  the bottleneck.
- Validation is not either. Parsing one sync frame costs 2.5 µs with zod 4
  against 1.6 µs for `JSON.parse` alone; 200 tasks cost 144 µs against 128 µs.
  Valibot was slower than zod (3.8 µs, 226 µs); ArkType and compiled TypeBox
  were within noise of bare `JSON.parse`. Replacing zod would save under a
  microsecond per frame, so it stays.

## Options

### Transport for our own hops

| Option                                                     | Gain                                                                   | Cost                                                                                                            |
| ---------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Keep WebSocket                                             | Nothing to build; works through proxies and browsers                   | Per-frame JSON parse; TCP head-of-line blocking on a lossy link                                                 |
| Unix domain socket, length-prefixed frames, local only     | Removes TCP and HTTP framing on the one local hop                      | New adapter; same machine only                                                                                  |
| Binary encoding (MessagePack or CBOR) over the same socket | Smaller, cheaper frames                                                | Loses easy debugging; zod validation still needed at the edge                                                   |
| HTTP/2 streaming (gRPC or Connect)                         | Multiplexed streams, typed contracts, flow control, mature in Node     | A schema toolchain; heavier than the problem today                                                              |
| WebTransport / HTTP/3 (QUIC)                               | No head-of-line blocking, connection migration, fastest on lossy links | Server-side support in Node is not yet stable (unverified: check the current Node release before relying on it) |

### Where orchestration lives

| Option                                | Gain                                               | Cost                                              |
| ------------------------------------- | -------------------------------------------------- | ------------------------------------------------- |
| A. In the Dovo runtime                | One implementation for every client                | Another repository; not in this project's control |
| B. A control plane in this repository | Ships here; reuses `src/server` and saved profiles | Risks owning logic that belongs in the runtime    |

### Agent-to-agent

A2A is an open protocol over HTTP with an agent card. A worker can expose a
harness as an A2A endpoint, and a control plane can call it. That fits option B
and keeps workers independent of any one client.

## Recommendation

1. **Keep WebSocket for hop 1.** The measurement above says no transport change
   is justified. `--local` skips the hop entirely and is the fastest path.
2. **Do not replace zod.** See the validation numbers above.
3. **Remote workers:** A2A (below) already offers JSON-RPC, REST and gRPC over HTTP/2 through the official SDK, so HTTP/2 streaming needs no code of our own. Revisit WebTransport
   when server-side support is stable. Either way it is one more adapter behind
   `RuntimeClient`.
4. **Control plane (built, option B):** `createFederatedClient` merges several runtimes behind one `RuntimeClient`, and `dovo serve --a2a` exposes a runtime as an A2A agent. Start as option B in a new package under `packages/`,
   with the worker contract written as an A2A agent card, so it can move into
   the runtime later if Dovo wants it.
5. **Do not change hop 2.** It is Dovo's protocol.

## Migration path

The aim is to move in three stages without a rewrite, each usable on its own.

| Stage                    | Meaning                                                                                                                                            | State                                                                               |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 1. One machine           | The terminal works against the runtime on this machine                                                                                             | Done: `dovo`, `dovo --local`                                                        |
| 2. Many machines         | One workspace across every runtime you own; a task runs where its project lives                                                                    | Done: `dovo --all` (`createFederatedClient`)                                        |
| 3. Orchestrator over A2A | Each machine is an A2A worker; an orchestrator decomposes goals into tasks across workers; the terminal talks to the orchestrator and nothing else | Workers done: `dovo serve --a2a`. Orchestrator and an A2A client adapter: not built |

Stages 1 and 2 share one seam (`RuntimeClient`), so the terminal does not change
between them. Stage 3 is where that stops being true, for one reason:

- A2A is task-oriented: send a message, follow a task, answer when it is
  `input-required`. `RuntimeClient` is richer: it lists projects, shows
  history, and answers approvals and questions.
- So the orchestrator's A2A surface covers **delegating and following work**;
  browsing projects and reading full history still need either an extension to
  that surface (A2A allows custom skills and metadata) or a second read path.
  This is the main open design question for stage 3.

What stage 3 still needs, in order:

1. An A2A client adapter: the federation's machine type that talks to a worker
   through the SDK's `ClientFactory`, instead of through Dovo's own protocol.
2. The orchestrator: an agent that takes a goal, splits it into tasks, picks
   workers, follows them, and reports one result. It is itself an A2A agent, so
   the terminal (or any other agent) talks to it the way it talks to a worker.
3. Worker discovery: agent cards at known URLs, with the bearer token per
   worker kept in the saved profile.

## Deployment modes (proposed)

Both modes use the same pieces: a self-hosted mesh network for reachability, A2A
workers on each machine, and one orchestrator that is itself an A2A agent.
Nothing in this repository becomes a hosted service.

| Mode     | Who                          | Setup                                                                                                                   |
| -------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Personal | One person, several machines | A small VPS runs the mesh control server and the orchestrator; every machine joins the mesh and runs `dovo serve --a2a` |
| Team     | A company or collaborators   | The same, with the mesh's single sign-on and access rules deciding who can reach which workers                          |

Mesh candidates, all self-hostable (from public comparisons, several written by
the vendors themselves, so verify before committing): Headscale (a minimal,
BSD-licensed control server for Tailscale clients; file-based access rules),
NetBird (WireGuard with a management server, web UI, groups and single sign-on;
AGPLv3 server parts; some management features are paid-cloud only), Netmaker
(aimed at site-to-site routing). Plain WireGuard or `ssh -L` is the
zero-dependency fallback.

## Trade-offs that decide it

- A faster protocol helps only when the transport is the cost. Model latency is
  seconds; a frame is microseconds. The measurement decides.
- Typed contracts (HTTP/2 or Connect) buy safety across machines at the price of
  a toolchain, and this project's schemas (zod) already give runtime
  validation. Prefer to extend them before adding another schema language.
- Option B ships sooner; option A is cleaner long term. The A2A card keeps the
  worker side identical under either.

## Assumptions and unknowns

- Assumed: the slow part, if any, is not the local hop. **Unverified.**
- Unknown: Node's current QUIC / WebTransport server support.
- Unknown: whether Dovo wants orchestration upstream.
- Unknown: what GitHub should show (PR state per thread? CI?). Not designed.
- Unknown: shapes the published contract leaves open (model catalog entries,
  device entries). The client parses them tolerantly and has not been run
  against a live runtime.

## Open questions for the owner

1. Is the control plane built here (B) or proposed to the Dovo runtime (A)? (Built here so far, as B.)
2. What does "GitHub integration" need first: read-only PR and CI status per
   thread, or the agent opening PRs?
3. Does a benchmark of hop 1 need to pass before any new transport work starts?
