// Upstream reachability as an explicit lifecycle, not booleans: every client
// shares this machine, so the header can tell "connecting", "reconnecting" and
// "offline" apart, and an illegal transition becomes impossible to emit.
import type { ConnectionPhase } from "dovo-terminal/protocol/sync.ts";

const ALLOWED_TRANSITIONS: Record<ConnectionPhase, readonly ConnectionPhase[]> = {
  connecting: ["online", "offline"],
  online: ["reconnecting", "offline"],
  reconnecting: ["connecting", "online", "offline"],
  // close() is terminal: a new connection means a new client.
  offline: [],
};

/** Small strict FSM shared by every RuntimeClient implementation. */
export class ConnectionStateMachine {
  private currentPhase: ConnectionPhase = "connecting";

  get phase(): ConnectionPhase {
    return this.currentPhase;
  }

  /** Returns false (and changes nothing) for an illegal transition. */
  transition(to: ConnectionPhase): boolean {
    if (!ALLOWED_TRANSITIONS[this.currentPhase].includes(to)) {
      return false;
    }
    this.currentPhase = to;
    return true;
  }
}
