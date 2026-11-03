// Which web services is each project serving right now? Answered with `lsof`
// (the same on macOS and Linux) and `ps`, never by guessing. Only loopback-
// reachable listeners count, and only when the process's working folder lies
// inside a known project: that is what ties a port to a project.
import { execFile } from "node:child_process";
import { isAbsolute, relative } from "node:path";
import { promisify } from "node:util";
import type { Project, ServicePort } from "@dovo-terminal/protocol/workspace.ts";

const execFileAsync = promisify(execFile);
const TOOL_TIMEOUT_MS = 5000;

/** Runs a tool and returns stdout. Injected so tests need no real processes. */
export type RunTool = (command: string, args: string[]) => Promise<string>;

const runTool: RunTool = async (command, args) => {
  try {
    const { stdout } = await execFileAsync(command, args, { timeout: TOOL_TIMEOUT_MS });

    return stdout;
  } catch (error) {
    // lsof exits 1 when it finds nothing; its output is still the answer.
    const stdout = (error as { stdout?: unknown }).stdout;
    if (typeof stdout === "string") {
      return stdout;
    }
    throw error;
  }
};

export interface Listener {
  pid: number;
  command: string;
  port: number;
}

// Listening on every interface includes loopback, so a wildcard counts.
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "[::1]", "*", "localhost", "0.0.0.0", "[::]"]);

/** Parse `lsof -F pcn`: a `p` line starts a process, `c` names it, each `n` is a socket. */
export function parseListeners(output: string): Listener[] {
  const found: Listener[] = [];
  let pid = 0;
  let command = "";
  for (const line of output.split("\n")) {
    const value = line.slice(1);
    if (line.startsWith("p")) {
      pid = Number(value);
    } else if (line.startsWith("c")) {
      command = value;
    } else if (line.startsWith("n")) {
      const colon = value.lastIndexOf(":");
      const port = Number(value.slice(colon + 1));
      if (LOOPBACK_ADDRESSES.has(value.slice(0, colon)) && Number.isInteger(port) && pid > 0) {
        found.push({ pid, command, port });
      }
    }
  }

  return found;
}

const SS_LINE =
  /\s(?<address>\S+):(?<port>\d+)\s+\S+\s+users:\(\("(?<command>[^"]+)",pid=(?<pid>\d+)/u;

/** Parse `ss -ltnpH`, for Linux hosts without lsof: one line per listening socket. */
export function parseSs(output: string): Listener[] {
  return output.split("\n").flatMap((line) => {
    const found = SS_LINE.exec(line)?.groups;
    if (!(found && LOOPBACK_ADDRESSES.has(found["address"] ?? ""))) {
      return [];
    }

    return [
      { pid: Number(found["pid"]), command: found["command"] ?? "", port: Number(found["port"]) },
    ];
  });
}

/** The folder a process works in, from `lsof -d cwd -F n`. */
export function parseCwd(output: string): string | undefined {
  return output
    .split("\n")
    .find((line) => line.startsWith("n"))
    ?.slice(1);
}

/** The longest project path that contains the folder, if any. */
export function projectContaining(
  folder: string,
  projects: readonly Project[],
): Project | undefined {
  const inside = projects.filter((project) => {
    const rel = relative(project.path, folder);

    return isAbsolute(project.path) && !rel.startsWith("..") && !isAbsolute(rel);
  });

  return inside.sort((a, b) => b.path.length - a.path.length)[0];
}

async function describe(
  pid: number,
  run: RunTool,
  viaLsof: boolean,
): Promise<{ folder?: string; started: string }> {
  const [cwd, started] = await Promise.all([
    cwdOf(pid, run, viaLsof),
    run("ps", ["-o", "lstart=", "-p", String(pid)]).catch(() => ""),
  ]);
  const folder = parseCwd(cwd);

  return { started: started.trim(), ...(folder && { folder }) };
}

/** A process's working folder: lsof anywhere, or the /proc link on Linux when lsof is absent. */
async function cwdOf(pid: number, run: RunTool, viaLsof: boolean): Promise<string> {
  if (viaLsof) {
    return await run("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]).catch(() => "");
  }
  const link = await run("readlink", [`/proc/${pid}/cwd`]).catch(() => "");

  return link ? `n${link.trim()}` : "";
}

/** Listening sockets: from lsof if installed, else from ss (Linux). */
async function listen(run: RunTool): Promise<{ listeners: Listener[]; viaLsof: boolean }> {
  try {
    return {
      listeners: parseListeners(await run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"])),
      viaLsof: true,
    };
  } catch (error) {
    if ((error as { code?: unknown }).code !== "ENOENT") {
      throw error;
    }

    return { listeners: parseSs(await run("ss", ["-ltnpH"])), viaLsof: false };
  }
}

/** The services serving each project, one entry per listening port. */
export async function scanPorts(
  projects: readonly Project[],
  run: RunTool = runTool,
): Promise<ServicePort[]> {
  const { listeners, viaLsof } = await listen(run);
  const details = new Map<number, Awaited<ReturnType<typeof describe>>>();
  await Promise.all(
    [...new Set(listeners.map((listener) => listener.pid))].map(async (pid) => {
      details.set(pid, await describe(pid, run, viaLsof));
    }),
  );

  const services = new Map<string, ServicePort>();
  for (const listener of listeners) {
    const detail = details.get(listener.pid);
    const project = detail?.folder ? projectContaining(detail.folder, projects) : undefined;
    if (detail?.folder && project) {
      services.set(`${listener.pid}:${listener.port}`, {
        port: listener.port,
        command: listener.command,
        folder: detail.folder,
        projectId: project.id,
        pid: listener.pid,
        started: detail.started,
      });
    }
  }

  return [...services.values()].sort((a, b) => a.port - b.port);
}
