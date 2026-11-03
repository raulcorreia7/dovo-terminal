import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

export interface RuntimeConfig {
  url: string;
  /** absent means "discover one" (env, connection file, owner-token file) */
  token?: string | undefined;
}

// Files on disk are external input: hand-edited, half-written, stale. Both
// readers validate through zod first; loose objects keep unrelated keys intact.
const ConfigSchema = z.looseObject({
  current: z.string(),
  runtimes: z.record(z.string(), z.looseObject({ url: z.string(), token: z.string().optional() })),
});
export type Config = z.infer<typeof ConfigSchema>;

// Defaults that Dovo itself publishes (apps/api: connection.ts, owner-token.ts,
// dev-environment.ts). Keep them here, in one table, never inline.
export const DEFAULT_PRODUCTION_ORIGIN = "http://127.0.0.1:8787";
const TOKEN_MIN_LENGTH = 32; // the runtime rejects device tokens below this
const DOVO_DATA_DIR = ".dovo";
const DOVO_DEV_DATA_DIR = ".dovo-dev";
const CONNECTION_FILE = "runtime-connection.json";
const OWNER_TOKEN_FILE = "owner-token";
const DATABASE_FILE = "runtime.sqlite";

const ConnectionFileSchema = z.looseObject({
  address: z.string(),
  token: z.string().min(TOKEN_MIN_LENGTH),
  pid: z.number().int().min(1),
});

const CONFIG_PATH = join(homedir(), ".config", "dovo-terminal", "config.json");

export function configPath(): string {
  return process.env["DOVO_TUI_CONFIG"] ?? CONFIG_PATH;
}

export function loadConfig(): Config {
  try {
    const parsed = ConfigSchema.safeParse(JSON.parse(readFileSync(configPath(), "utf8")));
    if (parsed.success) return parsed.data;
  } catch {
    // fall through to default
  }
  return { current: "local", runtimes: { local: { url: DEFAULT_PRODUCTION_ORIGIN } } };
}

export function saveConfig(config: Config): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
}

/** First usable runtime target: flags > saved profile > local runtime discovery. */
export function resolveRuntime(flags: {
  url?: string | undefined;
  token?: string | undefined;
  profile?: string | undefined;
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
    typeof saved?.token === "string" && saved.token.length >= TOKEN_MIN_LENGTH ? saved.token : undefined;
  if (savedToken && saved) {
    return { url: normalizeUrl(saved.url), token: savedToken };
  }
  // No usable profile: mirror apps/api connection discovery (connection.ts).
  const discovered = discoverLocalRuntime();
  if (discovered) {
    return { url: normalizeUrl(discovered.url), token: flags.token ?? discovered.token };
  }
  return {
    url: normalizeUrl(saved?.url ?? DEFAULT_PRODUCTION_ORIGIN),
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
  if (process.env["DOVO_DATABASE_PATH"]) {
    return [join(dirname(process.env["DOVO_DATABASE_PATH"]), CONNECTION_FILE)];
  }
  const dirs = process.env["DOVO_DATA_ROOT"]
    ? [process.env["DOVO_DATA_ROOT"], join(process.env["DOVO_DATA_ROOT"], "desktop")]
    : [
        join(homedir(), DOVO_DATA_DIR),
        join(homedir(), DOVO_DATA_DIR, "desktop"),
        // apps/api dev mode (dev-environment.ts) uses ~/.dovo-dev + port 8789.
        join(homedir(), DOVO_DEV_DATA_DIR),
        join(appDataDir(), "@dovo", "desktop"),
        join(appDataDir(), "Dovo Studio"),
      ];
  return dirs.map((dir) => join(dir, CONNECTION_FILE)).filter(existsSync);
}

function appDataDir(): string {
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support");
  if (process.platform === "win32") return process.env["APPDATA"] ?? join(homedir(), "AppData", "Roaming");
  return process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config");
}

/** Validation identical to the runtime's own reader: origin-only address, ≥32-char token, live pid. */
function readConnection(path: string): RuntimeConfig {
  const parsed = ConnectionFileSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) throw new Error(`invalid runtime connection file: ${path}`);
  const { address, token, pid } = parsed.data;
  // A killed runtime can leave its discovery file behind; only a live pid counts.
  try {
    process.kill(pid, 0);
  } catch {
    throw new Error(`stale runtime connection file (pid ${pid} is gone): ${path}`);
  }
  const url = new URL(address);
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
  return { url: url.origin, token };
}

/**
 * Persistent owner token (apps/api/src/owner-token.ts): raw text beside the
 * database file (default ~/.dovo/runtime.sqlite). DOVO_OWNER_TOKEN wins.
 */
function discoverOwnerToken(): string | undefined {
  if (process.env["DOVO_OWNER_TOKEN"]) return process.env["DOVO_OWNER_TOKEN"];
  const dbPath = process.env["DOVO_DATABASE_PATH"] ?? join(homedir(), DOVO_DATA_DIR, DATABASE_FILE);
  const candidates = [dirname(dbPath), join(homedir(), DOVO_DATA_DIR), join(homedir(), DOVO_DEV_DATA_DIR)];
  for (const directory of candidates) {
    try {
      const token = readFileSync(join(directory, OWNER_TOKEN_FILE), "utf8").trim();
      if (token.length >= TOKEN_MIN_LENGTH) return token;
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
