import { type Component, Container } from "@earendil-works/pi-tui";
import { assertNever } from "dovo-terminal/protocol/errors.ts";
import type { ConversationItem } from "../protocol/workspace.ts";
import {
    ApprovalItem,
    AssistantItem,
    createItemView,
    SystemItem,
    ToolItem,
    UserItem,
} from "./items.ts";

/** Transcript container keyed by item id; updates never rewrite history. */
export class TranscriptView extends Container {
    private readonly entries = new Map<string, { item: ConversationItem; view: Component }>();

    replaceAll(items: ConversationItem[]): void {
        this.clear();
        this.entries.clear();
        for (const item of items) {
            this.append(item);
        }
    }

    append(item: ConversationItem): void {
        if (this.entries.has(item.id)) {
            this.update(item);
            return;
        }
        const view = createItemView(item);
        this.entries.set(item.id, { item, view });
        this.addChild(view);
    }

    update(item: ConversationItem): void {
        const entry = this.entries.get(item.id);
        if (!entry) {
            this.append(item);
            return;
        }
        entry.item = item;
        switch (item.kind) {
            case "user":
                if (entry.view instanceof UserItem) {
                    entry.view.setText(item.text);
                }
                break;
            case "assistant":
                if (entry.view instanceof AssistantItem) {
                    entry.view.setText(item.text);
                }
                break;
            case "tool":
                if (entry.view instanceof ToolItem) {
                    entry.view.setUpdate(item.name, item.detail, item.state);
                }
                break;
            case "approval":
                if (entry.view instanceof ApprovalItem && item.answered) {
                    entry.view.resolve(item.answered);
                }
                break;
            case "system":
                if (entry.view instanceof SystemItem) {
                    entry.view.setText(item.text);
                }
                break;
            default:
                assertNever(item);
        }
        entry.view.invalidate();
    }

    viewFor(id: string): Component | undefined {
        return this.entries.get(id)?.view;
    }

    pendingApproval(): {
        item: ConversationItem & { kind: "approval" };
        view: ApprovalItem;
    } | null {
        for (const entry of this.entries.values()) {
            if (
                entry.item.kind === "approval" &&
                !entry.item.answered &&
                entry.view instanceof ApprovalItem
            ) {
                return { item: entry.item, view: entry.view };
            }
        }
        return null;
    }
}
