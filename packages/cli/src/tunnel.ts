// A managed `ssh -L` to a machine's runtime. The system `ssh` does the work
// (keys, agent, config, known_hosts); this file only builds its arguments,
// keeps it running, and stops it. A shared control socket lets later calls
// (a shell, an extra port) reuse the same connection instantly.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

export type TunnelState = "connecting" | "up" | "down" | "stopped";

/** What a tunnel needs to know. `host` is whatever ssh accepts: `user@host` or a Host alias. */
export interface TunnelSpec {
  host: string;
  /** The runtime's port as seen from the remote machine. */
  remotePort: number;
  /** The local port the runtime appears on. */
  localPort: number;
}

// A host starting with "-" would be read by ssh as an option (-oProxyCommand=...).
const SAFE_HOST = /^[A-Za-z0-9_][A-Za-z0-9._@%:+[\]-]*$/u;

export function assertSafeHost(host: string): void {
  if (!SAFE_HOST.test(host)) {
    throw new Error(`"${host}" is not a usable ssh host (use user@host or a Host alias)`);
  }
}

/** Short, user-private place for ssh's control sockets (their path length is limited). */
export function controlDir(): string {
  return join(homedir(), ".ssh", "dovo-cm");
}

/** ssh options that share one connection per host: `%C` is ssh's short hash of the connection. */
export function controlArgs(dir: string): string[] {
  return [
    "-o",
    "ControlMaster=auto",
    "-o",
    `ControlPath=${join(dir, "%C")}`,
    "-o",
    "ControlPersist=60",
  ];
}

export function sshArgs(spec: TunnelSpec, dir: string): string[] {
  assertSafeHost(spec.host);

  return [
    "-N",
    "-T",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    "-o",
    "BatchMode=yes",
    ...controlArgs(dir),
    "-L",
    `127.0.0.1:${spec.localPort}:127.0.0.1:${spec.remotePort}`,
    "--",
    spec.host,
  ];
}

/** A free local port, chosen by the OS. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/** Does something accept connections on this local port? */
export function isListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

type Spawn = (command: string, args: string[]) => Pick<ChildProcess, "on" | "kill">;

const defaultSpawn: Spawn = (command, args) => spawn(command, args, { stdio: "ignore" });

export interface TunnelOptions {
  spawn?: Spawn;
  /** Wait before each restart, in order; the last repeats. */
  backoffMs?: number[];
  /** Tells whether the forwarded port answers; replaced in tests. */
  probe?: (port: number) => Promise<boolean>;
}

const DEFAULT_BACKOFF_MS = [1000, 2000, 5000, 15_000, 30_000];
const PROBE_EVERY_MS = 300;

export class Tunnel {
  private current: Pick<ChildProcess, "on" | "kill"> | null = null;
  private status: TunnelState = "connecting";
  private attempts = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private probeTimer: ReturnType<typeof setInterval> | undefined;
  private readonly spec: TunnelSpec;
  private readonly options: Required<TunnelOptions>;
  private readonly listeners = new Set<(state: TunnelState) => void>();

  constructor(spec: TunnelSpec, options: TunnelOptions = {}) {
    assertSafeHost(spec.host);
    this.spec = spec;
    this.options = {
      spawn: options.spawn ?? defaultSpawn,
      backoffMs: options.backoffMs ?? DEFAULT_BACKOFF_MS,
      probe: options.probe ?? isListening,
    };
  }

  get state(): TunnelState {
    return this.status;
  }

  onChange(listener: (state: TunnelState) => void): () => void {
    this.listeners.add(listener);

    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (this.status === "stopped") {
      return;
    }
    mkdirSync(controlDir(), { recursive: true, mode: 0o700 });
    this.launch();
  }

  /** Close the tunnel for good. Safe to call twice, and from an exit handler. */
  stop(): void {
    this.set("stopped");
    clearTimeout(this.timer);
    clearInterval(this.probeTimer);
    this.current?.kill();
    this.current = null;
  }

  private launch(): void {
    const child = this.options.spawn("ssh", sshArgs(this.spec, controlDir()));
    this.current = child;
    this.set("connecting");
    this.watchUntilUp();
    child.on("exit", () => this.dropped(child));
    child.on("error", () => this.dropped(child));
  }

  private watchUntilUp(): void {
    clearInterval(this.probeTimer);
    this.probeTimer = setInterval(() => {
      void this.options.probe(this.spec.localPort).then((up) => {
        if (up && this.status === "connecting") {
          this.attempts = 0;
          this.set("up");
          clearInterval(this.probeTimer);
        }
      });
    }, PROBE_EVERY_MS);
  }

  private dropped(child: Pick<ChildProcess, "on" | "kill">): void {
    if (this.status === "stopped" || child !== this.current) {
      return;
    }
    clearInterval(this.probeTimer);
    this.set("down");
    const delays = this.options.backoffMs;
    const wait = delays[Math.min(this.attempts, delays.length - 1)] ?? 0;
    this.attempts += 1;
    this.timer = setTimeout(() => this.launch(), wait);
  }

  private set(next: TunnelState): void {
    if (next === this.status) {
      return;
    }
    this.status = next;
    for (const listener of this.listeners) {
      listener(next);
    }
  }
}

/** Every tunnel this process started, stopped together on exit. */
const running = new Set<Tunnel>();
let exitHooked = false;

export function startTunnel(spec: TunnelSpec, options?: TunnelOptions): Tunnel {
  const tunnel = new Tunnel(spec, options);
  running.add(tunnel);
  if (!exitHooked) {
    exitHooked = true;
    process.once("exit", () => {
      for (const each of running) {
        each.stop();
      }
    });
  }
  tunnel.start();

  return tunnel;
}

/** Tunnel state by machine name, for the status screens. */
export const tunnelStates = new Map<string, Tunnel>();
