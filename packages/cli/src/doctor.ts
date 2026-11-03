// Is everything working? One report, used by the Machines screen and by
// `dovo doctor` (for cron). Each check says what it saw and, when it fails,
// the next thing to do; none of them changes anything.

import type { Machine } from "@dovo-terminal/client/federated.ts";
import { errorMessage } from "@dovo-terminal/protocol/errors.ts";
import type { RuntimeClient } from "@dovo-terminal/protocol/runtime-client.ts";
import type { Check } from "@dovo-terminal/tui/checks.ts";
import type { Config } from "./config.ts";
import { selectOld } from "./prune.ts";
import { type TunnelState, tunnelStates } from "./tunnel.ts";

const OLD_ARCHIVE_MS = 30 * 24 * 3_600_000;
const CARD_PATH = "/.well-known/agent-card.json";

export interface Target {
  name: string;
  client: Pick<RuntimeClient, "listProjects" | "listProviders" | "archive">;
  /** Harness ids this machine is expected to offer (config `expect`). */
  expect: readonly string[];
  tunnel?: TunnelState | undefined;
  /** Base URL of the machine's A2A agent, if it serves one. */
  a2aUrl?: string | undefined;
}

export interface Deps {
  fetchCard: (url: string) => Promise<boolean>;
  now: () => number;
}

const realDeps: Deps = {
  fetchCard: async (url) =>
    (await fetch(`${url}${CARD_PATH}`, { signal: AbortSignal.timeout(4000) })).ok,
  now: Date.now,
};

function fail(machine: string, name: string, detail: string, next: string): Check {
  return { machine, name, ok: false, detail, next };
}

function pass(machine: string, name: string, detail: string): Check {
  return { machine, name, ok: true, detail };
}

/** Whether a provider (id or label) is the harness named in `expect`. */
function offers(provider: { id: string; label: string }, harness: string): boolean {
  const wanted = harness.toLowerCase();

  return (
    provider.id.toLowerCase().includes(wanted) || provider.label.toLowerCase().includes(wanted)
  );
}

async function harnessCheck(target: Target): Promise<Check> {
  const providers = await target.client.listProviders();
  const missing = target.expect.filter(
    (harness) => !providers.some((provider) => offers(provider, harness)),
  );
  if (missing.length > 0) {
    return fail(
      target.name,
      "agents",
      `missing: ${missing.join(", ")}`,
      "install it on that machine so the runtime reports it available",
    );
  }

  return pass(target.name, "agents", `${providers.length} available`);
}

async function checkMachine(target: Target, deps: Deps): Promise<Check[]> {
  const { name } = target;
  const checks: Check[] = [];
  if (target.tunnel) {
    checks.push(
      target.tunnel === "up"
        ? pass(name, "tunnel", "up")
        : fail(
            name,
            "tunnel",
            target.tunnel,
            "check the ssh host and your key; it retries on its own",
          ),
    );
  }
  try {
    const projects = await target.client.listProjects();
    checks.push(pass(name, "runtime", `${projects.length} project(s)`));
  } catch (error) {
    return [
      ...checks,
      fail(name, "runtime", errorMessage(error), "start the runtime, or check the URL and token"),
    ];
  }
  checks.push(await harnessCheck(target));
  if (target.a2aUrl) {
    const url = target.a2aUrl;
    const up = await deps.fetchCard(url).catch(() => false);
    checks.push(
      up
        ? pass(name, "a2a", "agent card reachable")
        : fail(name, "a2a", "no agent card", "start `dovo serve --a2a` there"),
    );
  }
  const archived = (await target.client.archive?.list().catch(() => [])) ?? [];
  const old = selectOld(archived, OLD_ARCHIVE_MS, deps.now()).length;
  checks.push(
    pass(
      name,
      "cleanup",
      old === 0 ? "nothing old to prune" : `${old} archived task(s) older than 30d (dovo prune)`,
    ),
  );

  return checks;
}

/** Health of every machine, checked together. */
export async function runChecks(
  targets: readonly Target[],
  deps: Deps = realDeps,
): Promise<Check[]> {
  const perMachine = await Promise.all(targets.map((target) => checkMachine(target, deps)));

  return perMachine.flat();
}

/** Turn the machines behind a backend into things to check, from the saved profiles. */
export function targetsFor(machines: readonly Machine[], config: Config): Target[] {
  return machines.map(({ name, client }) => ({
    name,
    client,
    expect: config.expect ?? [],
    tunnel: tunnelStates.get(name)?.state,
    a2aUrl: config.runtimes[name]?.a2a,
  }));
}

/** The report as plain lines for a terminal or a log; true when everything passed. */
export function plainReport(checks: readonly Check[]): { text: string; ok: boolean } {
  const lines = checks.flatMap((check) => {
    const row = `${check.ok ? "ok  " : "FAIL"}  ${check.machine}  ${check.name}  ${check.detail}`;

    return check.ok || !check.next ? [row] : [row, `      -> ${check.next}`];
  });

  return { text: lines.join("\n"), ok: checks.every((check) => check.ok) };
}
