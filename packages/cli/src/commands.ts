// The housekeeping commands: health, cleanup, and remembering runtimes.

import { openBackend } from "./backend.ts";
import {
  a2aTokenFor,
  DEFAULT_PRODUCTION_ORIGIN,
  loadConfig,
  newToken,
  type RuntimeProfile,
  saveConfig,
} from "./config.ts";
import { plainReport, runChecks, targetsFor } from "./doctor.ts";
import type { Options } from "./options.ts";
import { parseAge, prune } from "./prune.ts";
import { assertSafeHost } from "./tunnel.ts";

/** `dovo doctor`: check every machine; exit non-zero when anything fails (for cron). */
export async function runDoctor(values: Options): Promise<void> {
  const { client, machines } = await openBackend(values);
  try {
    const report = plainReport(await runChecks(targetsFor(machines, loadConfig())));
    process.stdout.write(`${report.text}\n`);
    process.exitCode = report.ok ? 0 : 1;
  } finally {
    client.close();
  }
}

/** `dovo a2a-token`: show this worker's A2A token (made if none yet); `--rotate` replaces it. */
export function showA2aToken(values: Options): void {
  const config = loadConfig();
  if (values.rotate) {
    config.a2aToken = newToken();
    saveConfig(config);
  }
  process.stdout.write(`${a2aTokenFor(config, undefined)}\n`);
}

/** `dovo prune`: list archived tasks past the age; delete them only with --yes. */
export async function runPrune(values: Options): Promise<void> {
  if (!values.older) {
    throw new Error("usage: dovo prune --older <30d|12h> [--yes]");
  }
  const { client } = await openBackend(values);
  try {
    const report = await prune(client, parseAge(values.older), { apply: values.yes === true });
    for (const task of report.candidates) {
      process.stdout.write(
        `${values.yes ? "deleted" : "would delete"}  ${task.title || task.id}\n`,
      );
    }
    process.stdout.write(
      values.yes
        ? `${report.deleted} deleted, ${report.failures.length} failed\n`
        : `${report.candidates.length} archived task(s) older than ${values.older}; run again with --yes to delete\n`,
    );
    for (const failure of report.failures) {
      process.stderr.write(`failed: ${failure}\n`);
    }
  } finally {
    client.close();
  }
}

/** `dovo add`: remember a named runtime; the first one becomes current. */
export function addRuntime(values: Options, positionals: string[]): void {
  const [, name, url] = positionals;
  if (!(name && url)) {
    throw new Error("usage: dovo add <name> <url>");
  }
  const config = loadConfig();
  const profile: RuntimeProfile = { url };
  if (values.token) {
    profile.token = values.token;
  }
  if (values.agent) {
    profile.kind = "agent";
  }
  if (values.ssh) {
    assertSafeHost(values.ssh);
    profile.ssh = values.ssh;
  }
  config.runtimes[name] = profile;
  if (!config.current || config.current === "local") {
    config.current = name;
  }
  saveConfig(config);
  process.stdout.write(`saved runtime "${name}" → ${url}\n`);
}

/** `dovo token`: attach an owner token to a runtime profile. */
export function addToken(values: Options, positionals: string[]): void {
  const [, token] = positionals;
  if (!token) {
    throw new Error("usage: dovo token <token>");
  }
  const config = loadConfig();
  const name = values.profile ?? config.current;
  config.runtimes[name] = {
    ...(config.runtimes[name] ?? { url: DEFAULT_PRODUCTION_ORIGIN }),
    token,
  };
  saveConfig(config);
  process.stdout.write(`saved token for runtime "${name}"\n`);
}
