// Which project and agent a new task runs with: what the caller asked for,
// checked against the allowlist, or the runtime's first when nothing is named.
import { DovoError } from "@dovo-terminal/protocol/errors.ts";
import type { RuntimeClient } from "@dovo-terminal/protocol/runtime-client.ts";

export interface Allowlist {
  projects?: string[] | undefined;
  providers?: string[] | undefined;
}

/** Refuse a project or agent outside the allowlist; with no allowlist, anything goes. */
export function assertAllowed(
  allow: Allowlist | undefined,
  projectId: string,
  providerId: string,
): void {
  if (allow?.projects && !allow.projects.includes(projectId)) {
    throw new DovoError(`project "${projectId}" is not allowed on this worker`);
  }
  if (allow?.providers && !allow.providers.includes(providerId)) {
    throw new DovoError(`agent "${providerId}" is not allowed on this worker`);
  }
}

/** The runtime's first project or agent, for a caller that named none. */
export async function firstChoice(
  client: Pick<RuntimeClient, "listProjects" | "listProviders">,
  what: "project" | "agent",
): Promise<string> {
  const choices = what === "project" ? await client.listProjects() : await client.listProviders();
  const [choice] = choices;
  if (!choice) {
    throw new DovoError(`the runtime has no ${what} to run this in`);
  }

  return choice.id;
}
