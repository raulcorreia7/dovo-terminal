// Route and channel names of the local runtime protocol - one source for the
// server implementation and every client of it. Deliberately shaped like
// Dovo's own routes; payloads are this project's validated schemas
// (protocol/workspace.ts, protocol/sync.ts).

export const ENDPOINTS = {
  health: "/health",
  projects: "/api/projects",
  providers: "/api/providers",
  models: "/api/models",
  ports: "/api/ports",
  devices: "/api/devices",
  invite: "/api/invite",
  deviceDecision: "/api/devices/decide",
  tasks: "/api/tasks",
  archived: "/api/tasks/archived",
  taskHistory: "/api/tasks/history",
  createTask: "/api/tasks",
  sendMessage: "/api/tasks/message",
  stopTask: "/api/tasks/cancel",
  lifecycle: "/api/tasks/lifecycle",
  answer: "/api/tasks/answer",
  view: "/api/view",
  sync: "/ws/sync",
} as const;

/** WebSocket URL for a runtime server's sync channel. */
export function syncUrl(httpUrl: string): string {
  const url = new URL(ENDPOINTS.sync, httpUrl);
  if (url.protocol === "https:") {
    url.protocol = "wss:";
  } else {
    url.protocol = "ws:";
  }
  return url.toString();
}

/** The lifecycle verb for an archive/restore toggle; one table, both clients. */
export function lifecycleAction(archived: boolean): "archive" | "restore" {
  if (archived) {
    return "archive";
  }
  return "restore";
}
