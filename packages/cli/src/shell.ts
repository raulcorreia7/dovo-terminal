// A shell in a project's folder, on the machine the project lives on. Local
// projects get the user's own $SHELL; remote ones get the system `ssh -t`
// through the same control socket the tunnel uses, so it opens instantly.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import type { Project } from "@dovo-terminal/protocol/workspace.ts";
import type { ShellPlan } from "@dovo-terminal/tui/shell-plan.ts";
import type { Config, RuntimeProfile } from "./config.ts";
import { assertSafeHost, controlArgs, controlDir } from "./tunnel.ts";

/** Single-quote text for a POSIX shell: safe for spaces, quotes, `$`, backticks, newlines. */
export function shellQuote(text: string): string {
  if (text.includes("\0")) {
    throw new Error("a path cannot contain a NUL byte");
  }

  return `'${text.replaceAll("'", "'\\''")}'`;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Does this URL point at the machine we are on? */
export function isLoopbackUrl(url: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

export interface ShellTarget {
  /** The project's folder on its own machine. */
  path: string;
  /** The ssh host for a remote machine; absent for this one. */
  ssh?: string | undefined;
}

export function shellPlan(target: ShellTarget, shell: string | undefined): ShellPlan {
  if (!target.ssh) {
    const folder = existsSync(target.path) ? target.path : homedir();

    return { command: shell || "/bin/sh", args: ["-l"], cwd: folder };
  }
  assertSafeHost(target.ssh);

  return {
    command: "ssh",
    args: [
      "-t",
      ...controlArgs(controlDir()),
      "--",
      target.ssh,
      `cd -- ${shellQuote(target.path)} && exec "\${SHELL:-/bin/sh}" -l`,
    ],
  };
}

export function profileFor(
  projectId: string,
  scope: ShellScope,
  config: Config,
): RuntimeProfile | undefined {
  return config.runtimes[machineNameOf(projectId, scope, config.current)];
}

/** Which saved profile a project's machine is: the `@name` of a federated id, else the one in use. */
function machineNameOf(projectId: string, scope: ShellScope, current: string): string {
  if (!scope.all) {
    return scope.profile ?? current;
  }

  return projectId.slice(projectId.lastIndexOf("@") + 1);
}

export interface ShellScope {
  all?: boolean | undefined;
  profile?: string | undefined;
}

/** A shell plan for a project, or nothing when its machine is remote and has no ssh host. */
export function shellForProject(
  project: Project,
  scope: ShellScope,
  config: Config,
): ShellPlan | undefined {
  const profile = profileFor(project.id, scope, config);
  const ssh = profile?.ssh;
  if (profile && !isLoopbackUrl(profile.url) && !ssh) {
    return undefined;
  }

  return shellPlan({ path: project.path, ssh }, process.env["SHELL"]);
}
