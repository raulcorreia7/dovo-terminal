import { randomUUID } from "node:crypto";
import {
    DEMO_APPROVAL,
    DEMO_PROJECTS,
    DEMO_PROVIDERS,
    DEMO_SEED_ITEMS,
    DEMO_SEED_TASK,
    planReply,
    type ReplyFrame,
} from "dovo-terminal/client/demo-script.ts";
import type { RuntimeClient } from "dovo-terminal/client/runtime-client.ts";
import { ConnectionStateMachine } from "dovo-terminal/protocol/connection-state.ts";
import { DovoError } from "dovo-terminal/protocol/errors.ts";
import type {
    ConnectionPhase,
    SyncListener,
    TaskEvent,
    Unsubscribe,
} from "dovo-terminal/protocol/sync.ts";
import { SyncSink } from "dovo-terminal/protocol/sync-sink.ts";
import type {
    AgentProvider,
    ConversationItem,
    CreateTaskInput,
    Project,
    TaskHistory,
    TaskSummary,
} from "dovo-terminal/protocol/workspace.ts";
import { TASK_TITLE_MAX_CHARS } from "dovo-terminal/protocol/workspace.ts";

const SYNC_HINT_AFTER_CREATE_MS = 50;

/** Deterministic fake runtime; the fiction itself lives in demo-script.ts. */
export class DemoClient implements RuntimeClient {
    private sink = new SyncSink();

    private readonly projects: Project[] = DEMO_PROJECTS;
    private readonly providers: AgentProvider[] = DEMO_PROVIDERS;
    private tasks = new Map<string, TaskSummary>();
    private items = new Map<string, ConversationItem[]>();
    private timers: ReturnType<typeof setTimeout>[] = [];

    constructor() {
        this.seedTask({ ...DEMO_SEED_TASK, updatedAt: Date.now() - DEMO_SEED_TASK.ageMs });
        this.items.set(DEMO_SEED_TASK.id, [...DEMO_SEED_ITEMS]);
    }

    subscribe(listener: SyncListener): Unsubscribe {
        return this.sink.subscribe(listener);
    }

    connect(): void {
        this.publishConnection("online");
    }

    focusTask(_taskId: string | null): void {
        // The demo streams the same history regardless of focus.
        void _taskId;
    }

    close(): void {
        this.publishConnection("offline");
        for (const timer of this.timers) {
            clearTimeout(timer);
        }
        this.timers = [];
        this.sink.clear();
    }

    async listProjects(): Promise<Project[]> {
        return [...this.projects];
    }

    private readonly archived = new Set<string>();

    async listTasks(): Promise<TaskSummary[]> {
        return [...this.tasks.values()]
            .filter((task) => !this.archived.has(task.id))
            .map((task) => ({ ...task }));
    }

    async listProviders(): Promise<AgentProvider[]> {
        return [...this.providers];
    }

    async getTaskHistory(taskId: string): Promise<TaskHistory> {
        const task = this.mustTask(taskId);
        return {
            items: [...(this.items.get(taskId) ?? [])],
            status: task.status,
            activeRunId: task.activeRunId,
        };
    }

    async createTask(input: CreateTaskInput): Promise<TaskSummary> {
        const id = randomUUID();
        const task = this.seedTask({
            id,
            projectId: input.projectId,
            title: (input.prompt.split("\n")[0] ?? "").slice(0, TASK_TITLE_MAX_CHARS),
            status: "running",
            provider: input.providerId,
            updatedAt: Date.now(),
        });
        task.activeRunId = randomUUID();
        this.append(id, { kind: "user", id: randomUUID(), text: input.prompt });
        this.streamAgentReply(id, input.prompt);
        // the real runtime broadcasts a sync frame shortly after create; mirror it
        this.at(SYNC_HINT_AFTER_CREATE_MS, () => this.sink.publish({ type: "sync" }));
        return { ...task };
    }

    async sendMessage(taskId: string, text: string): Promise<void> {
        const task = this.mustTask(taskId);
        task.status = "running";
        task.activeRunId = randomUUID();
        this.emit({ type: "status", taskId, status: "running", activeRunId: task.activeRunId });
        this.append(taskId, { kind: "user", id: randomUUID(), text });
        this.streamAgentReply(taskId, text);
    }

    async stopTask(taskId: string): Promise<void> {
        const task = this.mustTask(taskId);
        task.status = "idle";
        task.activeRunId = undefined;
        this.emit({ type: "status", taskId, status: "idle" });
        this.append(taskId, { kind: "system", id: randomUUID(), text: "run stopped" });
    }

    async setTaskArchived(taskId: string, archived: boolean): Promise<void> {
        this.mustTask(taskId);
        if (archived) {
            this.archived.add(taskId);
        } else {
            this.archived.delete(taskId);
        }
    }

    async deleteTask(taskId: string): Promise<void> {
        this.mustTask(taskId);
        this.tasks.delete(taskId);
        this.archived.delete(taskId);
        this.items.delete(taskId);
    }

    async answerItem(taskId: string, itemId: string, answer: string): Promise<void> {
        const items = this.items.get(taskId) ?? [];
        const item = items.find((entry) => entry.id === itemId);
        if (item?.kind !== "approval") {
            return;
        }
        item.answered = answer;
        this.emit({ type: "item.update", taskId, item: { ...item } });
        const task = this.mustTask(taskId);
        task.status = "running";
        this.emit({ type: "status", taskId, status: "running", activeRunId: task.activeRunId });
        this.streamAgentReply(taskId, answer);
    }

    // --- scripted behavior ------------------------------------------------------

    private seedTask(task: TaskSummary): TaskSummary {
        this.tasks.set(task.id, task);
        this.items.set(task.id, this.items.get(task.id) ?? []);
        return task;
    }

    private mustTask(id: string): TaskSummary {
        const task = this.tasks.get(id);
        if (!task) {
            throw new DovoError(`unknown task ${id}`);
        }
        return task;
    }

    private streamAgentReply(taskId: string, prompt: string): void {
        const toolId = randomUUID();
        const replyId = randomUUID();
        const plan = planReply(prompt);
        this.at(plan.toolStart.delay, () =>
            this.append(taskId, {
                kind: "tool",
                id: toolId,
                name: "search",
                detail: plan.toolStart.detail,
                state: "running",
            }),
        );
        this.at(plan.toolResolve.delay, () =>
            this.update(taskId, {
                kind: "tool",
                id: toolId,
                name: "search",
                detail: plan.toolResolve.detail,
                state: "ok",
            }),
        );
        for (const frame of plan.frames) {
            this.streamReplyFrame(taskId, replyId, frame);
        }
        this.scheduleApprovalTail(taskId, replyId, plan.finalText, plan.approvalDelay);
    }

    /** End the scripted turn: completed answer, an approval to interact with, waiting status. */
    private scheduleApprovalTail(
        taskId: string,
        replyId: string,
        fullText: string,
        delay: number,
    ): void {
        this.at(delay, () => {
            this.update(taskId, { kind: "assistant", id: replyId, text: fullText, done: true });
            this.append(taskId, {
                kind: "approval",
                id: randomUUID(),
                title: DEMO_APPROVAL.title,
                detail: DEMO_APPROVAL.detail,
                options: DEMO_APPROVAL.options.map((option) => ({ ...option })),
                answered: null,
            });
            const task = this.mustTask(taskId);
            task.status = "waiting";
            this.emit({ type: "status", taskId, status: "waiting" });
        });
    }

    private streamReplyFrame(taskId: string, replyId: string, frame: ReplyFrame): void {
        this.at(frame.delay, () => {
            const item: ConversationItem = {
                kind: "assistant",
                id: replyId,
                text: frame.text,
                done: false,
            };
            if (frame.first) {
                this.append(taskId, item);
            } else {
                this.update(taskId, item);
            }
        });
    }

    private connection = new ConnectionStateMachine();

    private at(ms: number, fn: () => void): void {
        // A scripted turn must not resurrect activity after close(); its timers,
        // subscriptions, and the event loop must all be finished.
        if (this.connection.phase === "offline") {
            return;
        }
        this.timers.push(setTimeout(fn, ms));
    }

    private append(taskId: string, item: ConversationItem): void {
        const list = this.items.get(taskId) ?? [];
        this.items.set(taskId, list);
        list.push(item);
        this.emit({ type: "item.append", taskId, item });
    }

    private update(taskId: string, item: ConversationItem): void {
        const items = this.items.get(taskId) ?? [];
        const index = items.findIndex((entry) => entry.id === item.id);
        if (index >= 0) {
            items[index] = item;
        }
        this.emit({ type: "item.update", taskId, item });
    }

    private emit(event: TaskEvent): void {
        this.sink.publish({ type: "event", event });
    }

    /** Sole writer of connection state: an illegal transition is never emitted. */
    private publishConnection(to: ConnectionPhase): void {
        if (!this.connection.transition(to)) {
            return;
        }
        this.sink.publish({ type: "connection", state: to });
    }
}

/** Scripted runtime, no Dovo installation involved. */
export function createDemoClient(): RuntimeClient {
    return new DemoClient();
}
