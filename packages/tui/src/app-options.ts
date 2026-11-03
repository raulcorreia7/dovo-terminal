import type { Project, ServicePort } from "@dovo-terminal/protocol/workspace.ts";
import type { Terminal } from "@earendil-works/pi-tui";
import type { Check } from "./checks.ts";
import type { KeyOverrides } from "./keys.ts";
import type { ShellPlan } from "./shell-plan.ts";
import type { ThemeBook } from "./theme/palette.ts";

export interface AppOptions {
  /** Terminal to draw on (tests pass a headless one). */
  terminal?: Terminal;
  /** User-defined themes, offered beside the presets. */
  themes?: ThemeBook;
  /** A theme id, or "auto" (the default) to follow the terminal's light/dark scheme. */
  theme?: string;
  /** Called with the new setting whenever the user picks a theme. */
  onThemeChange?: (setting: string) => void;
  /** How to open a shell for a project: the command to run, or nothing if it cannot be reached. */
  shellFor?: (project: Project) => ShellPlan | undefined;
  /** Health of every machine, for the Machines screen. */
  checkMachines?: () => Promise<Check[]>;
  /** Opens a service the user picked; returns what to tell them (the URL, or why not). */
  openPort?: (port: ServicePort) => Promise<string>;
  /** Runs a shell plan in the real terminal; replaced in tests. */
  runShell?: (plan: ShellPlan) => void;
  /** Replacements for the task list's default keys, by action name. */
  keys?: KeyOverrides;
  /** Optional outside status for a project; shown on its row. Must not throw. */
  projectNote?: (project: Project) => Promise<string | undefined>;
}
