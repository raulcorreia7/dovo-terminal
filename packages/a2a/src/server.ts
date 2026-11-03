// An A2A (Agent2Agent) endpoint in front of a RuntimeClient, built on the
// official SDK. The agent card is public, as the protocol expects; every call
// that runs work needs the bearer token, and the server listens on loopback
// unless told otherwise.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdtempSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentCard } from "@a2a-js/sdk";
import { type AgentExecutor, DefaultRequestHandler } from "@a2a-js/sdk/server";
import { agentCardHandler, jsonRpcHandler, UserBuilder } from "@a2a-js/sdk/server/express";
import type { RuntimeClient } from "@dovo-terminal/protocol/runtime-client.ts";
import express, { type NextFunction, type Request, type Response } from "express";
import { DovoExecutor, type ExecutorOptions } from "./executor.ts";
import { WorkerStore } from "./store.ts";

export interface AgentServerOptions extends ExecutorOptions {
  client: RuntimeClient;
  /** 0 picks a free port. */
  port?: number;
  /** Loopback by default: anyone who can reach this port with the token can run agents. */
  hostname?: string;
  /** Database file for task state; a throwaway file in the temp folder if absent. */
  dbPath?: string;
  /** The address callers should use, if different from the listen address (behind a proxy or mesh). */
  publicUrl?: string;
  /** Callers must send `Authorization: Bearer <token>`. A random one is made if absent. */
  token?: string;
}

export interface RunningAgentServer {
  /** Base URL; the agent card is at `<url>/.well-known/agent-card.json`. */
  readonly url: string;
  readonly token: string;
  close(): Promise<void>;
}

const CARD_PATH = "/.well-known/agent-card.json";
const RPC_PATH = "/a2a/jsonrpc";
const DEFAULT_HOSTNAME = "127.0.0.1";
const TOKEN_BYTES = 24;
/** Time for the SDK to finish writing the turns we just ended, before the store closes. */
const SETTLE_MS = 50;

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** Compare tokens without leaking where they differ. */
function tokenMatches(given: string | undefined, expected: string): boolean {
  return timingSafeEqual(digest(given ?? ""), digest(expected));
}

function requireToken(expected: string) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const [scheme, given] = (request.header("authorization") ?? "").split(" ");
    if (scheme?.toLowerCase() === "bearer" && tokenMatches(given, expected)) {
      next();
    } else {
      response.status(401).json({ error: "a bearer token is required" });
    }
  };
}

function agentCard(baseUrl: string, who: Identity): AgentCard {
  return {
    name: who.name,
    description: who.description,
    supportedInterfaces: [
      {
        url: `${baseUrl}${RPC_PATH}`,
        protocolBinding: "JSONRPC",
        tenant: "",
        protocolVersion: "1.0",
      },
    ],
    provider: undefined,
    version: "0.1.0",
    capabilities: { streaming: true, pushNotifications: false, extensions: [] },
    securitySchemes: {
      bearer: {
        scheme: {
          $case: "httpAuthSecurityScheme",
          value: {
            description: "Per-worker access token",
            scheme: "Bearer",
            bearerFormat: "opaque",
          },
        },
      },
    },
    securityRequirements: [{ schemes: { bearer: { list: [] } } }],
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [
      {
        id: who.skill.id,
        name: who.skill.name,
        description: who.skill.description,
        tags: ["coding"],
        examples: who.skill.examples,
        inputModes: ["text/plain"],
        outputModes: ["text/plain"],
        securityRequirements: [],
      },
    ],
    signatures: [],
  };
}

/** An agent's name and what it offers, as its card says. */
export interface Identity {
  name: string;
  description: string;
  skill: { id: string; name: string; description: string; examples: string[] };
}

/** What a hosted agent must do besides run turns: stop them all at shutdown. */
export interface HostedAgent extends AgentExecutor {
  stopAll(): void;
}

export interface ServeOptions {
  who: Identity;
  /** Builds the agent once its database is open. */
  executorFor: (store: WorkerStore) => HostedAgent;
  port?: number | undefined;
  hostname?: string | undefined;
  token?: string | undefined;
  dbPath?: string | undefined;
  publicUrl?: string | undefined;
}

/** Host any agent behind the token-protected A2A endpoint. */
export async function serveAgent(options: ServeOptions): Promise<RunningAgentServer> {
  const hostname = options.hostname ?? DEFAULT_HOSTNAME;
  const token = options.token ?? randomBytes(TOKEN_BYTES).toString("base64url");
  const app = express();
  // The card names its own address, known only once listening; the handler
  // and the card route share this one object, so it is filled in below.
  const card = agentCard("", options.who);
  const dbPath = options.dbPath ?? join(mkdtempSync(join(tmpdir(), "dovo-a2a-")), "a2a.db");
  const store = await WorkerStore.open(dbPath);
  const executor = options.executorFor(store);
  const handler = new DefaultRequestHandler(card, store.taskStore(), executor);
  app.use(CARD_PATH, agentCardHandler({ agentCardProvider: () => Promise.resolve(card) }));
  app.use(
    RPC_PATH,
    requireToken(token),
    jsonRpcHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication }),
  );

  const server: Server = await new Promise((resolve) => {
    const listening = app.listen(options.port ?? 0, hostname, () => resolve(listening));
  });
  const listenUrl = `http://${hostname}:${(server.address() as AddressInfo).port}`;
  Object.assign(card, agentCard(options.publicUrl ?? listenUrl, options.who));

  return {
    url: listenUrl,
    token,
    close: async () => {
      executor.stopAll();
      await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await store.close();
    },
  };
}

const DOVO_IDENTITY: Identity = {
  name: "Dovo",
  description: "Runs coding tasks on a Dovo runtime. Send a message describing the work.",
  skill: {
    id: "code",
    name: "Run a coding task",
    description:
      "Creates a task in a project and reports back when it finishes or needs an answer. Optional message metadata: projectId, providerId.",
    examples: ["Fix the failing test in the api package"],
  },
};

/** A worker: an A2A endpoint in front of one Dovo runtime. */
export function startAgentServer(options: AgentServerOptions): Promise<RunningAgentServer> {
  return serveAgent({
    ...options,
    who: DOVO_IDENTITY,
    executorFor: (store) => new DovoExecutor(options.client, store, options),
  });
}
