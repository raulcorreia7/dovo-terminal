/** A command to run in the user's real terminal, with the screen suspended around it. */
export interface ShellPlan {
  command: string;
  args: string[];
  /** Folder to start in for a local shell; remote shells change folder in their command. */
  cwd?: string;
}
