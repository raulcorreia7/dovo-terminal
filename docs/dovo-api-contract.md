# The Dovo runtime API

What a client can rely on from a running Dovo Studio runtime: its HTTP API,
its WebSocket sync protocol, and the rules that connect the two. Describes
`dovocode/dovo-studio` as of commit `a3297a9` (2026-11). Where this project
differs from it, [local-runtime-protocol.md](local-runtime-protocol.md) says
so.

## Authentication

One scheme: `Authorization: Bearer <token>`, on every request except
`GET /health`. No cookies, no sessions. Tokens are 32+ character base64url
strings; an unknown, missing, or revoked token is always `401`. Plain HTTP is
normal on a LAN — TLS is neither required nor offered. Non-loopback clients
additionally require the runtime's `remoteClients` policy to be on.

| credential   | what it is                                                       |
| ------------ | ---------------------------------------------------------------- |
| owner token  | the host's own credential; `owner: true` in snapshots            |
| device token | a paired client's durable credential, obtained via pairing below |

**Finding a local runtime.** The owner token lives in `<data-dir>/owner-token`
(env `DOVO_OWNER_TOKEN` overrides). Address + token are published in
`runtime-connection.json` (`{address, token, pid}`), looked up in: the dir of
`$DOVO_DATABASE_PATH`, `$DOVO_DATA_ROOT`, `~/.dovo`, `~/.dovo/desktop`, the
desktop app-data dirs.

**Pairing (a device gets its own token).** No auth header on these routes:

1. Owner: `POST /api/pair/code` → `{code, expiresAt, addresses?, peer?}`;
   `code` is 8 digits with an expiry; `autoApprove: true` skips step 3.
2. Device: `POST /api/pair/request {"protocolVersion":2,"code":"…","name":"…"}`
   → `{id, secret, expiresAt}`. Wrong `protocolVersion` → `426`.
3. Owner approves: `POST /api/pair/approve {"id","allow":true}`. Pending
   requests are visible to the owner as `snapshot.pendingDevices`.
4. Device polls: `POST /api/pair/claim {"id","secret"}` →
   `{status:"pending"|"approved"|"denied", token?}`; `token` is the durable
   device token.
5. Device confirms with that token: `POST /api/pair/confirm {"id","secret"}`.
6. Owner revokes at any time: `POST /api/devices/revoke {"id"}`; the device's
   requests then return `401`.

`GET /health` is unauthenticated and answers
`{ok:true, service:"dovo-runtime", version, runtimeId}`.

## Snapshot — `GET /api/snapshot`

One call returns the complete state: identity, devices, pending approvals and
questions, and the full workspace (projects, agents, tasks). It supports
conditional `GET` (`If-None-Match` → `304`, gzip), and four scope parameters
— no others are read:

| parameter                          | what you get                                                                |
| ---------------------------------- | --------------------------------------------------------------------------- |
| `scope=overview`                   | summaries only: tasks carry no message bodies (≫smaller, separate ETag)     |
| `scope=threads` + `task=<id>` (≤8) | full, authoritative history for the listed tasks only                       |
| `history=paged`                    | paged conversation summaries; fetch full text via `POST /api/tasks/history` |
| `settled=<1..100000>`              | cap on settled-task summaries; the rest reported as `olderSettled`          |

Response shape (exact field names, client-relevant subset):

```jsonc
{
    "revision": 42,               // monotonic per process
    "runtimeId": "…",             // host-stable
    "runtimeInstanceId": "…",     // changes on restart
    "protocolVersion": 2,
    "releaseVersion": "1.4.2",
    "runtimeHost": "…", "runtimeAddresses": ["http://10.0.0.5:8787"],
    "owner": true,                // false for device tokens
    "devices": [...], "pendingDevices": [...],          // pendingDevices: owner only
    "approvals": [...], "questions": [...],             // open prompts, §Tasks
    "workspace": {
        "repositories": [...], "agents": [...], "tasks": [...], "automations": []
    }
    // plus capability flags (all optional booleans), terminals, runs, defaults
}
```

**Projects** (`workspace.repositories[]`): `id, name, path, branch` are always
present — `branch` is a single current-branch string; listing branches is a
separate `/api/scm/*` concern. Optional and notable: `kind` (`"folder"|
"scratch"`), `pinned`, `archived`, per-project agent presets. The built-in
projectless project has the fixed id `dovo:scratch`.

**Agents** (`workspace.agents[]`): provider profiles — `id, name, provider,
model, endpoint, instructions, permission` (`ask | read-only |
workspace-write | auto | full-access`) and optionals. `provider` is one of
the literals: `codex, opencode, claude, vibe, hermes, copilot, grok, muse,
cursor, pi, acp`.

**Tasks** (`workspace.tasks[]`): `id, title, repositoryId, agentId, status,
createdAt, messages[], files[], draft, example` are always present. The field
is `repositoryId`, never `projectId`. `status` is `draft | running | review |
done | failed | cancelled`. Client-critical optionals: `activeRunId` (the
control token of the current run), `runPhase`, `execution` (`main|worktree`),
`harness` (per-task provider choice), `updatedAt`. In overview scopes and
deltas, tasks are the same record minus `messages`.

**Messages** (`tasks[].messages[]`): `id`, `role` (`user|assistant`), `text`,
optionally `turnId`, `turnSettings` (echoes provider/model of that turn),
`createdAt`, attachments, plan, review.

## Realtime sync

A push-only channel; clients never poll for events.

1. `POST /api/sync/ticket?format=5[&task=<id>…][&history=paged][&settled=n]`
   → `{ticket}`. Single-use, 30 s TTL, bound to your token (another
   credential → `401`). Format selects the delta richness you accept: `≥2`
   compact deltas, `≥3` per-field task updates, `5` adds task metadata for
   all threads and honors `watch`.
2. Open `ws://<host>/ws/sync?ticket=…` and send `{"type":"resume"}` (within
   10 s; optionally `{"type":"resume","epoch":"…","sequence":N}` to resume a
   cursor and receive only the deltas you missed).
3. The server sends a `snapshot` baseline, then frames — exactly these six:

| frame                                       | what it means                                                            |
| ------------------------------------------- | ------------------------------------------------------------------------ |
| `snapshot {epoch, sequence, tag, snapshot}` | authoritative baseline                                                   |
| `delta {epoch, sequence, base, delta}`      | the only way state changes thereafter                                    |
| `selection {…previousEpoch…}`               | a scoped-view handoff after `watch`                                      |
| `activity {scope, order, events}`           | full activity page for one task (tool events live here, not in messages) |
| `activity-delta {scope, delta}`             | incremental activity for that task                                       |
| `heartbeat {epoch, sequence}`               | keepalive, at least every 15 s                                           |

Client→server inputs are `resume` (above) and
`watch {tasks:[≤8 ids], scopes:[≤8], selectionDelta}` — retargets which
threads carry full history and which activity scopes stream.

Inside a `delta`: `state` carries whole replacement values for any snapshot
field except `workspace` — this is how approvals, questions, devices, and
flags change. `workspace.tasks` carries task `order` plus per-task `changes`:
`fields` (whole values) or `fieldDelta {values, removed}` (format ≥3) — a
status change arrives here, as does a new `activeRunId`. Message appends
appear under `messages.changes` with `text` either whole or streaming as
`{"length":N,"append":"chunk"}` — streamed assistant text always arrives this
way. Tool events arrive only on `activity` frames, as
`{id,time,kind,scope,summary,payload}` with `kind:"tool"`.

Any gap or decode failure in `epoch`/`sequence` → open a new ticket and
resume fresh.

## Tasks and prompts

| intent                    | call                                                                                           |
| ------------------------- | ---------------------------------------------------------------------------------------------- |
| create a task (draft)     | `PATCH /api/workspace {"collection":"tasks","id":<your id>,"create":{…},"changes":{}}`         |
| start / continue a run    | `POST /api/tasks/message {"id","messageId":<your uuid>,"text"}` — also starts a draft          |
| steer a running task      | `POST /api/tasks/steer {"id","runId","text"}`                                                  |
| re-run an existing task   | `POST /api/tasks/run {"id"}`                                                                   |
| stop the current run      | `POST /api/tasks/cancel {"id","runId"}` — `runId` is required; its value is `task.activeRunId` |
| answer an approval        | `POST /api/approvals {"id","allow":true,"remember":false}` (or `decision`: `approve            | session | always | deny`) |
| answer a question         | `POST /api/tasks/answer {"id","answers":{"<questionId>":["value"]}}` — `answers` may be `null` |
| page back through history | `POST /api/tasks/history {"id","before":"<messageId>"}`                                        |
| search                    | `POST /api/tasks/search {"query","id?"}`                                                       |
| archive / settle / delete | `POST /api/tasks/lifecycle {"id","action"}`                                                    |
| provider availability     | `POST /api/agents/availability {}` → `[{"id":"harness:codex","available":true}]`               |
| model catalog             | `POST /api/agents/models {"provider":"codex"}` → `{models,reasoning}`                          |

A created task is a client-authored record: pick the provider either by
`agentId` (a configured profile from `workspace.agents`, omit `harness`) or
by `harness.provider` + `harness.model` for an unconfigured harness.
Workspace options (`execution: "main"|"worktree"`, branch and setup fields)
are creation-time fields on the same body.

```json
{
    "collection": "tasks",
    "id": "<your-id>",
    "changes": {},
    "create": {
        "id": "<your-id>",
        "repositoryId": "<repoId>",
        "title": "New task",
        "agentId": "",
        "harness": {
            "provider": "codex",
            "model": "",
            "reasoning": "",
            "serviceTier": "",
            "instructions": "",
            "permission": "ask",
            "endpoint": ""
        },
        "execution": "main",
        "status": "draft",
        "createdAt": "<ISO>",
        "messages": [],
        "files": [],
        "draft": "",
        "example": false
    }
}
```

`PATCH /api/workspace` answers `{revision, outcome}` — and a `200` with
`outcome:"rejected"` is still a rejection; check `outcome`, not the status.
Optional header `X-Dovo-Mutation-Id` makes the mutation durably replayable;
client-chosen `messageId` makes messages idempotent. Those are the two
idempotency handles.

## Rules every client depends on

- A write never returns the new state. HTTP responses carry `{ok:true}`, a
  revision, or an error — the state itself arrives on the sync channel.
- `turnSettings` on a message must name a provider literal (`codex|claude|
  …`) or be omitted; a profile UUID there is a `400`. Omitting it binds the
  run to the task's agent.
- `POST /api/activity {"query","kind","offset","scope"}` returns
  `{"events":[…]}`, never a bare array. Compacted tool events carry
  `presentation:{kind,input,detail,diff}`; `payload.text` is absent there —
  read `presentation.input` for the detail line.
- Approvals appear as `snapshot.approvals[]`
  (`{id,taskId,title,detail,scopes?,createdAt}`); questions as
  `snapshot.questions[]` with a nested `prompt` of question objects
  (`{id,question,options:[{value,label}],multiple,custom,required,…}`). They
  are answered via the two endpoints above, then disappear from later
  snapshots.

## Minimum viable client

1. `GET /health`, then `GET /api/snapshot` with the owner token found in
   `~/.dovo/owner-token` or `runtime-connection.json`.
2. List projects from `workspace.repositories`, tasks from
   `workspace.tasks` (poll `?scope=overview`, not full snapshots).
3. Open sync at `format=5`; keep the `epoch`/`sequence` cursor.
4. Create: `PATCH /api/workspace` with a draft above.
5. `POST /api/tasks/message` to start; render streamed assistant text from
   `messages.changes[].text.append`, status from `fieldDelta.values.status`,
   tools from `activity` frames.
6. Answer approvals/questions when they appear in `delta.state`.
7. Follow up with another message on the same task; cancel with
   `{"id","runId":activeRunId}`.
