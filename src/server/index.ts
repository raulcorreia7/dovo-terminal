// The local runtime server: wraps any RuntimeClient (real Dovo upstream,
// demo, or a test stand-in) and re-exposes it on loopback as the documented
// REST + /ws/sync protocol. Contains no task logic - just transport glue.
//
//   client.subscribe(frame) -> SyncHub -> every /ws/sync peer
//   HTTP request            -> routes.ts -> RuntimeClient method

import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { RuntimeClient } from "dovo-terminal/client/runtime-client.ts";
import { ENDPOINTS } from "dovo-terminal/protocol/http.ts";
import { handleRequest } from "dovo-terminal/server/routes.ts";
import { SyncHub } from "dovo-terminal/server/sync-hub.ts";
import { WebSocketServer } from "ws";

export interface RuntimeServerOptions {
  client: RuntimeClient;
  /** Loopback by default; this server is not a multi-host boundary. */
  hostname?: string;
  /** 0 picks a free port - the CLI always embeds it this way. */
  port?: number;
}

export interface RunningRuntimeServer {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

// The server is a local boundary; loopback only, by default.
const DEFAULT_HOSTNAME = "127.0.0.1";

export async function startRuntimeServer(
  options: RuntimeServerOptions,
): Promise<RunningRuntimeServer> {
  const hostname = options.hostname ?? DEFAULT_HOSTNAME;
  const hub = new SyncHub();
  const sockets = new WebSocketServer({ noServer: true });

  const http = createServer((request, response) => {
    void handleRequest(options.client, request, response);
  });
  http.on("upgrade", (request, netSocket, head) => {
    const isSync = new URL(request.url ?? "/", "http://localhost").pathname === ENDPOINTS.sync;
    if (!isSync) {
      netSocket.destroy();
      return;
    }
    sockets.handleUpgrade(request, netSocket, head, (socket) => hub.attach(socket));
  });

  const unsubscribe = options.client.subscribe((frame) => hub.broadcast(frame));
  options.client.connect();

  http.listen(options.port ?? 0, hostname);
  await once(http, "listening");
  const port = (http.address() as AddressInfo).port;

  return {
    url: `http://${hostname}:${port}`,
    port,
    close: async () => {
      unsubscribe();
      hub.close();
      sockets.close();
      http.close();
      // keep-alive clients would otherwise hold the close promise open
      http.closeAllConnections();
      await once(http, "close");
      await options.client.close();
    },
  };
}
