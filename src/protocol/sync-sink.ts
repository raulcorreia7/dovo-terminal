// Fan-out used by every RuntimeClient and the local server: typed frames in,
// listener callbacks out. Pure delivery; no buffering, no retry semantics.
import type { SyncFrame, SyncListener, Unsubscribe } from "dovo-terminal/protocol/sync.ts";

/** Minimal typed fan-out used by every RuntimeClient and the local server. */
export class SyncSink {
  private listeners = new Set<SyncListener>();

  subscribe(listener: SyncListener): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(frame: SyncFrame): void {
    for (const listener of this.listeners) {
      listener(frame);
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}
