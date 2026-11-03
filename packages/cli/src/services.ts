// Open a web service a project is running, wherever the project lives. This
// machine: a plain loopback URL. A remote machine reached over ssh: forward that
// one port through the tunnel's control socket first. The port is re-checked
// against the live list at the last moment, so a port that now belongs to
// another process is never opened or forwarded.
import { execFile, spawn } from "node:child_process";
import type { RuntimeClient } from "@dovo-terminal/protocol/runtime-client.ts";
import type { ServicePort } from "@dovo-terminal/protocol/workspace.ts";
import { assertSafeHost, controlArgs, controlDir, isListening } from "./tunnel.ts";

/** The browser opener on this platform, or nothing known. */
export function openerFor(platform: NodeJS.Platform): string | undefined {
  if (platform === "darwin") {
    return "open";
  }
  if (platform === "linux") {
    return "xdg-open";
  }

  return undefined;
}

export interface Session {
  /** The terminal is on another machine (ssh), so a browser here would open in the wrong place. */
  remote: boolean;
  /** A graphical session is available (always true on macOS). */
  display: boolean;
}

export function sessionOf(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Session {
  return {
    remote: Boolean(env["SSH_CONNECTION"] || env["SSH_TTY"]),
    display: platform !== "linux" || Boolean(env["DISPLAY"] || env["WAYLAND_DISPLAY"]),
  };
}

/** A browser on a remote terminal would open on the wrong machine: print the URL instead. */
export function canOpenBrowser(session: Session): boolean {
  return !session.remote && session.display;
}

/** Same port, same process: the service the user was shown is still the one there. */
export function sameService(a: ServicePort, b: ServicePort): boolean {
  return a.port === b.port && a.pid === b.pid && a.started === b.started;
}

/** `ssh -O forward` for exactly one port, loopback to loopback, on the existing connection. */
export function forwardArgs(host: string, port: number): string[] {
  assertSafeHost(host);

  return [
    "-O",
    "forward",
    ...controlArgs(controlDir()),
    "-L",
    `127.0.0.1:${port}:127.0.0.1:${port}`,
    "--",
    host,
  ];
}

export interface OpenContext {
  /** Where to ask for the live port list. */
  client: Pick<RuntimeClient, "ports">;
  /** The ssh host when the project lives on another machine; absent for this one. */
  ssh?: string | undefined;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Replaced in tests. */
  forward?: (args: string[]) => Promise<void>;
  listening?: (port: number) => Promise<boolean>;
  launch?: (command: string, url: string) => void;
}

const forwarded = new Set<string>();

const runForward = (args: string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile("ssh", args, { timeout: 8000 }, (error, _out, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
      } else {
        resolve();
      }
    });
  });

const launchBrowser = (command: string, url: string): void => {
  spawn(command, [url], { stdio: "ignore", detached: true }).unref();
};

/** Make sure the port is reachable here. Returns why not, or nothing when it is. */
async function ensureForwarded(
  port: ServicePort,
  context: OpenContext,
): Promise<string | undefined> {
  if (!context.ssh) {
    return undefined;
  }
  const key = `${context.ssh}:${port.port}`;
  if (forwarded.has(key)) {
    return undefined;
  }
  if (await (context.listening ?? isListening)(port.port)) {
    return `:${port.port} is already in use on this machine, so it cannot be forwarded`;
  }
  try {
    await (context.forward ?? runForward)(forwardArgs(context.ssh, port.port));
    forwarded.add(key);

    return undefined;
  } catch (error) {
    return `could not forward :${port.port}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** What to tell the user: the URL that opened, or exactly why nothing did. */
export async function openService(port: ServicePort, context: OpenContext): Promise<string> {
  if (!context.client.ports) {
    return "this machine cannot list running services";
  }
  const live = (await context.client.ports.list()).find((entry) => sameService(entry, port));
  if (!live) {
    return `:${port.port} is no longer the same service; refresh and pick again`;
  }
  const problem = await ensureForwarded(port, context);
  if (problem) {
    return problem;
  }
  const url = `http://127.0.0.1:${port.port}`;
  const platform = context.platform ?? process.platform;
  const opener = openerFor(platform);
  if (opener && canOpenBrowser(sessionOf(context.env ?? process.env, platform))) {
    (context.launch ?? launchBrowser)(opener, url);

    return `opened ${url}`;
  }

  return `open ${url} in a browser`;
}
