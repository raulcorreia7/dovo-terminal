// Drives the REAL RuntimeClient against an in-process fake runtime that
// implements the audited Dovo wire contract (dovocode/dovo-studio @ a3297a9):
//   GET  /api/snapshot?scope=overview | ?scope=threads&task=  -> workspace + approvals/questions
//   POST /api/activity            -> {events:[…]}  (an object envelope, NOT a bare array)
//   POST /api/sync/ticket         -> {ticket}
//   WS   /ws/sync?ticket          -> resume→snapshot/delta/heartbeat; watch→activity(+delta)
//   POST /api/tasks/message | /api/workspace | /api/tasks/cancel | /api/approvals
// Asserts both the outbound request bodies and the internal events the client
// derives from the frames. This is the runtime-client's end-to-end check; the
// UI smoke test uses MockClient and does not exercise any of this file.
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer } from "ws";
import type { WebSocket as ClientSocket } from "ws";
import { createRuntimeClient } from "../src/api/runtime-client.ts";
import type { TaskEvent } from "../src/api/types.ts";

const { WebSocket } = await import("ws");
// the client uses the global WebSocket; back it with the ws polyglot impl
(globalThis as { WebSocket: unknown }).WebSocket = WebSocket;

const TASK = "task-1";
const AGENT = "agent-1";
const REPO = "repo-1";
const RUN = "run-1";
const now = new Date().toISOString();

function snapshot() {
  return {
    revision: 1,
    runtimeInstanceId: "rt-1",
    workspace: {
      version: 1,
      repositories: [{ id: REPO, name: "site", path: "/srv/site", branch: "main", kind: "git" }],
      agents: [
        { id: AGENT, name: "Claude Opus", provider: "claude", model: "claude-opus-4", instructions: "", permission: "ask", endpoint: "" },
      ],
      tasks: [
        {
          id: TASK,
          title: "Fix login",
          repositoryId: REPO,
          agentId: AGENT,
          status: "running",
          createdAt: now,
          updatedAt: now,
          activeRunId: RUN,
          messages: [{ id: "m-user", role: "user", text: "login is broken" }],
        },
      ],
    },
    approvals: [],
    questions: [],
  };
}

interface Seen {
  message?: Record<string, unknown>;
  create?: Record<string, unknown>;
  cancel?: Record<string, unknown>;
  approvals?: Record<string, unknown>;
  activity?: Record<string, unknown>;
  ticket?: string;
}
const seen: Seen = {};
const flags = { rejectNextCreate: false };

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const send = (code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    if (req.method === "GET" && url.pathname === "/api/snapshot") return send(200, snapshot());
    if (req.method === "POST" && url.pathname === "/api/activity") {
      seen.activity = body;
      return send(200, {
        events: [
          { id: "ev-1", time: now, kind: "tool", scope: TASK, summary: "search", payload: JSON.stringify({ status: "completed", presentation: { input: "grep login" } }) },
        ],
      });
    }
    if (req.method === "POST" && url.pathname === "/api/sync/ticket") {
      seen.ticket = url.search;
      return send(200, { ticket: "ticket-1" });
    }
    if (req.method === "POST" && url.pathname === "/api/tasks/message") {
      seen.message = body;
      return send(200, { ok: true });
    }
    if (req.method === "PATCH" && url.pathname === "/api/workspace") {
      seen.create = body;
      if (flags.rejectNextCreate) {
        flags.rejectNextCreate = false;
        return send(200, { revision: 3, outcome: "rejected", reason: "Invalid request data." });
      }
      return send(200, { revision: 2, outcome: "applied" });
    }
    if (req.method === "POST" && url.pathname === "/api/tasks/cancel") {
      seen.cancel = body;
      return send(200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/approvals") {
      seen.approvals = body;
      return send(200, { ok: true });
    }
    send(404, { error: "unhandled " + req.method + " " + url.pathname });
  });
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;

// --- realtime channel: /ws/sync (converging fake) ---------------------------
const wss = new WebSocketServer({ noServer: true });
const cursor = { lastSeq: 5, bootstrapped: false, sawResumeWithCursor: false };
const liveRef: { socket: ClientSocket | null } = { socket: null };

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname !== "/ws/sync" || url.searchParams.get("ticket") !== "ticket-1") {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (client) => {
    liveRef.socket = client;
    client.on("message", (rawData) => {
      const input = JSON.parse(String(rawData)) as Record<string, unknown>;
      if (input.type === "resume") {
        if (typeof input.sequence === "number") cursor.sawResumeWithCursor = true;
        if (!cursor.bootstrapped) {
          cursor.bootstrapped = true;
          client.send(JSON.stringify({ type: "snapshot", epoch: "e1", sequence: 5, tag: "t", snapshot: snapshot() }));
          client.send(
            JSON.stringify({
              type: "delta", epoch: "e1", sequence: 6, base: 5, tag: "t",
              delta: { workspace: { tasks: { changes: [{ id: TASK, messages: { changes: [{ fields: { id: "m-asst", role: "assistant", text: "hi" } }] } }] } } },
            }),
          );
          cursor.lastSeq = 6;
        }
        client.send(JSON.stringify({ type: "heartbeat", epoch: "e1", sequence: cursor.lastSeq }));
      } else if (input.type === "watch") {
        client.send(JSON.stringify({ type: "activity", scope: TASK, order: { revision: 1, total: 1 }, events: [ { id: "ev-2", time: now, kind: "tool", scope: TASK, summary: "read", payload: JSON.stringify({ status: "running", presentation: { input: "read x.ts" } }) } ] }));
        client.send(JSON.stringify({ type: "activity-delta", scope: TASK, delta: { changes: [{ fields: { id: "ev-2", kind: "tool", scope: TASK, summary: "read" }, payload: JSON.stringify({ status: "completed", presentation: { input: "read x.ts" } }) }] } }));
        cursor.lastSeq += 1;
        client.send(
          JSON.stringify({
            type: "delta", epoch: "e1", sequence: cursor.lastSeq, base: cursor.lastSeq - 1, tag: "t",
            delta: { state: { approvals: [{ id: "ap-1", taskId: TASK, title: "Apply patch?", detail: "git apply", scopes: { always: true } }] } },
          }),
        );
      }
    });
  });
});

// --- drive the real client --------------------------------------------------
const client = createRuntimeClient({ url: `http://127.0.0.1:${port}`, token: "t".repeat(32) });
const events: TaskEvent[] = [];
let connected = false;
client.onEvent = (event) => events.push(event);
client.onConnection = (up) => (connected = up);

const failures: string[] = [];
function expect(condition: boolean, label: string): void {
  process.stdout.write(`${condition ? "ok  " : "FAIL"}  ${label}\n`);
  if (!condition) failures.push(label);
}
const wait = (ms: number) => delay(ms) as Promise<void>;
const waitFor = async (predicate: () => boolean, ms = 4000): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await wait(20);
  }
  return predicate();
};

const [projects, tasks, providers] = await Promise.all([
  client.listProjects(),
  client.listTasks(),
  client.listProviders(),
]);
expect(projects[0]?.id === REPO && projects[0]?.name === "site", "projects from workspace.repositories");
expect(tasks[0]?.id === TASK && tasks[0]?.status === "running" && tasks[0]?.projectId === REPO, "tasks map status + repositoryId");
expect(providers.some((p) => p.id === AGENT), "providers from workspace.agents");

client.connect();
await waitFor(() => connected);

const history = await client.getTaskHistory(TASK);
expect(history.items.some((i) => i.kind === "user" && i.text === "login is broken"), "history user message via threads scope");
expect(
  history.items.some((i) => i.kind === "tool" && i.name === "search" && i.detail === "grep login"),
  "tool history unwrapped from {events} envelope, detail from presentation.input",
);

await client.sendMessage(TASK, "please fix");
expect(
  seen.message?.id === TASK &&
    typeof seen.message?.messageId === "string" &&
    seen.message?.text === "please fix" &&
    !("turnSettings" in (seen.message ?? {})),
  "message body = {id, messageId, text}, no turnSettings",
);

await client.createTask({ projectId: REPO, providerId: AGENT, prompt: "New thing\nmore" });
const create = seen.create as { collection?: string; create?: Record<string, unknown>; changes?: unknown } | undefined;
expect(
  create?.collection === "tasks" &&
    create?.create?.status === "draft" &&
    !!create?.create?.title &&
    typeof create?.changes === "object",
  "task creation = workspace PATCH with complete draft metadata",
);

flags.rejectNextCreate = true;
let rejection = "";
await client.createTask({ projectId: REPO, providerId: AGENT, prompt: "x" }).catch((error: unknown) => {
  rejection = error instanceof Error ? error.message : String(error);
});
expect(rejection.includes("rejected"), "HTTP 200 with outcome=rejected surfaces as an error");

await client.stopTask(TASK);
expect(seen.cancel?.id === TASK && seen.cancel?.runId === RUN, "cancel carries the observed activeRunId");

// live streaming assistant text (delta applied against the bootstrapped snapshot)
expect(
  await waitFor(() =>
    events.some((e) => e.type === "item.append" && e.item.kind === "assistant" && e.item.text === "hi"),
  ),
  "assistant text from WS delta",
);

// focus → watch → activity frame, then activity-delta resolves the tool
client.focusTask(TASK);
expect(
  await waitFor(() =>
    events.some((e) => e.type === "item.append" && e.item.kind === "tool" && e.item.id === "tool:ev-2"),
  ),
  "live tool event from WS activity frame",
);
expect(
  await waitFor(() =>
    events.some(
      (e) => e.type === "item.update" && e.item.kind === "tool" && e.item.id === "tool:ev-2" && e.item.state === "ok",
    ),
  ),
  "tool resolved by activity-delta payload",
);

// approval arrives via delta.state.approvals → surfaced as a pending approval
expect(
  await waitFor(() =>
    events.some((e) => e.type === "item.append" && e.item.kind === "approval" && e.item.id === "approval:ap-1"),
  ),
  "approval surfaced from delta.state.approvals",
);

await client.answerItem(TASK, "approval:ap-1", "always");
expect(seen.approvals?.id === "ap-1" && seen.approvals?.decision === "always", "approval answer uses decision field");

// heartbeat ahead of the client's cursor must trigger a cursor-bearing resume
await wait(150);
liveRef.socket?.send(JSON.stringify({ type: "heartbeat", epoch: "e1", sequence: cursor.lastSeq + 3 }));
expect(await waitFor(() => cursor.sawResumeWithCursor), "heartbeat gap triggers resume with cursor");

client.close();
wss.close();
server.close();

if (failures.length > 0) {
  process.stdout.write(`\n${failures.length} failures\n`);
  process.exit(1);
}
process.stdout.write("\nall runtime-contract checks passed\n");
process.exit(0);
