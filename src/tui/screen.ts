// What a screen is to the app: build a layout, optionally react. Screens
// import this contract (and the App handle) - never each other's internals.
import type { Component, VStack } from "@earendil-works/pi-tui";
import type { App } from "#tui/app.ts";
import type { TaskEvent } from "#protocol/sync.ts";

export interface Screen {
  readonly id: string;
  /** Build the layout tree; called once when shown. */
  build(app: App): { root: VStack; focus?: Component };
  /** Global-ish keys before focus routing. Return true to consume. */
  handleKey?(data: string): boolean;
  onEvent?(event: TaskEvent): void;
  onTasksUpdated?(): void;
  onConnection?(connected: boolean): void;
  destroy?(): void;
}
