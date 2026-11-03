// Deployment choice in one place. Everything above this line only ever sees a
// RuntimeClient: whether the loopback server hop exists is invisible here.
//
//   local    -> the backend object itself (tests, --local debugging)
//   loopback -> REST + /ws/sync through the local runtime server (default)
//
// `dovo serve` splits the same seam from the other side: it runs the server
// without the TUI and any client can connect with { via: "server", url }.

import { createRuntimeClient } from "dovo-terminal/client/loopback.ts";
import type { RuntimeClient } from "dovo-terminal/client/runtime-client.ts";
import { startRuntimeServer } from "dovo-terminal/server/index.ts";

interface RuntimeSession {
  client: RuntimeClient;
  close(): Promise<void>;
}

export type RuntimeRoute =
  | { via: "local" }
  | { via: "loopback"; hostname?: string; port?: number }
  | { via: "server"; url: string };

export async function openRuntime(
  backend: RuntimeClient | null,
  route: RuntimeRoute,
): Promise<RuntimeSession> {
  if (route.via === "server") {
    // An already-running `dovo serve`; nothing to own or close upstream.
    const client = createRuntimeClient({ url: route.url });
    return { client, close: async () => client.close() };
  }
  if (!backend) {
    throw new Error("this runtime route needs a backend");
  }
  if (route.via === "local") {
    return { client: backend, close: async () => backend.close() };
  }
  const server = await startRuntimeServer({
    client: backend,
    ...(route.hostname !== undefined && { hostname: route.hostname }),
    ...(route.port !== undefined && { port: route.port }),
  });
  const client = createRuntimeClient({ url: server.url });
  return {
    client,
    close: async () => {
      await client.close(); // server.close() also closes the backend
      await server.close();
    },
  };
}
