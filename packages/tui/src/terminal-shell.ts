import { spawnSync } from "node:child_process";
import type { TUI } from "@earendil-works/pi-tui";
import type { ShellPlan } from "./shell-plan.ts";

/** The default runner: attach the plan to the real terminal and wait for it to end. */
export function runInTerminal(plan: ShellPlan): void {
  spawnSync(plan.command, plan.args, {
    stdio: "inherit",
    ...(plan.cwd && { cwd: plan.cwd }),
  });
}

/** Give the terminal to a program, then take it back and redraw everything. */
export function withTerminalSuspended(tui: TUI, run: () => void): void {
  tui.stop();
  try {
    run();
  } finally {
    tui.start();
    tui.requestRender(true);
  }
}
