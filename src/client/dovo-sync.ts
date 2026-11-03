// The /ws/sync transport: ticket, socket lifecycle, cursor (epoch+sequence),
// reconnect, and frame envelope handling. What a frame MEANS is decided by
// ViewProjector (dovo-view.ts); this file only moves bytes and keeps the
// stream consistent. Connection lifecycle is emitted through the shared sink.

import type { ViewProjector } from "dovo-terminal/client/dovo-view.ts";
import {
  ActivityDeltaSchema,
  ActivityEventListSchema,
  SnapshotSchema,
  SyncDeltaSchema,
  type SyncFrame,
  SyncFrameSchema,
  type SyncInputFrame,
  SyncTicketSchema,
} from "dovo-terminal/client/dovo-wire.ts";
import { ConnectionStateMachine } from "dovo-terminal/protocol/connection-state.ts";
import { guard } from "dovo-terminal/protocol/guard.ts";
import type { ConnectionPhase } from "dovo-terminal/protocol/sync.ts";
import type { SyncSink } from "dovo-terminal/protocol/sync-sink.ts";
import { WebSocket } from "ws";

// Upstream WS reconnect: start at 1 s, cap at 10 s (Dovo rebases via snapshot
// frames, so a slow retry is safe).
const RECONNECT_INITIAL_MS = 1000;
const RECONNECT_MAX_MS = 10_000;
const HTTP_SCHEME = /^http/u;

export interface SyncChannelDeps {
  url: () => string;
  request: (path: string, init?: RequestInit) => Promise<unknown>;
  sink: SyncSink;
  projector: ViewProjector;
}

export class SyncChannel {
  private readonly deps: SyncChannelDeps;

  private socket: WebSocket | null = null;
  private connection = new ConnectionStateMachine();
  private retryMs = RECONNECT_INITIAL_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private epoch: string | null = null;
  private sequence = 0;

  constructor(deps: SyncChannelDeps) {
    this.deps = deps;
  }

  connect(): void {
    void this.openChannel();
  }

  close(): void {
    this.publishConnection("offline");
    clearTimeout(this.reconnectTimer);
    this.socket?.close();
    this.socket = null;
  }

  /** Re-watch the focused task right now, if the socket is open. */
  watchCurrent(): void {
    const task = this.deps.projector.focus;
    if (this.socket?.readyState === WebSocket.OPEN && task) {
      this.sendInput({ type: "watch", tasks: [task], scopes: [task] });
    }
  }

  private async openChannel(): Promise<void> {
    if (this.connection.phase === "offline") {
      return; // closed is terminal
    }
    this.publishConnection("connecting");
    try {
      // biome-ignore lint/security/noSecrets: a path with query flags, not a secret
      const reply = await this.deps.request("/api/sync/ticket?format=5&history=paged", {
        method: "POST",
        body: "{}",
      });
      const { ticket } = guard(SyncTicketSchema, reply);
      const wsBase = this.deps.url().replace(HTTP_SCHEME, "ws");
      const url = `${wsBase}/ws/sync?ticket=${encodeURIComponent(ticket)}`;
      const socket = new WebSocket(url);
      this.socket = socket;
      socket.addEventListener("open", () => {
        this.retryMs = RECONNECT_INITIAL_MS;
        this.publishConnection("online");
        this.sendInput({ type: "resume" });
        this.watchCurrent();
      });
      socket.addEventListener("message", (event) => {
        if (typeof event.data === "string") {
          this.handleFrame(event.data);
        }
      });
      socket.addEventListener("close", () => this.scheduleReconnect());
      socket.addEventListener("error", () => socket.close());
    } catch {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.connection.phase === "offline") {
      return; // closed is terminal
    }
    this.publishConnection("reconnecting");
    this.socket = null;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.epoch = null;
      void this.openChannel();
    }, this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, RECONNECT_MAX_MS);
  }

  private handleFrame(raw: string): void {
    let frame: SyncFrame;
    try {
      const decoded = JSON.parse(raw);
      frame = guard(SyncFrameSchema, decoded);
    } catch {
      return; // an unreadable frame is not a frame; dropping it is correct
    }
    try {
      this.applyFrame(frame);
    } catch {
      // malformed payload inside a valid envelope: drop this frame only,
      // the cursor stays put and the next heartbeat or delta recovers.
    }
  }

  private applyFrame(frame: SyncFrame): void {
    switch (frame.type) {
      case "snapshot": {
        this.epoch = String(frame["epoch"] ?? "");
        this.sequence = Number(frame["sequence"] ?? 0);
        const baseline = guard(SnapshotSchema, frame["snapshot"]);
        this.deps.projector.applySnapshotBaseline(baseline);
        break;
      }
      case "selection": {
        this.epoch = String(frame["epoch"] ?? "");
        this.sequence = Number(frame["sequence"] ?? 0);
        const selection = guard(SyncDeltaSchema, frame["delta"] ?? {});
        this.deps.projector.applyDelta(selection, true);
        break;
      }
      case "delta":
        this.takeDeltaFrame(frame);
        break;
      case "activity": {
        // a malformed batch is dropped wholesale; partial tool state is worse
        const events = guard(ActivityEventListSchema, frame["events"] ?? []);
        this.deps.projector.applyActivity(String(frame["scope"] ?? ""), events);
        break;
      }
      case "activity-delta": {
        const delta = guard(ActivityDeltaSchema, frame["delta"] ?? {});
        this.deps.projector.applyActivityDelta(String(frame["scope"] ?? ""), delta);
        break;
      }
      case "heartbeat":
        this.takeHeartbeat(frame);
        break;
      default:
        // Unknown frame type from a newer runtime: ignore it, never crash.
        return;
    }
  }

  /** Delta frame: apply in order, resume across a cursor gap, rebase on a new epoch. */
  private takeDeltaFrame(frame: Record<string, unknown>): void {
    const epoch = this.epoch;
    if (epoch === null || frame["epoch"] !== epoch) {
      // new view epoch: re-fetch a ticket for a fresh baseline
      this.publishConnection("reconnecting");
      this.socket?.close();
      return;
    }
    if (Number(frame["base"] ?? -1) !== this.sequence) {
      // cursor gap: ask the server to replay from our position (it rebases
      // with a snapshot frame when the replay window no longer covers us)
      this.sendInput({ type: "resume", epoch, sequence: this.sequence });
      return;
    }
    this.sequence = Number(frame["sequence"] ?? this.sequence);
    const delta = guard(SyncDeltaSchema, frame["delta"] ?? {});
    this.deps.projector.applyDelta(delta, false);
    this.deps.sink.publish({ type: "sync" });
  }

  /** Heartbeat: carry sequence progress; resume only when it advances past us. */
  private takeHeartbeat(frame: Record<string, unknown>): void {
    const sequence = Number(frame["sequence"] ?? this.sequence);
    const epoch = this.epoch;
    if (epoch !== null && frame["epoch"] === epoch && sequence > this.sequence) {
      // missed frames: resume replays from our cursor or rebases us
      this.sendInput({ type: "resume", epoch, sequence: this.sequence });
    } else {
      this.sequence = sequence;
    }
  }

  private sendInput(input: SyncInputFrame): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(input));
    }
  }

  /** Sole writer of connection state: an illegal transition is never emitted. */
  private publishConnection(to: ConnectionPhase): void {
    if (!this.connection.transition(to)) {
      return;
    }
    this.deps.sink.publish({ type: "connection", state: to });
  }
}
