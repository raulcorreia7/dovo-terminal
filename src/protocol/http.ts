// Route and channel names of the local runtime protocol - one source for the
// server implementation and every client of it. Deliberately shaped like
// Dovo's own routes; payloads are this project's validated schemas
// (protocol/workspace.ts, protocol/sync.ts).
export const ENDPOINTS = {
  health: "/health",
  projects: "/api/projects",
  providers: "/api/providers",
  tasks: "/api/tasks",
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
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}
