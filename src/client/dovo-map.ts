// Wire→model mapping for the real client: pure functions, no state, no I/O.
// Anything that talks to the network lives in dovo.ts; anything that follows
// the /ws/sync stream lives in dovo-sync.ts / dovo-view.ts.

import type {
    WireApproval,
    WireQuestion,
    WireSnapshot,
    WireTask,
    WireTaskDraft,
} from "dovo-terminal/client/dovo-wire.ts";
import { type ActivityEvent, ToolPayloadSchema } from "dovo-terminal/client/dovo-wire.ts";
import { guard } from "dovo-terminal/protocol/guard.ts";
import type {
    AgentProvider,
    ConversationItem,
    CreateTaskInput,
    Project,
    TaskStatus,
    TaskSummary,
} from "dovo-terminal/protocol/workspace.ts";
import { TASK_TITLE_MAX_CHARS } from "dovo-terminal/protocol/workspace.ts";

// Item ids the TUI round-trips to control endpoints: the prefix selects the
// endpoint, so both directions must spell it identically.
export const APPROVAL_PREFIX = "approval:";
export const QUESTION_PREFIX = "question:";

// Wire-text patterns used on every message/tool event: module constants,
// compiled once (useTopLevelRegex).
const DENY_ANSWER = /no|deny/iu;
const TOOL_ERROR_STATUS = /fail|error|denied/iu;
const TOOL_OK_STATUS = /complete|success|ok|done/iu;
const TOOL_DETAIL_MAX_CHARS = 120; // one line of tool output in the transcript

export const statusMap: Record<string, TaskStatus> = {
    draft: "idle",
    running: "running",
    review: "idle",
    done: "idle",
    failed: "error",
    cancelled: "idle",
};

function mapStatus(task: WireTask, pending: Set<string>): TaskStatus {
    if (task.id && pending.has(task.id)) {
        return "waiting";
    }
    return statusMap[task.status ?? ""] ?? "unknown";
}

export function toProjects(snapshot: WireSnapshot): Project[] {
    return (snapshot.workspace?.repositories ?? []).map((repo) => ({
        id: repo.id,
        name: repo.name,
        path: repo.path,
    }));
}

export function toProviders(snapshot: WireSnapshot): AgentProvider[] {
    return (snapshot.workspace?.agents ?? []).map((agent) => ({
        id: agent.id,
        label: `${agent.name} (${agent.provider})`,
    }));
}

export function toTaskSummary(task: WireTask, pending: Set<string>): TaskSummary {
    const timestamp = Date.parse(task.updatedAt ?? task.createdAt ?? "") || Date.now();
    return {
        id: task.id,
        projectId: task.repositoryId ?? "",
        title: task.title ?? "",
        status: mapStatus(task, pending),
        provider: task.harness?.provider ?? task.agentId ?? "",
        updatedAt: timestamp,
        activeRunId: task.activeRunId,
    };
}

export function pendingTaskIds(snapshot: WireSnapshot): Set<string> {
    const ids = new Set<string>();
    for (const approval of snapshot.approvals ?? []) {
        ids.add(approval.taskId);
    }
    for (const question of snapshot.questions ?? []) {
        ids.add(question.taskId);
    }
    return ids;
}

export function approvalItem(approval: WireApproval): ConversationItem {
    const options = [{ id: "approve", label: "Yes, allow once" }];
    if (approval.scopes?.session) {
        options.push({ id: "session", label: "Allow for session" });
    }
    if (approval.scopes?.always) {
        options.push({ id: "always", label: "Always allow" });
    }
    options.push({ id: "deny", label: "No" });
    return {
        kind: "approval",
        id: `${APPROVAL_PREFIX}${approval.id}`,
        title: approval.title,
        detail: approval.detail ?? "",
        options,
        answered: null,
    };
}

export function questionItem(question: WireQuestion): ConversationItem {
    const first = question.prompt.questions[0];
    return {
        kind: "approval",
        id: `${QUESTION_PREFIX}${question.id}`,
        title: question.prompt.title ?? first?.question ?? "Question",
        detail: first?.question ?? "",
        options: (first?.options ?? []).map((option) => ({
            id: option.value,
            label: option.label,
        })),
        answered: null,
    };
}

/** A wire message becomes a transcript item; only role and text matter. */
export function toMessageItem(
    id: string,
    role: string,
    text: string,
    done: boolean,
): ConversationItem {
    if (role === "user") {
        return { kind: "user", id, text };
    }
    return { kind: "assistant", id, text, done };
}

/**
 * The approval answer a user typed, mapped to Dovo's decision vocabulary.
 * Anything but an explicit "session"/"always" approval counts as one-shot.
 */
export function approvalChoice(answer: string): {
    allow: boolean;
    decision: "approve" | "session" | "always";
} {
    if (DENY_ANSWER.test(answer)) {
        return { allow: false, decision: "approve" };
    }
    if (answer === "session" || answer === "always") {
        return { allow: true, decision: answer };
    }
    return { allow: true, decision: "approve" };
}

/** An activity event becomes a tool transcript item; unknown payloads stay "running". */
export function toToolItem(event: ActivityEvent): ConversationItem {
    let state: "running" | "ok" | "error" = "running";
    let detail = "";
    try {
        // Compacted tool payload (activity.ts): {status, presentation:{kind,input,detail,diff}}.
        const text = String(event.payload ?? "{}");
        const decoded = JSON.parse(text);
        const payload = guard(ToolPayloadSchema, decoded);
        if (payload.status && TOOL_ERROR_STATUS.test(payload.status)) {
            state = "error";
        } else if (payload.status && TOOL_OK_STATUS.test(payload.status)) {
            state = "ok";
        }
        const line = payload.presentation?.input ?? payload.presentation?.detail ?? payload.text;
        if (typeof line === "string") {
            detail = line.split("\n")[0]?.slice(0, TOOL_DETAIL_MAX_CHARS) ?? "";
        }
    } catch {
        /* payload absent or not JSON; keep defaults */
    }
    return {
        kind: "tool",
        id: `tool:${event.id}`,
        name: event.summary ?? "tool",
        detail,
        state,
    };
}

const HARNESS_PREFIX = /^harness:/u;

/** History = transcript items + still-open prompts + tools; all pure mapping. */
export function historyItems(
    snapshot: WireSnapshot,
    taskId: string,
    toolItems: ConversationItem[],
): ConversationItem[] {
    const task = (snapshot.workspace?.tasks ?? []).find((entry) => entry.id === taskId);
    const items: ConversationItem[] = (task?.messages ?? []).map((message) =>
        toMessageItem(message.id, message.role, message.text, true),
    );
    for (const approval of snapshot.approvals ?? []) {
        if (approval.taskId === taskId) {
            items.push(approvalItem(approval));
        }
    }
    for (const question of snapshot.questions ?? []) {
        if (question.taskId === taskId) {
            items.push(questionItem(question));
        }
    }
    items.push(...toolItems);
    return items;
}

export function findSummaryTask(snapshot: WireSnapshot, taskId: string): WireTask | undefined {
    return (snapshot.workspace?.tasks ?? []).find((entry) => entry.id === taskId);
}

/** The first answer field of a pending question; "" shapes the caller's error. */
export function firstQuestionFieldId(snapshot: WireSnapshot, wireId: string): string | undefined {
    for (const question of snapshot.questions ?? []) {
        if (question.id === wireId) {
            return question.prompt.questions[0]?.id ?? "";
        }
    }
    return undefined;
}

/** The answered prompt echoed back immediately (the delta confirms later). */
export function answerEcho(itemId: string, answer: string): ConversationItem {
    return { kind: "approval", id: itemId, title: "", detail: "", options: [], answered: answer };
}

/** New-task wire draft; provider becomes agentId when it matches a profile. */
export function taskDraft(
    input: CreateTaskInput,
    providers: AgentProvider[],
    taskId: string,
    now: string,
): WireTaskDraft {
    const title = (input.prompt.split("\n")[0] ?? "").slice(0, TASK_TITLE_MAX_CHARS);
    const create: WireTaskDraft = {
        id: taskId,
        repositoryId: input.projectId,
        title,
        agentId: "",
        harness: {
            provider: input.providerId.replace(HARNESS_PREFIX, ""),
            model: "",
            reasoning: "",
            serviceTier: "",
            instructions: "",
            permission: "ask",
            endpoint: "",
        },
        execution: "main",
        status: "draft",
        createdAt: now,
        messages: [],
        files: [],
        draft: "",
        example: false,
    };
    if (providers.some((profile) => profile.id === input.providerId)) {
        create.agentId = input.providerId;
        create.harness = undefined;
    }
    return create;
}
