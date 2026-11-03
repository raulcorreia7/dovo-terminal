// Fan-out from one upstream RuntimeClient to every connected /ws/sync peer.
// Pure plumbing: no frame inspection, no retry - clients reconnect themselves.
import type { WebSocket } from "ws";
import type { SyncFrame } from "../protocol/sync.ts";

export class SyncHub {
  private sockets = new Set<WebSocket>();

  attach(socket: WebSocket): void {
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
  }

  broadcast(frame: SyncFrame): void {
    const text = JSON.stringify(frame);
    for (const socket of this.sockets) {
      if (socket.readyState === socket.OPEN) socket.send(text);
    }
  }

  close(): void {
    for (const socket of this.sockets) socket.close();
    this.sockets.clear();
  }
}
