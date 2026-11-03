// Read-only GitHub status per project, through the `gh` CLI the user already
// has signed in: no token handling, no API client of our own. It answers one
// question for a project folder: is there a pull request for the checked-out
// branch, and are its checks passing?
import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import type { Project } from "@dovo-terminal/protocol/workspace.ts";
import { z } from "zod";

const execFileAsync = promisify(execFile);

const GH_TIMEOUT_MS = 5000;
const FAILED = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "STARTUP_FAILURE"]);
const PENDING = new Set(["PENDING", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED"]);

const PullRequestSchema = z.object({
  number: z.number(),
  state: z.string(),
  statusCheckRollup: z
    .array(
      z.looseObject({
        conclusion: z.string().nullish(),
        status: z.string().nullish(),
        state: z.string().nullish(),
      }),
    )
    .nullish(),
});
type PullRequest = z.infer<typeof PullRequestSchema>;

/** Runs `gh` in a folder and returns its stdout. Injected so tests need no GitHub. */
export type RunGh = (cwd: string, args: string[]) => Promise<string>;

const runGh: RunGh = async (cwd, args) => {
  const { stdout } = await execFileAsync("gh", args, { cwd, timeout: GH_TIMEOUT_MS });

  return stdout;
};

/** "PR #12 ✓", "PR #12 ✗", "PR #12 …" (checks running), or "PR #12 merged". */
export function summarizePullRequest(pr: PullRequest): string {
  const label = `PR #${pr.number}`;
  if (pr.state !== "OPEN") {
    return `${label} ${pr.state.toLowerCase()}`;
  }
  const outcomes = (pr.statusCheckRollup ?? []).map((check) =>
    (check.conclusion || check.status || check.state || "").toUpperCase(),
  );
  if (outcomes.some((outcome) => FAILED.has(outcome))) {
    return `${label} ✗`;
  }
  if (outcomes.some((outcome) => PENDING.has(outcome))) {
    return `${label} …`;
  }
  if (outcomes.length > 0) {
    return `${label} ✓`;
  }

  return label;
}

function isFolder(path: string): boolean {
  try {
    return isAbsolute(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * A note per project, cached for `ttlMs` so a busy list does not run `gh` on
 * every redraw. A project with no local folder, no pull request, or no `gh`
 * has no note; that is not an error.
 */
export function createGithubNotes(
  run: RunGh = runGh,
  ttlMs = 60_000,
): (project: Project) => Promise<string | undefined> {
  const cache = new Map<string, { at: number; note: string | undefined }>();

  return async (project) => {
    const hit = cache.get(project.id);
    if (hit && Date.now() - hit.at < ttlMs) {
      return hit.note;
    }
    let note: string | undefined;
    if (isFolder(project.path)) {
      try {
        const out = await run(project.path, [
          "pr",
          "view",
          "--json",
          "number,state,statusCheckRollup",
        ]);
        note = summarizePullRequest(PullRequestSchema.parse(JSON.parse(out)));
      } catch {
        note = undefined; // no PR for this branch, gh missing, or signed out
      }
    }
    cache.set(project.id, { at: Date.now(), note });

    return note;
  };
}
