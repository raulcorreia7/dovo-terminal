// Snapshot-backed reads for the real client: every list/history read is a
// GET /api/snapshot scope plus pure mapping (dovo-map.ts). Identical queries
// within one refresh are deduped; a threads-scope fetch never receives an
// overview. Task mutations and the live stream live in dovo.ts/dovo-sync.ts.

import {
    findSummaryTask,
    historyItems,
    pendingTaskIds,
    toProjects,
    toProviders,
    toTaskSummary,
    toToolItem,
} from "dovo-terminal/client/dovo-map.ts";
import type { ViewProjector } from "dovo-terminal/client/dovo-view.ts";
import {
    type ActivityEvent,
    ActivityPageSchema,
    AgentAvailabilityListSchema,
    SnapshotSchema,
    type WireSnapshot,
} from "dovo-terminal/client/dovo-wire.ts";
import { guard } from "dovo-terminal/protocol/guard.ts";
import type {
    AgentProvider,
    ConversationItem,
    Project,
    TaskHistory,
    TaskSummary,
} from "dovo-terminal/protocol/workspace.ts";

export class SnapshotReader {
    // snapshot fetch dedupe: only for IDENTICAL queries (the three list* calls
    // of one refresh)
    private readonly inflight = new Map<string, Promise<WireSnapshot>>();

    private readonly request: (path: string, init?: RequestInit) => Promise<unknown>;
    private readonly tasks: Map<string, TaskSummary>;
    private readonly projector: ViewProjector;

    constructor(
        request: (path: string, init?: RequestInit) => Promise<unknown>,
        tasks: Map<string, TaskSummary>,
        projector: ViewProjector,
    ) {
        this.request = request;
        this.tasks = tasks;
        this.projector = projector;
    }

    snapshot(query: string): Promise<WireSnapshot> {
        let pending = this.inflight.get(query);
        if (!pending) {
            pending = this.fetchSnapshot(query).finally(() => {
                this.inflight.delete(query);
            });
            this.inflight.set(query, pending);
        }
        return pending;
    }

    /** Drop cached baselines (connect/close boundaries). */
    clear(): void {
        this.inflight.clear();
    }

    private async fetchSnapshot(query: string): Promise<WireSnapshot> {
        const data = await this.request(`/api/snapshot${query}`);
        return guard(SnapshotSchema, data);
    }

    async projects(): Promise<Project[]> {
        return toProjects(await this.snapshot("?scope=overview"));
    }

    async taskList(): Promise<TaskSummary[]> {
        const snapshot = await this.snapshot("?scope=overview");
        const pending = pendingTaskIds(snapshot);
        this.projector.primePending(pending);
        // archivedAt hides a thread from normal lists; the legacy `archived`
        // boolean only means "settled" and must not hide anything (workspace.ts:986).
        const tasks = (snapshot.workspace?.tasks ?? [])
            .filter((task) => !task.archivedAt)
            .map((task) => toTaskSummary(task, pending));
        // Update the SHARED map in place: the view projector holds this reference.
        this.tasks.clear();
        for (const task of tasks) {
            this.tasks.set(task.id, task);
        }
        return tasks;
    }

    async providers(): Promise<AgentProvider[]> {
        const snapshot = await this.snapshot("?scope=overview");
        const providers = toProviders(snapshot);
        try {
            const reply = await this.request("/api/agents/availability", {
                method: "POST",
                body: "{}",
            });
            const availability = guard(AgentAvailabilityListSchema, reply);
            for (const entry of availability) {
                if (!(entry.available && entry.id.startsWith("harness:"))) {
                    continue;
                }
                const id = entry.id.slice("harness:".length);
                if (!providers.some((provider) => provider.id === id)) {
                    providers.push({ id, label: id });
                }
            }
        } catch {
            // availability probe is optional; profiles remain usable
        }
        return providers;
    }

    async history(taskId: string): Promise<TaskHistory> {
        const snapshot = await this.snapshot(`?scope=threads&task=${encodeURIComponent(taskId)}`);
        const items = historyItems(snapshot, taskId, await this.toolItems(taskId));
        const pending = pendingTaskIds(snapshot);
        let summary: TaskSummary | null = null;
        const task = findSummaryTask(snapshot, taskId);
        if (task) {
            summary = toTaskSummary(task, pending);
        }
        if (summary) {
            this.tasks.set(taskId, summary);
        }
        return {
            items,
            status: summary?.status ?? "unknown",
            activeRunId: summary?.activeRunId,
        };
    }

    /** Tool history comes from the activity log; failures degrade to none. */
    private async toolItems(taskId: string): Promise<ConversationItem[]> {
        try {
            // /api/activity returns {events:[…]} (routes.ts:1134 → activitySchema),
            // not a bare array; includeDetails stays false for the compact payloads.
            const query = JSON.stringify({ scope: taskId, query: "tool", kind: "tool", offset: 0 });
            const reply = await this.request("/api/activity", { method: "POST", body: query });
            const page = guard(ActivityPageSchema, reply);
            return (page.events ?? [])
                .filter((event: ActivityEvent) => event.kind === "tool")
                .map((event: ActivityEvent) => toToolItem(event));
        } catch {
            return [];
        }
    }
}
