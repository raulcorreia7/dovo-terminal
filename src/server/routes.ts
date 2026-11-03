// Exact-match route table over the RuntimeClient interface: one entry per
// endpoint, one call each. Request validation happens inside the handler with
// the same zod schema the client uses, so nothing enters the interface
// untyped and there is no casting anywhere on this path.
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { RuntimeClient } from "../client/runtime-client.ts";
import { DovoError } from "../protocol/errors.ts";
import { ENDPOINTS } from "../protocol/http.ts";
import { UpstreamError } from "../protocol/upstream-error.ts";
import { CreateTaskInputSchema } from "../protocol/workspace.ts";

const MAX_BODY_BYTES = 64 * 1024;
const STATUS = {
    ok: 200,
    noContent: 204,
    badRequest: 400,
    notFound: 404,
    badGateway: 502,
    internalError: 500,
} as const;

const TaskIdBody = z.object({ taskId: z.string().min(1) });
const MessageBody = TaskIdBody.extend({ text: z.string().min(1) });
const LifecycleBody = TaskIdBody.extend({ action: z.enum(["archive", "restore", "delete"]) });
const AnswerBody = TaskIdBody.extend({ itemId: z.string().min(1), answer: z.string() });
const ViewBody = z.object({ taskId: z.string().min(1).nullable() });

interface Route {
    method: string;
    path: string;
    handle(
        client: RuntimeClient,
        request: IncomingMessage,
        query: URLSearchParams,
    ): Promise<unknown>;
}

const ROUTES: Route[] = [
    { method: "GET", path: ENDPOINTS.projects, handle: (c) => c.listProjects() },
    { method: "GET", path: ENDPOINTS.providers, handle: (c) => c.listProviders() },
    { method: "GET", path: ENDPOINTS.tasks, handle: (c) => c.listTasks() },
    {
        method: "GET",
        path: ENDPOINTS.taskHistory,
        handle: (c, _request, query) => c.getTaskHistory(queryParam(query, "taskId")),
    },
    {
        method: "POST",
        path: ENDPOINTS.createTask,
        handle: async (c, request) =>
            c.createTask(CreateTaskInputSchema.parse(await readJson(request))),
    },
    {
        method: "POST",
        path: ENDPOINTS.sendMessage,
        handle: async (c, request) => {
            const { taskId, text } = MessageBody.parse(await readJson(request));
            await c.sendMessage(taskId, text);
        },
    },
    {
        method: "POST",
        path: ENDPOINTS.stopTask,
        handle: async (c, request) => {
            const { taskId } = TaskIdBody.parse(await readJson(request));
            await c.stopTask(taskId);
        },
    },
    {
        method: "POST",
        path: ENDPOINTS.lifecycle,
        handle: async (c, request) => {
            const { taskId, action } = LifecycleBody.parse(await readJson(request));
            if (action === "delete") {
                await c.deleteTask(taskId);
            } else {
                await c.setTaskArchived(taskId, action === "archive");
            }
        },
    },
    {
        method: "POST",
        path: ENDPOINTS.answer,
        handle: async (c, request) => {
            const { taskId, itemId, answer } = AnswerBody.parse(await readJson(request));
            await c.answerItem(taskId, itemId, answer);
        },
    },
    {
        method: "PUT",
        path: ENDPOINTS.view,
        handle: async (c, request) => {
            const { taskId } = ViewBody.parse(await readJson(request));
            c.focusTask(taskId);
        },
    },
];

const byMethodAndPath = new Map(
    ROUTES.map((route) => [`${route.method} ${route.path}`, route] as const),
);

/** Handles one HTTP request end to end; never throws. */
export async function handleRequest(
    client: RuntimeClient,
    request: IncomingMessage,
    response: ServerResponse,
): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost"); // url parser base; request.url is absolute-form on the wire
    if (request.method === "GET" && url.pathname === ENDPOINTS.health) {
        sendJson(response, STATUS.ok, { status: "ok" });
        return;
    }
    const route = byMethodAndPath.get(`${request.method} ${url.pathname}`);
    if (!route) {
        sendJson(response, STATUS.notFound, {
            error: `no route: ${request.method} ${url.pathname}`,
        });
        return;
    }
    try {
        const result = await route.handle(client, request, url.searchParams);
        sendJson(response, result === undefined ? STATUS.noContent : STATUS.ok, result);
    } catch (error) {
        sendJson(response, statusFor(error), { error: messageOf(error) });
    }
}

/** A query-string parameter, validated like any other input. */
function queryParam(query: URLSearchParams, name: string): string {
    const value = z.string().min(1).safeParse(query.get(name));
    if (!value.success) {
        throw new DovoError(`missing ?${name}=`);
    }
    return value.data;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
        size += (chunk as Buffer).byteLength;
        if (size > MAX_BODY_BYTES) {
            throw new DovoError("request body too large");
        }
        chunks.push(chunk as Buffer);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

/**
 * Error mapping, one rule per row:
 *   upstream answered      -> pass its status through (>=400), else 502
 *   network unreachable    -> 502 (DovoError wrapping a fetch rejection)
 *   our validation failed  -> 400
 *   anything else          -> 500
 */
function statusFor(error: unknown): number {
    const upstream = upstreamOf(error);
    if (upstream) {
        return upstream.status >= STATUS.badRequest ? upstream.status : STATUS.badGateway;
    }
    if (
        error instanceof DovoError &&
        error.cause instanceof Error &&
        isNetworkFailure(error.cause)
    ) {
        return STATUS.badGateway;
    }
    if (error instanceof DovoError || error instanceof SyntaxError || error instanceof z.ZodError) {
        return STATUS.badRequest;
    }
    return STATUS.internalError;
}

function isNetworkFailure(cause: Error): boolean {
    return (
        cause instanceof TypeError || cause.name === "TypeError" || cause.name === "DOMException"
    );
}

function upstreamOf(error: unknown): UpstreamError | undefined {
    if (error instanceof UpstreamError) {
        return error;
    }
    if (error instanceof DovoError && error.cause instanceof UpstreamError) {
        return error.cause;
    }
    return undefined;
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
    if (response.headersSent) {
        return;
    }
    if (status === STATUS.noContent) {
        response.writeHead(STATUS.noContent).end();
        return;
    }
    const json = JSON.stringify(body);
    response.writeHead(status, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(json),
    });
    response.end(json);
}
