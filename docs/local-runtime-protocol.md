# Local runtime protocol

The local runtime server (`src/server/`) re-exposes any `RuntimeClient` on
loopback: JSON over HTTP + one WebSocket channel. This is the client's only
protocol; Dovo's own wire format never reaches the TUI. The upstream adapter
(`src/client/dovo.ts`) is the single place that knows Dovo's shapes
(`src/client/dovo-wire.ts`).

Everything on the wire is validated with zod at both ends
(`src/protocol/workspace.ts`, `src/protocol/sync.ts`). Frames:

| frame                                | meaning                                |
| ------------------------------------ | -------------------------------------- |
| `{"type":"event","event":TaskEvent}` | transcript/status change for one task  |
| `{"type":"connection","connected"}`  | upstream reachability (header dot)     |
| `{"type":"sync"}`                    | a data delta landed; debounced refresh |

`TaskEvent` kinds: `item.append`, `item.update`, `status`,
`history.replaced`. Conversation items and task statuses are defined in
`src/protocol/workspace.ts`.

## Endpoints

All request/response bodies match the zod schemas; errors are
`{"error":string}` with a status (400 invalid input, upstream status
pass-through, 502 unreachable).

```text
GET    /health
GET    /api/projects | /api/providers | /api/tasks
GET    /api/tasks/history?taskId=
POST   /api/tasks                 {projectId, providerId, prompt}
POST   /api/tasks/message         {taskId, text}
POST   /api/tasks/cancel          {taskId}
POST   /api/tasks/lifecycle       {taskId, action: archive | restore | delete}
POST   /api/tasks/answer          {taskId, itemId, answer}
PUT    /api/view                  {taskId|null}
WS     /ws/sync                   SyncFrame stream
```

## Relation to Dovo's real API

Dovo's surface (audited in [dovo-api-contract.md](dovo-api-contract.md)) is
mirrored where it is already good, and simplified where a third-party client
benefits. The adapter absorbs every difference, so Dovo upstream changes touch
one file (`dovo-wire.ts` + mapping), never the protocol or the TUI.

| local                       | Dovo counterpart                                               | deviation                                 |
| --------------------------- | -------------------------------------------------------------- | ----------------------------------------- |
| `/health`                   | `GET /health`                                                  | none                                      |
| `/ws/sync`                  | `POST /api/sync/ticket` + `WS /ws/sync`                        | no ticket/epoch handshake (private API)   |
| `GET /api/projects`         | `GET /api/snapshot?scope=overview` `.workspace.repositories`   | granular read instead of one snapshot     |
| `GET /api/providers`        | snapshot `.workspace.agents` + `POST /api/agents/availability` | adapter merges both                       |
| `GET /api/tasks`            | snapshot `.workspace.tasks`                                    | adapter hides `archivedAt` threads        |
| `GET /api/tasks/history`    | snapshot `?scope=threads` + `POST /api/activity`               | adapter merges messages + tool events     |
| `POST /api/tasks`           | `PATCH /api/workspace {collection:"tasks",create}`             | plain create; adapter builds the mutation |
| `POST /api/tasks/message`   | `POST /api/tasks/message`                                      | same path; body uses `taskId`             |
| `POST /api/tasks/cancel`    | `POST /api/tasks/cancel {id,runId}`                            | adapter resolves `runId` itself           |
| `POST /api/tasks/lifecycle` | `POST /api/tasks/lifecycle {id,action}`                        | same actions; body uses `taskId`          |
| `POST /api/tasks/answer`    | `POST /api/approvals` or `POST /api/tasks/answer`              | one endpoint; adapter picks by itemId     |
| `PUT /api/view`             | `{"type":"watch"}` frame on `/ws/sync`                         | focus as a resource, not a frame          |

Deliberate deviations, all inside the private server-client boundary:

- no auth: the server binds loopback; Dovo tokens live only in the adapter.
- no sync handshake, sequences, or mutation ids: reconnects are handled by the
  client (`connection` frame + refresh), matching how the demo backend works.
- `taskId` naming everywhere: Dovo's `id` refers to different entities on
  different routes; `taskId` is unambiguous in a flat protocol.
- unified answer endpoint: `itemId` prefixes (`approval:` / `question:`) tell
  the adapter which upstream call to make.

What is intentionally unchanged from Dovo: the channel name, the lifecycle
action verbs, the message/cancel paths, the task/transcript/approval
vocabulary, and the push-only realtime model (clients never poll events).
