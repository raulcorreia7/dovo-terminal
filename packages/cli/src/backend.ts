// Choosing and opening a backend: the demo, one saved runtime, or all of them
// as one workspace. A profile with an `ssh` host is reached through a managed
// tunnel; everything above this file sees only a RuntimeClient.

import { type AgentClient, createAgentClient } from "@dovo-terminal/a2a/client.ts";
import { createDemoClient } from "@dovo-terminal/client/demo.ts";
import { createDovoClient, type RuntimeConfig } from "@dovo-terminal/client/dovo.ts";
import { createFederatedClient, type Machine } from "@dovo-terminal/client/federated.ts";
import { errorMessage } from "@dovo-terminal/protocol/errors.ts";
import type { RuntimeClient } from "@dovo-terminal/protocol/runtime-client.ts";
import { loadConfig, resolveRuntime } from "./config.ts";
import { isLoopbackUrl } from "./shell.ts";
import { freePort, startTunnel, tunnelStates } from "./tunnel.ts";

export interface BackendFlags {
  demo?: boolean | undefined;
  all?: boolean | undefined;
  url?: string | undefined;
  token?: string | undefined;
  profile?: string | undefined;
}

const DEFAULT_HTTP_PORT = 80;

/** The runtime to talk to for a profile; behind a tunnel when the profile names an ssh host. */
async function runtimeFor(
  profile: string | undefined,
  flags: BackendFlags,
): Promise<RuntimeConfig> {
  const runtime = resolveRuntime({ url: flags.url, token: flags.token, profile });
  const config = loadConfig();
  const name = profile ?? config.current;
  const ssh = config.runtimes[name]?.ssh;
  if (!ssh || flags.url) {
    return { ...runtime, local: !ssh && isLoopbackUrl(runtime.url) };
  }
  const remote = new URL(runtime.url);
  const localPort = await freePort();
  tunnelStates.set(
    name,
    startTunnel({ host: ssh, remotePort: Number(remote.port) || DEFAULT_HTTP_PORT, localPort }),
  );

  return { ...runtime, url: `http://127.0.0.1:${localPort}` };
}

/** Every saved A2A worker, connected (through its tunnel if it has one). */
export async function agentWorkers(): Promise<Record<string, AgentClient>> {
  const entries = Object.entries(loadConfig().runtimes).filter(
    ([, profile]) => profile.kind === "agent",
  );
  const workers = await Promise.all(
    entries.map(async ([name]) => {
      const runtime = await runtimeFor(name, {});
      if (!runtime.token) {
        throw new Error(
          `worker "${name}" needs its access token: dovo add ${name} <url> --agent --token <t>`,
        );
      }

      try {
        return [
          name,
          await createAgentClient({ url: runtime.url, token: runtime.token, name }),
        ] as const;
      } catch (error) {
        throw new Error(
          `worker "${name}" is not reachable at ${runtime.url}: ${errorMessage(error)}`,
          { cause: error },
        );
      }
    }),
  );

  return Object.fromEntries(workers);
}

export interface Backend {
  /** What the app talks to: one machine, or all of them merged. */
  client: RuntimeClient;
  /** The machines behind it, for health checks. */
  machines: Machine[];
}

/** The client for a saved profile: a Dovo runtime, or an A2A worker if the profile says so. */
async function clientFor(name: string, flags: BackendFlags): Promise<RuntimeClient> {
  const runtime = await runtimeFor(name, flags);
  if (loadConfig().runtimes[name]?.kind === "agent") {
    if (!runtime.token) {
      throw new Error(
        `worker "${name}" needs its access token: dovo add ${name} <url> --agent --token <t>`,
      );
    }

    return await createAgentClient({ url: runtime.url, token: runtime.token, name });
  }

  return createDovoClient(runtime);
}

/** Every saved runtime profile as one machine, so several hosts show as one workspace. */
async function allMachines(): Promise<Machine[]> {
  const names = Object.keys(loadConfig().runtimes);
  if (names.length === 0) {
    throw new Error("no saved runtimes; add one with: dovo add <name> <url> --token <t>");
  }

  return await Promise.all(
    names.map(async (name) => ({
      name,
      client: await clientFor(name, {}),
    })),
  );
}

export async function openBackend(flags: BackendFlags): Promise<Backend> {
  if (flags.demo) {
    const client = createDemoClient();

    return { client, machines: [{ name: "demo", client }] };
  }
  if (flags.all) {
    const machines = await allMachines();

    return { client: createFederatedClient(machines), machines };
  }
  const name = flags.profile ?? loadConfig().current;
  const client = await clientFor(name, flags);

  return { client, machines: [{ name, client }] };
}
