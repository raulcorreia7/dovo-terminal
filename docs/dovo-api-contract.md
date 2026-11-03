# Dovo Studio — HTTP/WS Client Contract (for a terminal client)

Source: `dovocode/dovo-studio` at `main`; paths are relative to that repo's root and line numbers were verified against the checked-out files. Anything marked **[INFERRED]** could not be read directly and was reconstructed from adjacent code.

Conventions seen everywhere in tests: `Authorization: Bearer <token>` + `Content-Type: application/json`; every endpoint is `POST` with a JSON body except `GET /api/snapshot`, `GET /health`, `PATCH /api/workspace`, `GET /api/mutations/status`, `GET /api/workspace/recovered-edits`. Errors are `{error: string, issues?: [...]}` with the HTTP status carrying the meaning (`packages/runtime/src/http/server.ts:150-168`). CORS exposes `ETag` and allows `Authorization, Content-Type, X-Idempotency-Key, X-Dovo-Mutation-Id, If-None-Match` (`server.ts:86-93`).

---

## 1. AUTH

**Scheme.** Exactly one header: `Authorization: Bearer <token>`. Extracted at `packages/runtime/src/http/routes.ts:171` (`request.headers.authorization?.replace(/^Bearer /, '')`). There is no cookie/session auth. Tokens are ≥32-char base64url strings (`apps/api/src/owner-token.ts:25`; `apps/api/src/connection.ts:17-19` validates `token.length >= 32`).

**Token sources.**
- **Owner token** — the runtime host's own credential; authenticates as `owner: true` in snapshots. Created/persisted by `runtimeOwnerToken(directory, process.env.DOVO_OWNER_TOKEN)`: reads `<dataDir>/owner-token` (mode 0600) or generates `randomBytes(32).toString('base64url')` (`apps/api/src/owner-token.ts:6-26`); passed to `startRuntime({ownerToken})` (`apps/api/src/index.ts:118-119, 173`) and exported as `DOVO_OWNER_TOKEN` to child processes (`apps/desktop/electron/local-runtime.ts:281,307`).
- **Device token** — per-paired-client credential issued by pairing (below); `owner: false` (`packages/runtime/src/http/server.test.ts:325-328`). Revoking a device turns its requests 401 (`server.test.ts:330-331`).
- **Run tokens** (`isRunToken`) — agent-internal credentials; a terminal client never uses them (`routes.ts:175-178`, `server.ts:3`).

**How a NEW client gets a credential without pairing (the terminal-client path).** The owner token _is_ a valid Bearer credential; the desktop/server tools use it as such (`apps/api/src/server-manager.ts:57-58`, `server-remote-update.ts:142-145`, `apps/api/src/server-packaged-recovery.test.ts:431-434` — fixture asserts `Authorization: Bearer <ownerToken>` gets 200 and `{owner:true}`). **[INFERRED]** `devices.authenticate()` accepts the owner token directly — `packages/runtime/src/auth/devices.ts` is not in the sparse checkout, but every owner-authenticated behavior above is exercised end-to-end.
Discovery of address + owner token: read `runtime-connection.json` = `{address, token, pid, bindHost?}` — `readConnection()` / `connectionPaths()` in `apps/api/src/connection.ts:9-39, 83-110`; candidate dirs: `$DOVO_DATABASE_PATH`'s dir, `$DOVO_DATA_ROOT`, `~/.dovo`, `~/.dovo/desktop`, `<appData>/@dovo/desktop`, `<appData>/Dovo Studio`.

**Pairing-code flow** (device obtains its own durable token; request/claim/cancel/confirm need **no** auth header — `PAIRING_PATHS`, `routes.ts:129-137`):
1. Owner: `POST /api/pair/code` `{"autoApprove":false,"internet":false}` (owner-only, 403 otherwise) → `{code, expiresAt, addresses?:[{name,address}], peer?}` (`routes.ts:1495-1512`; response schema `responses.pairCode`, `packages/protocol/src/runtime/connection/runtime.ts:428-435`). QR text encodes `dovo://pair?address=…&code=…&expiresAt=…` (`packages/protocol/src/auth/pairing-invitation.ts:51-54`; terminal QR `apps/api/src/pairing-qr.ts`).
2. Device: `POST /api/pair/request` `{"protocolVersion":2,"code":"12345678","name":"My Terminal"}` → `{"protocolVersion":2,"id":"…","secret":"…","expiresAt":"…"}`; wrong protocol → 426 (`routes.ts:198-218`; `responses.pairRequest` `runtime.ts:436-441`; pattern `/^\d{8}$/` `routes.ts:206`).
3. Owner approves (or `autoApprove:true` skips): `POST /api/pair/approve` `{"id":"…","allow":true}` (`routes.ts:1644-1656`). Pending requests surface to the owner only in `snapshot.pendingDevices:[{id,name,expiresAt}]` (`runtime.ts:243-248`; owner-gated `packages/runtime/src/http/support/runtime-snapshot.ts:343`).
4. Device polls: `POST /api/pair/claim` `{"id":"…","secret":"…"}` → `{"status":"pending"|"approved"|"denied","token?":"…"}` — `token` is the durable device token (`routes.ts:230-234`; `responses.pairClaim` `runtime.ts:442-445`; full flow `packages/runtime/src/http/peer-connections.test.ts:480-508`).
5. Device confirms over its own credential: `POST /api/pair/confirm` `{"id":"…","secret":"…"}` with `Authorization: Bearer <token>` → 200 (`routes.ts:235-239`; `peer-connections.test.ts:506`).
6. Owner revoke: `POST /api/devices/revoke` `{"id":"…"}` (owner-only, `routes.ts:1658-1662`).

**Plain HTTP on LAN.** No TLS is required or offered — advertised pairing addresses are literally `http://<lan-ip>:<port>` (`packages/runtime/src/http/support/pairing-addresses.test.ts:22-25`). Auth is **never optional**: `GET /api/snapshot` with no credential is 401 (`server.test.ts:472`); invalid token 401 (`:292`); revoked 401 (`:331`). Only `GET /health` is unauthenticated (`routes.ts:191-198`; `server.test.ts:195-197` → `{ok:true,service:"dovo-runtime",version,runtimeId}`). Non-loopback clients additionally require the runtime policy `remoteClients` to be enabled — `services.policy.require('remoteClients')` for any remote socket (`server.ts:36-41`); a `browser` Origin header further triggers `requireClient('local-browser')` — a terminal client simply se…

**curl example:**
```bash
curl -s -H "Authorization: Bearer $(cat ~/.dovo/owner-token)" \
     http://127.0.0.1:8787/api/snapshot | head -c 400
```
(With `Accept-Encoding: gzip` accepted and `If-None-Match: "$etag"` the endpoint answers 304; ETags look like `W/"snapshot-…"` — `server.test.ts:279-291`.)

---

## 2. SNAPSHOT — `GET /api/snapshot`

Handler: `packages/runtime/src/http/routes.ts:1271-1278` → `runtimeSnapshot(s, device, overview, taskIds, pagedHistory, settledLimit)` (`packages/runtime/src/http/support/runtime-snapshot.ts:101-346`).

**Query params (complete list):**
| Param                                                                                                                           | Meaning                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scope=overview`                                                                                                                | trimmed snapshot: task summaries keep `id,title,status,…` but `messages:[]` and `files:[{path,viewed,before:"",after:""}]` — >10× smaller, separate ETag (`routes.ts:1274`; `server.test.ts:395-449`)                  |
| `scope=threads` + repeatable `task=<id>` (≤8)                                                                                   | only listed threads carry authoritative full history; others are summaries (`routes.ts:1275` + `syncTasks()` `routes.ts:1691-1695`; snapshot field `detailTaskIds` `runtime.ts:216-217`; `runtime-sync.test.ts:78-95`) |
| `history=paged`                                                                                                                 | paged conversation summaries; full messages via `POST /api/tasks/history` (`routes.ts:1276`; paged workspace builder `runtime-snapshot.ts:67-96`)                                                                      |
| `settled=<int 1..100000>`                                                                                                       | cap of settled task summaries; excess reported as `olderSettled:{limit,omitted}` (`routes.ts:1199-1208`; `runtime.ts:159-168`)                                                                                         |
| No other params are read. Conditional GET: `If-None-Match` → 304; gzip on for large bodies (`server.test.ts:277-333, 334-392`). |

**Response = `RuntimeSnapshot`**, schema `packages/protocol/src/runtime/connection/runtime.ts:157-253`. Top-level fields (trimmed to essentials; all field names exact):

```jsonc
{
  "revision": 42, // monotonic per process; restart resets
  "runtimeId": "host-stable-id", // runtime.ts:219
  "runtimeInstanceId": "a1b2c3", // per-process; change ⇒ restart (runtime.ts:218, overview-state.ts:19-24)
  "protocolVersion": 2, // runtime.ts:224; RUNTIME_PROTOCOL_VERSION runtime.ts:17
  "releaseVersion": "1.4.2",
  "releaseDistribution": "desktop",
  "runtimeHost": "studio-mini", // runtime.ts:225
  "runtimeAddresses": ["http://10.0.0.5:8787"], // LAN pairing addresses
  "owner": true, // false for device tokens
  "defaults": {
    /* runtimeDefaults */
  },
  "acpInstallations": [],
  "internet": { "enabled": false, "connected": false, "error": "" }, // optional
  "devices": [{ "id": "…", "name": "iPhone", "createdAt": "…", "revokedAt": null }], // runtime.ts:35-40,242
  "pendingDevices": [{ "id": "…", "name": "My Terminal", "expiresAt": "…" }], // owner-only, runtime.ts:243-248
  "approvals": [
    /* approvalSchema, see §3 */
  ],
  "questions": [
    /* pendingQuestionSchema, see §4 */
  ],
  "terminals": [
    /* terminalSchema runtime.ts:61-77 */
  ],
  "runs": [
    /* jobRunSchema runtime.ts:115-143 */
  ],
  "workspace": {
    "version": 1,
    "runtimeAddress": "http://127.0.0.1:8787",
    "repositories": [
      /* projects */
    ],
    "agents": [
      /* provider profiles */
    ],
    "tasks": [
      /* task records */
    ],
    "automations": []
  }
  // capability flags (all optional booleans, runtime.ts:171-213):
  // scopedAgentsSupported, permissionPolicySupported, planModeSupported,
  // messageSetupSupported, directMessageSupported, settingsScopesSupported, …
}
```

- **`workspace.repositories[]`** — projects (`repositorySchema` `packages/protocol/src/workspace.ts:256-302`): required `id, name, path, branch` (a _single current branch string_ — there is **no** branches array in the snapshot; branch listing lives in `/api/scm/*`). Notable optionals: `kind:"folder"|"scratch"`, `sharedName`, `pinned`, `archived`, `agents[]` (per-project presets), `templates[]`, `taskDefaults`, `forge`, `gitIdentity`. The built-in projectless id is `SCRATCH_PROJECT_ID = "dovo:scratch"` (`workspace.ts:255`).
- **`workspace.agents[]`** — provider profiles (`agentSchema` = `agentPresetSchema` + `globalPreset?`, `workspace.ts:68-109`): `id, name, provider, model, reasoning?, endpoint, instructions, permission("ask"|"read-only"|"workspace-write"|"auto"|"full-access"), approvalPolicy?, sandboxMode?, env?, acpInstallationId?`. `provider` literals (`workspace.ts:40-52`): `codex, opencode, claude, vibe, hermes, copilot, grok, muse, cursor, pi, acp`.
- **`workspace.tasks[]`** — full `taskSchema` (`workspace.ts:656-1030`); required core fields (`workspace.ts:896-917`): `id, title, repositoryId` (⚠ field name is `repositoryId`, _not_ `projectId`), `agentId`, `status: "draft"|"running"|"review"|"done"|"failed"|"cancelled"`, `createdAt`, `messages[]`, `files[]`, `draft`, `example`. Key optionals for a client: `activeRunId` (control token of the current run, `workspace.ts:699-700`), `runPhase("preparing"|"provider"|"finalizing")`, `execution("main"|"worktree")`, `harness` (per-task provider selection), `updatedAt`, `queue`, `activity`, `turns[]` (per-turn `status`, `provider`, `model`, `runId`). Task summaries in deltas/overview are `taskSchema` minus `messages` (`sync.ts:12-14`).
- **`workspace.tasks[].messages[]`** (`messageSchema` `workspace.ts:434-463`): `id`, `role:"user"|"assistant"`, `text`, `turnId?`, `turnSettings?` (echoes provider/model of the turn), `createdAt?`, `attachments?`, `plan?`, `review?`, `textBreaks?`.

---

## 3. SYNC — ticket → WebSocket

**Handshake** (verbatim flow from `packages/runtime/src/http/runtime-sync.test.ts:38-56`):
1. `POST /api/sync/ticket?format=2` — handler `routes.ts:1204-1230`. Query params: `format=1..5` (maps to ticket scopes `runtime-sync`…`runtime-sync-5`; `format=4&subscriptions=live` is upgraded to `5`), repeatable `task=<id>` (≤8, task-scoped detail — formats 4/5 only), `history=paged`, `settled=<n>`. Response `{ "ticket": "…" , "format"? }` (`packages/protocol/src/runtime/connection/sync.ts:185-189`). Capability mapping in `server.ts:316-328`: format≥2 ⇒ compact deltas; format≥3 ⇒ per-field task updates (`fieldDelta`); format 5 ⇒ task-metadata updates for all threads.
2. `ws://<host>/ws/sync?ticket=<ticket>` (GET upgrade; `server.ts:300-330`). Ticket is single-use and bound to your device token; foreign credential ⇒ 401 (`peer-connections.test.ts:560-569`). Permessage-deflate enabled (`server.ts:212-222`).
3. Client sends **first frame**: `{"type":"resume"}` (optionally `{"type":"resume","epoch":"…","sequence":N}` to replay only deltas since a cursor — server re-sends the missed deltas, no second baseline: `runtime-sync.test.ts:143-161`). Server then sends `snapshot` (baseline) and streams frames.

**Client→server inputs** (`syncInputSchema` `sync.ts:157-183`, handled `runtime-sync.ts:360-387`):
```json
{"type":"resume","epoch":"…","sequence":1234}
{"type":"watch","tasks":["<taskId>" /*≤8*/],"scopes":["<activityScope>" /*≤8*/],"selectionDelta":true,"detailScopes":[…]}
```
`watch` retargets which threads carry full history (answers with a fresh `snapshot` frame, or a `selection` handoff frame when `selectionDelta:true`) and subscribes activity scopes (`runtime-sync.test.ts:104-135`).

**All server frames** (`syncFrameSchema` union — exactly 6 variants, `sync.ts:120-155`; every JSON message is text, decoded with `syncFrameSchema` `runtime-sync.test.ts:45-47`):
```jsonc
{"type":"snapshot","epoch":"uuid","sequence":7,"tag":"W/\"snapshot-…\"","snapshot":{ /*full RuntimeSnapshot*/ }}
{"type":"delta","epoch":"uuid","sequence":8,"tag":"…","base":7,"delta":{ /*SnapshotDelta*/ }}
{"type":"selection","epoch":"uuid2","sequence":1,"previousEpoch":"uuid1","base":0,"tag":"…","delta":{…}} // scoped-view handoff
{"type":"activity","scope":"<taskId>","order":["id1","id2"],"events":[ /*activityEvent*/ ]}
{"type":"activity-delta","scope":"<taskId>","delta":{ "order":[…],"changes":[{"fields":{…},"payload":"…" | {"length":N,"offset":N,"remove":N,"insert":"…"}] }}
{"type":"heartbeat","epoch":"uuid","sequence":8}   // application-level, ≥ every 15 s (runtime-sync.ts:640-651)
```
`cursor` = `epoch:string, sequence:int≥0` (`sync.ts:78-86`). Gap in cursors ⇒ decode error + reconnect with fresh ticket (`live-sync.ts:574-581`).

**`SnapshotDelta`** (the only way workspace state changes; `snapshotDeltaSchema` `sync.ts:53-80`):
```jsonc
{
  "revision": 43,
  "state":  { /* any RuntimeSnapshot field EXCEPT workspace — this is how approvals, questions, runs, terminals, devices, pendingDevices and capability flags change */ },
  "workspace": {
    "metadata": {…}, "agents":[…], "repositories":[…], "automations":[…],
    "tasks": {
      "order": ["taskA","taskB"],
      "changes": [{
        "id": "taskA",
        "updatedAt": "ISO" | null,
        "fields":     { /* full task-minus-messages */ },
        "fieldDelta": { "values": { "status": "running", "activeRunId": "…" }, "removed": ["activity"] },   // format≥3
        "messages": {
          "order": ["m1"],
          "changes": [{
            "fields": { /* message minus text */ },
            "text": "full replacement"                       // whole-text change
                 // or  {"length": 132, "append": " streaming chunk"}   ← assistant text streaming (sync.ts:37-55)
          }]
        }
      }]
    }
  }
}
```

- **conversation item append** = new entry under `messages.changes` (`fields` carries `role`, `turnId`, etc.; text starts `""` then streams via `{"length","append"}`).
- **task status change** = `fieldDelta.values.status` (or `fields.status`), `runtime-sync.test.ts:88-94`.
- **workspace/project updates** = `workspace.repositories` / `workspace.metadata` (`sync.ts:57-64`).
- **approval requests / question requests** = whole arrays replaced inside `delta.state.approvals` / `delta.state.questions` (`sync.ts:55`; `runtime.ts:237-238`; apply with `applySnapshotDelta` from `@dovo/protocol`, `runtime-sync.test.ts:88-92`).
- **tool events** are NOT conversation messages — they stream on the **activity** frames for the task scope: `{"type":"activity","scope":"<taskId>",…}` with events `{id,time,kind,scope,summary,payload}` (`packages/protocol/src/automation/activity.ts:11-17`); `kind:"tool"` payloads are `{turnId, messageId?, toolId, status, textOffset?, terminalCommand?}` (`activity.ts:20-33`). REST equivalent: `POST /api/activity {query,kind,offset,scope}` (`routes.ts:1150-1177`).
- **Task-scoped streaming: yes.** `POST /api/sync/ticket?format=5&history=paged&task=<id>` yields a connection whose baseline has `detailTaskIds:["<id>"]` and full messages only for that thread; other threads arrive as metadata-only summaries; switch live thread with `watch` (`runtime-sync.test.ts:66-135`).

**Minimal WS session:**
```bash
T=$(curl -s -X POST -H "Authorization: Bearer $TOKEN" \
      'http://127.0.0.1:8787/api/sync/ticket?format=2' | jq -r .ticket)
wscat -c "ws://127.0.0.1:8787/ws/sync?ticket=$T"   # then send: {"type":"resume"}
```

---

## 4. TASK LIFECYCLE

**Create task (draft) in a project** — tasks are _client-authored records_ created through the generic workspace mutation endpoint:
`PATCH /api/workspace` + header `X-Dovo-Mutation-Id: <opaque>` (optional, for durable replay; `routes.ts:1475-1479`):
```json
{
  "collection": "tasks",
  "id": "<client-chosen-id>",
  "changes": {},
  "create": {
    "id": "<same-id>",
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
      "endpoint": "",
      "acpInstallationId": null
    },
    "execution": "main",
    "status": "draft",
    "createdAt": "2026-11-03T10:00:00.000Z",
    "messages": [],
    "files": [],
    "draft": "",
    "example": false
  }
}
```
(body verbatim from `packages/runtime/src/http/projectless.test.ts:36-57`; the mobile client builds the same shape in `apps/mobile/src/tasks/creation/new-task.tsx:94-121`; `harness` shape = `defaultTaskHarness(provider)` `workspace.ts:1254+`, i.e. `taskHarnessSchema` = agent preset minus `id/name/icon` `workspace.ts:110`.) **Provider selection:** either `agentId:"<profileId>"` referencing `workspace.agents[]` (omit `harness`, per `new-task.tsx:98-99`) or `harness.provider` + `harness.model` for an unconfigured harness. **Workspace options:** `execution:"main"|"worktree"`, `checkoutBranch?`, `worktreeBaseBranch?`, `existingWorktreePath?`, `worktreeFromOrigin?`, `setupCommand?`, `submodules?`, `linkedCheckouts?` (`workspace.ts:836-859`, `linkedCheckoutSchema` …
Response: `{revision, outcome:"applied"|"reconciled"|"rejected"|"acknowledged", …}` (`workspacePatchResultSchema` `runtime.ts:337-345`). Projects themselves are added via `POST /api/scm/repositories/add` (`projectless.test.ts:61-64`).

**Send prompt / follow-up message** (also _starts_ the run for a draft — first-submission path `agents-routes.ts:689-692,699-713`):
`POST /api/tasks/message`
```json
{
  "id": "<taskId>",
  "messageId": "<client-chosen-uuid>",
  "text": "Fix the failing test",
  "attachmentIds": [],
  "turnSettings": { "provider": "codex", "model": "…", "reasoning": "" },
  "plan": false,
  "review": false,
  "queueOnly": false,
  "sendNow": false,
  "initialTitle": { "before": "New task", "after": "Fix flaky test" }
}
```
Schema `taskMessageSchema` (`packages/protocol/src/tasks/task-message.ts:9-34`); body copy: `packages/runtime/src/http/endpoints/message-resume.test.ts:31-34`, `setup-routes.test.ts:402-405`. `messageId` is client-generated and deduplicated (idempotency). Mid-run steering: same schema to `POST /api/tasks/steer` with required `runId` (`agents-routes.ts:654-687`). Explicit re-run of an existing task: `POST /api/tasks/run {"id":"<taskId>"}` (`agents-routes.ts:1432-1444`).

**Stop / cancel the active run:** `POST /api/tasks/cancel {"id":"<taskId>","runId":"<task.activeRunId>"}` — `runId` is **required** (409 `Update Dovo or refresh this thread…` when omitted); `runId` value = `task.activeRunId` observed on the task record (`agents-routes.ts:1469-1483`; `workspace.ts:699-700`).

**Answer an approval request** (`snapshot.approvals[]`: `{id,taskId,title,detail,scopes?:{session,always},rememberRule?:null|"command"|"web",createdAt}` `runtime.ts:41-56`):
`POST /api/approvals {"id":"<approvalId>","allow":true,"remember":true}` or with `decision` — `"approve"|"session"|"always"|"deny"` (`agents-routes.ts:615-636`; body from `server.test.ts:107`; `approvalDecisionSchema` `runtime.ts:40`).

**Answer a question request** (`snapshot.questions[]`: `{id,taskId,createdAt,routing?,attachments?,prompt:{title,questions:[{id,header,question,options:[{value,label,description}],multiple,custom,secret,required,inputType}]}}` — `packages/protocol/src/conversation/workflow/questions.ts:6-55`):
`POST /api/tasks/answer {"id":"<questionId>","answers":{"<questionId>":["<chosen value or free text>"]}}` — `answers` is `Record<questionId,string[]>` or `null`; optional `attachmentIdsByQuestion`, `outcomes:{id:"skipped"|"replied_in_chat"|"dismissed"}` (`questionReplySchema` `questions.ts:67-73`; `agents-routes.ts:558-566`).

**Paged history / search:** `POST /api/tasks/history {"id":"<taskId>","before":"<messageId>"}` (`routes.ts:1231-1240`); `POST /api/tasks/search {"query":"…","id"?,"before"?}` (`routes.ts:1258-1269`). Lifecycle (archive/settle/delete): `POST /api/tasks/lifecycle {"id","action",…}` (`agents-routes.ts:476-486`).

**List providers / profiles:** profiles come from `snapshot.workspace.agents`; availability probe: `POST /api/agents/availability {"repositoryId"?,"refresh"?}` → `[{"id":"harness:codex"|"agent:<agentId>","available":true}]` (`agents-routes.ts:84-111`; `packages/protocol/src/tasks/harness-availability.ts:7-9,23-35`; `harness-availability.test.ts:45-53`). Model catalog: `POST /api/agents/models {"provider":"codex","endpoint":"","model":"","refresh"?}` → `{models:[{id,name}],reasoning:[…]}` (`agents-routes.ts:213-259` region + `endpoints/model-catalog.test.ts:24-35`); cached variant `POST /api/agents/models/cached`. ACP agents: `POST /api/agents/acp/list` → `{installations}` (`endpoints/acp-routes.ts:60-62`).

---

## 5. MINIMUM VIABLE CLIENT (sequence)

1. **Connect** — `GET /health` (no auth, `{ok,runtimeId}`) then `GET /api/snapshot` with `Authorization: Bearer <owner-token-from-~/.dovo/owner-token-or-runtime-connection.json>`; keep `revision`, `runtimeInstanceId`, ETag.
2. **List projects** — read `snapshot.workspace.repositories[]` → `id,name,path,branch` (+ `kind`; `dovo:scratch` = projectless).
3. **List tasks** — read `snapshot.workspace.tasks[]` (use `?scope=overview` for cheap polling) → `id,title,status,repositoryId,activeRunId?`.
4. **Create task** — `PATCH /api/workspace {"collection":"tasks","id":<uuid>,"create":{…draft §4…},"changes":{}}`; provider via `agentId` or `harness.provider`; workspace via `execution`/worktree fields.
5. **Send prompt & stream text** — `POST /api/tasks/message {"id":<uuid>,"messageId":<uuid>,"text":"…"}` (starts the run; `turnSettings` is a strictStruct of provider literals — omit it and the run binds to the task's `agentId`/`harness`); in parallel `POST /api/sync/ticket?format=5&history=paged` (format 5 = field-level deltas + `watch` view subscription + scoped `activity`/`activity-delta` frames for the focused task; formats 2/3 ignore `watch`) → open `ws://…/ws/sync?ticket=…` (tickets are single-use, 30 s TTL) → send `{"type":"resume"}` within 10 s → apply `snapshot`/`delta` frames: assistant text streams as `workspace.tasks.changes[].messages.changes[].text:{length,append}`; status via `fieldDelta.values.status`; approvals/questions ride whole-object `delta.state` replacement; on a `heartbeat` whose `sequence` exceeds yours, send `{"type":"resume","epoch","sequence"}` (server replays or rebases).
6. **Follow-up** — `POST /api/tasks/message {"id","messageId":<new-uuid>,"text":"…"}` again; same stream shows the new turn.
7. **Cancel** — `POST /api/tasks/cancel {"id","runId":<task.activeRunId from snapshot/stream>}`; expect `status:"cancelled"` in the next delta. (Approvals/questions that arrive in `delta.state` are answered via `POST /api/approvals` / `POST /api/tasks/answer` before the run proceeds.)

---

**Notes for implementers:** every task-affecting write eventually shows up as a sync `delta` — HTTP responses return only `{ok:true}` or a revision, never the new record. `X-Dovo-Mutation-Id` (workspace patches) and client-chosen `messageId` (messages) are the two idempotency handles. The `epoch`+`sequence` cursor is per-connection-view; on any decode/gap error, mint a new ticket and `{"type":"resume"}` fresh.

---

## 6. IMPLEMENTATION STATUS

This document was re-audited line-by-line against `dovocode/dovo-studio` commit `a3297a9` (2026-11),
and `src/api/runtime-client.ts` implements exactly it — `test/runtime-contract.ts` drives the real
client against an in-process fake runtime that replays these frames. Two audit confirmations worth
remembering:

- `POST /api/tasks/message` responses/errors only ever concern the message; the task record appears
  via the next `delta`. Never send `turnSettings` unless `provider` is one of the literal
  `providerSchema` values (`codex|opencode|claude|vibe|hermes|copilot|grok|muse|cursor|pi|acp`) —
  a preset UUID there is a strictStruct 400. Omitting it binds the run to the task's bound agent.
- `POST /api/activity` returns `{"events":[…]}` (activitySchema), not a bare array; compacted tool
  event payloads carry `presentation:{kind,input,detail,diff}` — prefer `presentation.input` for
  the detail line, `payload.text` is absent on compacted rows.
