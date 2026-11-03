import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface RuntimeConfig {
  url: string;
  token?: string;
}

export interface Config {
  current: string;
  runtimes: Record<string, RuntimeConfig>;
}

const CONFIG_PATH = join(homedir(), ".config", "dovo-terminal", "config.json");

export function configPath(): string {
  return process.env.DOVO_TUI_CONFIG ?? CONFIG_PATH;
}

export function loadConfig(): Config {
  try {
    const raw = readFileSync(configPath(), "utf8");
    const parsed = JSON.parse(raw) as Config;
    if (parsed && typeof parsed === "object" && parsed.runtimes) return parsed;
  } catch {
    // fall through to default
  }
  return { current: "local", runtimes: { local: { url: "http://127.0.0.1:8787" } } };
}

export function saveConfig(config: Config): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
}

/** First usable runtime target: flags > saved profile > local runtime discovery. */
export function resolveRuntime(flags: {
  url?: string;
  token?: string;
  profile?: string;
}): RuntimeConfig {
  if (flags.url) {
    return { url: normalizeUrl(flags.url), token: flags.token ?? discoverOwnerToken() };
  }
  const config = loadConfig();
  const saved = config.runtimes[flags.profile ?? config.current];
  if (flags.profile && !saved) {
    throw new Error(
      `no runtime profile "${flags.profile}"; pass --url http://host:port or run: dovo add <name> <url>`,
    );
  }
  // A stored token shorter than the runtime's own minimum is junk from an old
  // test; it must not hijack discovery of a live local runtime.
  const savedToken =
    typeof saved?.token === "string" && saved.token.length >= 32 ? saved.token : undefined;
  if (savedToken && saved) {
    return { url: normalizeUrl(saved.url), token: savedToken };
  }
  // No usable profile: mirror apps/api connection discovery (connection.ts).
  const discovered = discoverLocalRuntime();
  if (discovered) {
    return { url: normalizeUrl(discovered.url), token: flags.token ?? discovered.token };
  }
  return {
    url: normalizeUrl(saved?.url ?? "http://127.0.0.1:8787"),
    token: flags.token ?? discoverOwnerToken(),
  };
}

/**
 * runtime-connection.json written by the runtime after it binds a port
 * (apps/api/src/connection.ts). Same lookup order as the desktop app:
 * $DOVO_DATABASE_PATH's dir, else $DOVO_DATA_ROOT{,/desktop}, else the
 * standard data dirs. First readable, valid file wins.
 */
function discoverLocalRuntime(): RuntimeConfig | null {
  for (const path of connectionPaths()) {
    try {
      return readConnection(path);
    } catch {
      // absent or stale candidate; try the next one
    }
  }
  return null;
}

function connectionPaths(): string[] {
  if (process.env.DOVO_DATABASE_PATH) {
    return [join(dirname(process.env.DOVO_DATABASE_PATH), "runtime-connection.json")];
  }
  const dirs = process.env.DOVO_DATA_ROOT
    ? [process.env.DOVO_DATA_ROOT, join(process.env.DOVO_DATA_ROOT, "desktop")]
    : [
        join(homedir(), ".dovo"),
        join(homedir(), ".dovo", "desktop"),
        // apps/api dev mode (dev-environment.ts) uses ~/.dovo-dev + port 8789.
        join(homedir(), ".dovo-dev"),
        join(appDataDir(), "@dovo", "desktop"),
        join(appDataDir(), "Dovo Studio"),
      ];
  return dirs.map((dir) => join(dir, "runtime-connection.json")).filter(existsSync);
}

function appDataDir(): string {
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support");
  if (process.platform === "win32") return process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
  return process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
}

/** Validation identical to the runtime's own reader: origin-only address, ≥32-char token, live pid. */
function readConnection(path: string): RuntimeConfig {
  const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  if (
    !value ||
    typeof value.address !== "string" ||
    typeof value.token !== "string" ||
    value.token.length < 32 ||
    typeof value.pid !== "number" ||
    !Number.isInteger(value.pid) ||
    value.pid < 1
  ) {
    throw new Error(`invalid runtime connection file: ${path}`);
  }
  // A killed runtime can leave its discovery file behind; only a live pid counts.
  try {
    process.kill(value.pid, 0);
  } catch {
    throw new Error(`stale runtime connection file (pid ${value.pid} is gone): ${path}`);
  }
  const url = new URL(value.address);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error(`invalid runtime address in ${path}`);
  }
  return { url: url.origin, token: value.token };
}

/**
 * Persistent owner token (apps/api/src/owner-token.ts): raw text beside the
 * database file (default ~/.dovo/runtime.sqlite). DOVO_OWNER_TOKEN wins.
 */
function discoverOwnerToken(): string | undefined {
  if (process.env.DOVO_OWNER_TOKEN) return process.env.DOVO_OWNER_TOKEN;
  const dbPath = process.env.DOVO_DATABASE_PATH ?? join(homedir(), ".dovo", "runtime.sqlite");
  const candidates = [dirname(dbPath), join(homedir(), ".dovo"), join(homedir(), ".dovo-dev")];
  for (const directory of candidates) {
    try {
      const token = readFileSync(join(directory, "owner-token"), "utf8").trim();
      if (token.length >= 32) return token;
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

export function normalizeUrl(url: string): string {
  const trimmed = url.replace(/\/+$/, "");
  return /^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`;
}
