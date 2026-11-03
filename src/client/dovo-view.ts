// View projector: turns /ws/sync content (snapshot baselines, deltas, focused
// activity) into the TUI's TaskEvent stream. Owns all per-view bookkeeping
// (streaming text, emitted prompts/tools, pending approvals); transport and
// cursors live in dovo-sync.ts, HTTP in dovo.ts.

import {
  approvalItem,
  questionItem,
  statusMap,
  toMessageItem,
  toToolItem,
} from "dovo-terminal/client/dovo-map.ts";
import type {
  ActivityDelta,
  ActivityEvent,
  MessageChange,
  SyncDelta,
  WireSnapshot,
} from "dovo-terminal/client/dovo-wire.ts";
import type { TaskEvent } from "dovo-terminal/protocol/sync.ts";
import type { SyncSink } from "dovo-terminal/protocol/sync-sink.ts";
import type { TaskSummary } from "dovo-terminal/protocol/workspace.ts";

type ActivityChange = NonNullable<ActivityDelta["changes"]>[number];
type ActivityPayloadEdit = Exclude<NonNullable<ActivityChange["payload"]>, string>;

export class ViewProjector {
  private readonly sink: SyncSink;

  /** Shared with the HTTP side: the client and the stream update one map. */
  private readonly tasks: Map<string, TaskSummary>;

  private focused: string | null = null;
  private messageText = new Map<string, { role: string; text: string }>();
  private pendingIds = new Set<string>();
  private emittedApprovals = new Set<string>();
  private emittedTools = new Set<string>();
  private activityEvents = new Map<string, ActivityEvent>();
  private questionFieldIds = new Map<string, string>();

  constructor(sink: SyncSink, tasks: Map<string, TaskSummary>) {
    this.sink = sink;
    this.tasks = tasks;
  }

  get focus(): string | null {
    return this.focused;
  }

  /** A new focus invalidates every emitted-item memo: the view restarts. */
  setFocus(taskId: string | null): void {
    if (this.focused === taskId) {
      return;
    }
    this.focused = taskId;
    this.emittedApprovals.clear();
    this.emittedTools.clear();
    this.messageText.clear();
    this.activityEvents.clear();
  }

  /** listTasks primes the pending set; deltas only need to diff against it. */
  primePending(ids: Set<string>): void {
    this.pendingIds = ids;
  }

  /** An answered prompt stops counting as pending before the next delta. */
  markResolved(taskId: string): void {
    this.pendingIds.delete(taskId);
  }

  /** Baseline snapshot: rebuild streaming text state and approvals for view. */
  applySnapshotBaseline(snapshot: WireSnapshot | undefined): void {
    if (!snapshot?.workspace) {
      return;
    }
    this.messageText.clear();
    for (const task of snapshot.workspace.tasks ?? []) {
      for (const message of task.messages ?? []) {
        this.messageText.set(message.id, { role: message.role, text: message.text ?? "" });
      }
    }
    this.emittedApprovals.clear();
    for (const approval of snapshot.approvals ?? []) {
      this.emittedApprovals.add(approval.id);
    }
    for (const question of snapshot.questions ?? []) {
      this.emittedApprovals.add(`q:${question.id}`);
      if (question.prompt.questions[0]?.id) {
        this.questionFieldIds.set(question.id, question.prompt.questions[0].id);
      }
    }
  }

  applyDelta(delta: SyncDelta, fullReplace: boolean): void {
    const state = delta.state;
    const pendingNow = this.collectPending(state);
    this.applyTaskChanges(delta, fullReplace);
    this.emitNewPrompts(state);
    this.transitionPendingState(state, pendingNow);
  }

  private collectPending(state: SyncDelta["state"]): Set<string> {
    const pendingNow = new Set<string>();
    for (const approval of state?.approvals ?? []) {
      pendingNow.add(approval.taskId);
    }
    for (const question of state?.questions ?? []) {
      pendingNow.add(question.taskId);
      const fieldId = question.prompt.questions[0]?.id;
      if (question.id && fieldId) {
        this.questionFieldIds.set(question.id, fieldId);
      }
    }
    return pendingNow;
  }

  private applyTaskChanges(delta: SyncDelta, fullReplace: boolean): void {
    for (const change of delta.workspace?.tasks?.changes ?? []) {
      this.applyTaskChange(change.id, change, fullReplace);
    }
  }

  private applyTaskChange(
    taskId: string,
    change: NonNullable<
      NonNullable<NonNullable<SyncDelta["workspace"]>["tasks"]>["changes"]
    >[number],
    fullReplace: boolean,
  ): void {
    const values = {
      ...(change.fields ?? {}),
      ...(change.fieldDelta?.values ?? {}),
    };
    const task = this.tasks.get(taskId);
    if (typeof values["activeRunId"] === "string" && task) {
      task.activeRunId = values["activeRunId"];
    }
    for (const messageChange of change.messages?.changes ?? []) {
      this.applyMessageChange(taskId, messageChange);
    }
    this.publishTaskStatus(taskId, task, values, fullReplace);
  }

  /** Status is only relayed for the focused thread; others resync on open. */
  private publishTaskStatus(
    taskId: string,
    task: TaskSummary | undefined,
    values: Record<string, unknown>,
    fullReplace: boolean,
  ): void {
    if (fullReplace || typeof values["status"] !== "string" || !task) {
      return; // selection handoffs re-fetch via getTaskHistory
    }
    if (this.focused !== taskId) {
      return;
    }
    const status = statusMap[values["status"]] ?? "unknown";
    task.status = status;
    this.emit({ type: "status", taskId, status, activeRunId: task.activeRunId });
  }

  private emitNewPrompts(state: SyncDelta["state"]): void {
    for (const approval of state?.approvals ?? []) {
      if (!this.emittedApprovals.has(approval.id)) {
        this.emittedApprovals.add(approval.id);
        this.emit({
          type: "item.append",
          taskId: approval.taskId,
          item: approvalItem(approval),
        });
      }
    }
    for (const question of state?.questions ?? []) {
      const key = `q:${question.id}`;
      if (!this.emittedApprovals.has(key)) {
        this.emittedApprovals.add(key);
        this.emit({
          type: "item.append",
          taskId: question.taskId,
          item: questionItem(question),
        });
      }
    }
  }

  /** Approval arrival/removal flips task status between running and waiting. */
  private transitionPendingState(state: SyncDelta["state"], pendingNow: Set<string>): void {
    if (!(state?.approvals || state?.questions)) {
      return;
    }
    const hadPending = this.pendingIds;
    this.pendingIds = pendingNow;
    for (const taskId of hadPending) {
      if (!pendingNow.has(taskId)) {
        this.emit({
          type: "status",
          taskId,
          status: "running",
          activeRunId: this.tasks.get(taskId)?.activeRunId,
        });
      }
    }
    for (const taskId of pendingNow) {
      this.emit({ type: "status", taskId, status: "waiting" });
    }
  }

  private applyMessageChange(taskId: string, change: MessageChange): void {
    const fields = change.fields;
    if (!fields?.id) {
      return;
    }
    const id = fields.id;
    const existing = this.messageText.get(id);
    const role = fields.role ?? existing?.role ?? "assistant";
    let text = existing?.text ?? "";
    if (fields.text !== undefined) {
      text = fields.text;
    }
    if (typeof change.text === "string") {
      text = change.text;
    } else if (change.text) {
      text += change.text.append;
    }
    this.messageText.set(id, { role, text });
    const item = toMessageItem(id, role, text, false);
    if (existing) {
      this.emit({ type: "item.update", taskId, item });
      return;
    }
    this.emit({ type: "item.append", taskId, item });
  }

  applyActivity(scope: string, events: ActivityEvent[]): void {
    if (!scope || scope !== this.focused) {
      return;
    }
    for (const event of events) {
      this.activityEvents.set(event.id, { ...this.activityEvents.get(event.id), ...event });
      this.emitToolEvent(scope, event.id);
    }
  }

  applyActivityDelta(scope: string, delta: ActivityDelta): void {
    if (!scope || scope !== this.focused) {
      return;
    }
    for (const change of delta.changes ?? []) {
      const id = change.fields?.id;
      if (!id) {
        continue;
      }
      this.activityEvents.set(id, this.mergeActivityEvent(id, change));
      this.emitToolEvent(scope, id);
    }
  }

  private mergeActivityEvent(id: string, change: ActivityChange): ActivityEvent {
    const previous = this.activityEvents.get(id) ?? { id };
    const merged: ActivityEvent = { ...previous, ...change.fields };
    const payload = change.payload;
    if (typeof payload === "string") {
      merged.payload = payload;
      return merged;
    }
    if (payload) {
      const base = previous.payload ?? "";
      const inserted = this.applyPayloadEdit(base, payload);
      merged.payload = inserted.slice(0, payload.length);
    }
    return merged;
  }

  private applyPayloadEdit(base: string, edit: ActivityPayloadEdit): string {
    const offset = Math.min(Math.max(edit.offset, 0), base.length);
    return base.slice(0, offset) + edit.insert + base.slice(offset + edit.remove);
  }

  private emitToolEvent(scope: string, id: string): void {
    const event = this.activityEvents.get(id);
    if (event?.kind !== "tool") {
      return;
    }
    const item = toToolItem(event);
    const first = !this.emittedTools.has(id);
    this.emittedTools.add(id);
    if (first) {
      this.emit({ type: "item.append", taskId: scope, item });
      return;
    }
    this.emit({ type: "item.update", taskId: scope, item });
  }

  private emit(event: TaskEvent): void {
    this.sink.publish({ type: "event", event });
  }
}
