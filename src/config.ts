import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { guard } from "dovo-terminal/protocol/guard.ts";
import { z } from "zod";

export interface RuntimeConfig {
  url: string;
  /** absent means "discover one" (env, connection file, owner-token file) */
  token?: string | undefined;
}

// Files on disk are external input: hand-edited, half-written, stale. Both
// readers validate through zod first; loose objects keep unrelated keys intact.
const RuntimeProfileSchema = z.looseObject({ url: z.string(), token: z.string().optional() });
export type RuntimeProfile = z.infer<typeof RuntimeProfileSchema>;

const ConfigSchema = z.looseObject({
  current: z.string(),
  runtimes: z.record(z.string(), RuntimeProfileSchema),
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
    const text = readFileSync(configPath(), "utf8");
    const decoded = JSON.parse(text);
    return guard(ConfigSchema, decoded);
  } catch {
    // no file yet, or a file this version cannot read: start from defaults
    return { current: "local", runtimes: { local: { url: DEFAULT_PRODUCTION_ORIGIN } } };
  }
}

export function saveConfig(config: Config): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

/** A stored profile token, usable only if it could be a real runtime token. */
function usableSavedToken(saved: RuntimeProfile | undefined): string | undefined {
  if (typeof saved?.token !== "string") {
    return undefined;
  }
  if (saved.token.length < TOKEN_MIN_LENGTH) {
    return undefined;
  }
  return saved.token;
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
  const savedToken = usableSavedToken(saved);
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
  const dbPath = process.env["DOVO_DATABASE_PATH"];
  if (dbPath) {
    return [join(dirname(dbPath), CONNECTION_FILE)];
  }
  const dataRoot = process.env["DOVO_DATA_ROOT"];
  let dirs: string[];
  if (dataRoot) {
    dirs = [dataRoot, join(dataRoot, "desktop")];
  } else {
    dirs = [
      join(homedir(), DOVO_DATA_DIR),
      join(homedir(), DOVO_DATA_DIR, "desktop"),
      // apps/api dev mode (dev-environment.ts) uses ~/.dovo-dev + port 8789.
      join(homedir(), DOVO_DEV_DATA_DIR),
      join(appDataDir(), "@dovo", "desktop"),
      join(appDataDir(), "Dovo Studio"),
    ];
  }
  return dirs.map((dir) => join(dir, CONNECTION_FILE)).filter(existsSync);
}

function appDataDir(): string {
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support");
  }
  if (process.platform === "win32") {
    return process.env["APPDATA"] ?? join(homedir(), "AppData", "Roaming");
  }
  return process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config");
}

/** Validation identical to the runtime's own reader: origin-only address, ≥32-char token, live pid. */
function readConnection(path: string): RuntimeConfig {
  let parsed: z.infer<typeof ConnectionFileSchema>;
  try {
    const text = readFileSync(path, "utf8");
    const decoded = JSON.parse(text);
    parsed = guard(ConnectionFileSchema, decoded);
  } catch (cause) {
    throw new Error(`invalid runtime connection file: ${path}`, { cause });
  }
  const { address, token, pid } = parsed;
  // A killed runtime can leave its discovery file behind; only a live pid counts.
  try {
    process.kill(pid, 0);
  } catch (cause) {
    throw new Error(`stale runtime connection file (pid ${pid} is gone): ${path}`, { cause });
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
  if (process.env["DOVO_OWNER_TOKEN"]) {
    return process.env["DOVO_OWNER_TOKEN"];
  }
  const dbPath = process.env["DOVO_DATABASE_PATH"] ?? join(homedir(), DOVO_DATA_DIR, DATABASE_FILE);
  const candidates = [
    dirname(dbPath),
    join(homedir(), DOVO_DATA_DIR),
    join(homedir(), DOVO_DEV_DATA_DIR),
  ];
  for (const directory of candidates) {
    try {
      const token = readFileSync(join(directory, OWNER_TOKEN_FILE), "utf8").trim();
      if (token.length >= TOKEN_MIN_LENGTH) {
        return token;
      }
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

const TRAILING_SLASHES = /\/+$/u;
const FULL_ORIGIN = /^https?:\/\//u;

export function normalizeUrl(url: string): string {
  const trimmed = url.replace(TRAILING_SLASHES, "");
  if (FULL_ORIGIN.test(trimmed)) {
    return trimmed;
  }
  return `http://${trimmed}`;
}
